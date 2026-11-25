// The audit log's filters, in the URL of the pages that list events (Admin → Audit, a project's history):
// ?action=&category=&actor=&target=type:id&since=&until= (local days as YYYY-MM-DD, `until` includes its day)

export const filter_names = ['action', 'category', 'actor', 'target', 'since', 'until'];

// "user:12" => {target_type: "user", target_id: "12"}, "token" => {target_type: "token"}
export const parseTarget = text => {
  const [target_type = '', ...id] = (text ?? '').trim().split(':');
  return { target_type: target_type.trim(), target_id: id.join(':').trim() };
};
export const formatTarget = ({ target_type, target_id }) => target_type ? `${target_type}${target_id ? `:${target_id}` : ''}` : '';

export const readFilters = search => {
  const params = new URLSearchParams(search);
  return Object.fromEntries(filter_names.map(name => [name, params.get(name) ?? '']));
};

// The page's query string with these filters, keeping its other parameters
export const filtersSearch = (search, filters) => {
  const params = new URLSearchParams(search);
  for (const name of filter_names) {
    if (filters[name]) params.set(name, filters[name]);
    else params.delete(name);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
};

export const is_filtered = filters => filter_names.some(name => !!filters[name]);

// Days are the user's: "From 2026-11-21" starts at their midnight, not UTC's. `until` includes its day.
const is_day = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '');
export const dayStart = day => is_day(day) ? new Date(`${day}T00:00:00`).toISOString() : day;
export const dayEnd = day => is_day(day) ? new Date(`${day}T23:59:59.999`).toISOString() : day;

// What the API takes, without the empty filters (they're also the queries' keys)
export const filterParams = ({ target, ...filters }) => {
  const params = { ...Object.fromEntries(filter_names.filter(name => name !== 'target').map(name => [name, filters[name]])), ...parseTarget(target) };
  if (params.since) params.since = dayStart(params.since);
  if (params.until) params.until = dayEnd(params.until);
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value));
};
