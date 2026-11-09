// Admin → Settings without React: search, filters, records sent to the server
import { organize, matchesSearch, needsAttention, recordForServer, recordErrors, readSettingsUrl, settingsUrl, withUnit } from '../model';

const groups = [{ id: 'jenkins', title: 'Jenkins' }, { id: 'email', title: 'Email' }];
const settings = [
  { key: 'jenkins.servers', label: 'Jenkins servers', group: 'jenkins', env: 'JENKINS_AUTH', source: 'database', type: 'records', fields: [{ name: 'token', label: 'API token', secret: true }] },
  { key: 'jenkins.build_token', label: 'Remote build token', group: 'jenkins', secret: true, source: 'default' },
  { key: 'email.smtp_host', label: 'SMTP server', group: 'email', env: 'QABOARD_SMTP_HOST', source: 'env', description: 'The SMTP server QA-Board sends emails with.' },
  { key: 'email.smtp_port', label: 'SMTP port', group: 'email', source: 'default', layers: { env: { error: '$QABOARD_SMTP_PORT=x: expected a number' }, database: {} } },
  { key: 'old.setting', label: 'Old', group: 'gone', source: 'default' },
];
const server = [{ key: 'QABOARD_URL', kind: 'environment', label: 'Public URL', group: 'email', source: 'env', is_set: true }];

describe('organize', () => {
  it('groups in the server order, unknown groups last', () => {
    const { sections, counts } = organize({ settings, server, groups });
    expect(sections.map(s => s.id)).toEqual(['jenkins', 'email', 'other']);
    expect(sections[1].variables.map(v => v.key)).toEqual(['QABOARD_URL']);
    expect(counts).toEqual({ all: 5, changed: 1, env: 1, secrets: 2, attention: 1 });
  });

  it('filters and searches, with counts of what the search finds', () => {
    const { sections, counts } = organize({ settings, server, groups }, { query: 'smtp', filter: 'env' });
    expect(sections.map(s => s.settings.map(x => x.key))).toEqual([['email.smtp_host']]);
    expect(counts.all).toBe(2);
    // the variables only show with "all" and "from the environment"
    expect(organize({ settings, server, groups }, { filter: 'secrets' }).sections.every(s => !s.variables.length)).toBe(true);
  });

  it('finds variables, field names, group titles, every word', () => {
    expect(matchesSearch(settings[0], '$JENKINS_AUTH')).toBe(true);
    expect(matchesSearch(settings[0], 'api token')).toBe(true);
    expect(matchesSearch(settings[2], 'email sends', groups[1])).toBe(true);
    expect(matchesSearch(settings[2], 'email ldap', groups[1])).toBe(false);
  });

  it('says what needs attention', () => {
    expect(needsAttention(settings[3])).toBe(true);
    expect(needsAttention({ shadowed: true, env_matches_database: true })).toBe(false);
    expect(needsAttention({ shadowed: true, env_matches_database: false })).toBe(true);
  });
});

describe('records', () => {
  const setting = { fields: [
    { name: 'hostname', label: 'Hostname', required: true },
    { name: 'token', label: 'Token', secret: true, required: true },
    { name: 'crumb', label: 'Crumb', secret: true },
    { name: 'hostnames', label: 'Other hostnames', type: 'list' },
    { name: 'http', label: 'HTTP', type: 'bool' },
  ] };

  it('keep their stored secrets with `true`, and clear them with null', () => {
    expect(recordForServer(setting, { id: 'a', hostname: ' j ', token: true, crumb: '', hostnames: 'x, y,', http: 0 }))
      .toEqual({ id: 'a', hostname: 'j', token: true, crumb: null, hostnames: ['x', 'y'], http: false });
    // the environment's records have no id in the database
    expect(recordForServer(setting, { id: 'env-0', hostname: 'j', token: 'new' }).id).toBeUndefined();
  });

  it('need their required fields, except kept secrets', () => {
    expect(recordErrors(setting, { hostname: '', token: '' }, { is_new: true })).toEqual({ hostname: 'Hostname is required.', token: 'Token is required.' });
    expect(recordErrors(setting, { hostname: 'j', token: true }, { is_new: false })).toEqual({});
  });
});

it('keeps the search and the filter in the URL', () => {
  expect(settingsUrl({ query: 'smtp', filter: 'changed' })).toBe('/admin/settings?q=smtp&filter=changed');
  expect(readSettingsUrl('?q=smtp&filter=nope&setting=email.from')).toEqual({ query: 'smtp', filter: 'all', setting: 'email.from', group: null });
  expect(withUnit(1, 'days')).toBe('1 day');
  expect(withUnit(20, 'GB')).toBe('20 GB');
});
