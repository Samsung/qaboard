// Admin → Settings without React: what the server describes (backend/settings.py describe()), searched and filtered.

// Servers that predate `type` only give values: we guess from them
const infer_type = value => typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'int' : Array.isArray(value) ? 'list' : typeof value === 'string' ? 'str' : null;
export const settingType = setting => setting.type ?? infer_type(setting.value ?? setting.default);

export const isEnvironmentOnly = setting => setting.kind === 'environment';
export const hasSecrets = setting => !!setting.secret || !!setting.fields?.some(field => field.secret);
export const isEmpty = value => value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);

// What needs an admin: an invalid variable, a secret that can't be decrypted, a value saved here that the environment ignores
export const needsAttention = setting => !isEnvironmentOnly(setting) && (
  !!setting.error
  || !!setting.layers?.env?.error
  || !!setting.layers?.database?.error
  || (!!setting.shadowed && !setting.env_matches_database)
);

export const filters = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'changed', label: 'Changed', description: 'Saved here, not at their default', test: s => !isEnvironmentOnly(s) && s.source === 'database' },
  { id: 'env', label: 'From the environment', description: "Set in the server's environment: read-only here", test: s => s.source === 'env' && (!isEnvironmentOnly(s) || s.is_set) },
  { id: 'secrets', label: 'Secrets', description: 'Encrypted here, never shown again', test: s => !isEnvironmentOnly(s) && hasSecrets(s) },
  { id: 'attention', label: 'Needs attention', description: 'Invalid, undecryptable or overridden values', test: needsAttention, intent: 'danger' },
];
export const filterById = Object.fromEntries(filters.map(filter => [filter.id, filter]));

const normalize = text => String(text ?? '').toLowerCase();

// Every word must be found in the setting's label, key, variable, description, group, or its choices
export const searchText = (setting, group) => normalize([
  setting.label, setting.key, setting.env, setting.description, setting.default_text, setting.why,
  group?.title, ...(setting.choices ?? []), ...(setting.fields ?? []).map(field => field.label),
].filter(Boolean).join(' '));

export const matchesSearch = (setting, query, group) => {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = searchText(setting, group);
  return words.every(word => text.includes(word.replace(/^\$/, '')));
};

// The groups with their visible settings and environment variables, in the server's order.
// Settings of groups the server doesn't list (older servers) go in "Other".
export function organize({ settings = [], server = [], groups = [] }, { query = '', filter = 'all' } = {}) {
  const known = groups.length ? groups : [];
  const by_id = Object.fromEntries(known.map(group => [group.id, group]));
  const other = { id: 'other', title: 'Other', icon: 'cog', description: null };
  const test = filterById[filter]?.test ?? filterById.all.test;
  const sections = [...known, other].map(group => ({ ...group, settings: [], variables: [] }));
  const section_of = Object.fromEntries(sections.map(section => [section.id, section]));
  const counts = Object.fromEntries(filters.map(f => [f.id, 0]));
  for (const setting of settings) {
    const group = by_id[setting.group] ?? other;
    if (!matchesSearch(setting, query, group)) continue;
    for (const f of filters)
      if (f.test(setting)) counts[f.id] += 1;
    if (test(setting)) section_of[group.id].settings.push(setting);
  }
  for (const variable of server) {
    const group = by_id[variable.group] ?? other;
    if (!matchesSearch(variable, query, group)) continue;
    // the filters are about what admins can change: the variables only show with "all" and "from the environment"
    if ((filter === 'all' || (filter === 'env' && test(variable))))
      section_of[group.id].variables.push(variable);
  }
  return {
    sections: sections.filter(section => section.settings.length || section.variables.length),
    counts,
    total: settings.length,
  };
}


// Values as text, e.g. in the provenance popover
export const unit_labels = { days: ['day', 'days'], minutes: ['minute', 'minutes'], seconds: ['second', 'seconds'], GB: ['GB', 'GB'] };
export const withUnit = (value, unit) => {
  if (!unit || typeof value !== 'number') return null;
  const [one, many] = unit_labels[unit] ?? [unit, unit];
  return `${value} ${value === 1 ? one : many}`;
};

// The settings' URL: /admin/settings?q=&filter=&setting=
export const readSettingsUrl = search => {
  const params = new URLSearchParams(search);
  return {
    query: params.get('q') ?? '',
    filter: filterById[params.get('filter')] ? params.get('filter') : 'all',
    setting: params.get('setting'),
    group: params.get('group'),
  };
};

export const settingsUrl = ({ query, filter, setting, group } = {}) => {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (filter && filter !== 'all') params.set('filter', filter);
  if (setting) params.set('setting', setting);
  if (group) params.set('group', group);
  const text = params.toString();
  return `/admin/settings${text ? `?${text}` : ''}`;
};

// The record's title in lists: its key field (e.g. the hostname), else its first text
export const recordTitle = (setting, record) => {
  const key = setting.record_key;
  if (key && record[key]) return String(record[key]);
  const field = setting.fields?.find(f => !f.secret && typeof record[f.name] === 'string' && record[f.name]);
  return field ? record[field.name] : 'New entry';
};

// A new record with the fields' defaults
export const emptyRecord = setting => Object.fromEntries((setting.fields ?? []).map(field => [field.name, field.default ?? (field.type === 'bool' ? false : field.type === 'list' ? [] : '')]));

// What's sent for a record: secret fields are `true` to keep the stored secret, a text to replace it, null to clear it
export const recordForServer = (setting, record) => {
  const out = record.id && !String(record.id).startsWith('env-') ? { id: record.id } : {};
  for (const field of setting.fields ?? []) {
    const value = record[field.name];
    if (field.secret)
      out[field.name] = typeof value === 'string' && value !== '' ? value : value === true ? true : null;
    else if (field.type === 'list')
      out[field.name] = Array.isArray(value) ? value : String(value ?? '').split(',').map(v => v.trim()).filter(Boolean);
    else if (field.type === 'bool')
      out[field.name] = !!value;
    else
      out[field.name] = typeof value === 'string' ? value.trim() || null : value ?? null;
  }
  return out;
};

// Required fields that are empty => {field: message}
export const recordErrors = (setting, record, { is_new }) => {
  const errors = {};
  for (const field of setting.fields ?? []) {
    if (!field.required) continue;
    const value = record[field.name];
    const kept_secret = field.secret && value === true && !is_new;
    if (!kept_secret && isEmpty(typeof value === 'string' ? value.trim() : value === true ? null : value))
      errors[field.name] = `${field.label} is required.`;
  }
  return errors;
};
