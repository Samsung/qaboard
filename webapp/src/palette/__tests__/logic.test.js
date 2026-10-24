/**
 * The command palette's matching and ranking.
 * Run with: cd webapp && npm test -- palette/__tests__/logic
 */
import {
  app_items, fuzzy_match, group_sections, highlight_parts, looks_like_sha, rank_app_items, rank_batches, rank_branches,
  rank_commits, rank_projects,
} from '../logic';

const now = Date.parse('2026-10-20T12:00:00Z');
const days_ago = n => new Date(now - n * 24 * 3600 * 1000).toISOString();
const titles = items => items.map(item => item.title);

describe('fuzzy_match', () => {
  it('finds substrings, then letters in order', () => {
    expect(fuzzy_match('k3', 'kitefin/k3/denoise').positions).toEqual([8, 9]);
    expect(fuzzy_match('k3den', 'kitefin/k3/denoise').positions).toEqual([8, 9, 11, 12, 13]);
    expect(fuzzy_match('xyz', 'kitefin/k3/denoise')).toBeNull();
  });

  it('is case insensitive, and matches every word in any order', () => {
    expect(fuzzy_match('DENOISE kite', 'kitefin/k3/denoise')).not.toBeNull();
    expect(fuzzy_match('denoise hdr', 'kitefin/k3/denoise')).toBeNull();
    expect(fuzzy_match('', 'anything')).toEqual({ score: 0, positions: [] });
  });

  it('prefers the start of words and whole names', () => {
    const score = (q, text) => fuzzy_match(q, text).score;
    expect(score('tone', 'hdr/tonemap')).toBeGreaterThan(score('tone', 'hdr/monotone'));
    expect(score('storage', 'Storage')).toBeGreaterThan(score('storage', 'Storage usage'));
    expect(score('k3', 'kitefin/k3')).toBeGreaterThan(score('k3den', 'kitefin/k3/denoise') - 100);
  });

  it("doesn't match letters scattered inside words", () => {
    expect(fuzzy_match('tnmp', 'hdr/tonemap')).toBeNull();
    expect(fuzzy_match('ktfn', 'kitefin')).toBeNull();
    // the starts of words are fine
    expect(fuzzy_match('hdtm', 'hdr/tonemap')).not.toBeNull();
  });
});

describe('rank_projects', () => {
  const projects = {
    'kitefin/k3': { my_latest_activity: days_ago(1) },
    'kitefin/k3/denoise': { my_last_view: days_ago(0.1) },
    'kitefin/k5': {},
    'hdr/tonemap': { my_latest_activity: days_ago(200) },
    'old/one': {},
  };

  it('shows the pinned ones, then the recently used, without a query', () => {
    const items = rank_projects(projects, '', { favorites: { 'old/one': true }, now });
    expect(titles(items)).toEqual(['old/one', 'kitefin/k3/denoise', 'kitefin/k3']);
    expect(items[0]).toMatchObject({ pinned: true, url: '/old/one' });
  });

  it('ranks matches, recently used first among similar ones', () => {
    expect(titles(rank_projects(projects, 'k', { now }))).toEqual(['kitefin/k3/denoise', 'kitefin/k3', 'kitefin/k5']);
    expect(titles(rank_projects(projects, 'k5', { now }))).toEqual(['kitefin/k5']);
    expect(titles(rank_projects(projects, 'deno', { now }))[0]).toBe('kitefin/k3/denoise');
    expect(titles(rank_projects(projects, 'tone', { now }))).toEqual(['hdr/tonemap']);
  });

  it('is bounded among hundreds of projects', () => {
    const many = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`group/project-${i}`, {}]));
    expect(rank_projects(many, 'project', { now })).toHaveLength(8);
    expect(rank_projects(many, '', { now })).toHaveLength(0);
  });

  it('links projects named like app pages to their commits', () => {
    expect(rank_projects({ settings: {} }, 'settings', { now })[0].url).toBe('/settings/commits');
  });
});

describe('rank_batches', () => {
  const batch = (id, label, project, branch) => ({ id, label, project, origin: 'webapp', commit: { id: 'a'.repeat(40), branch } });
  const batches = [batch(1, 'sweep', 'kitefin/k3', 'feature'), batch(2, '@alice| denoise', 'hdr/tonemap', 'master'), { ...batch(3, 'default', 'kitefin/k5', 'master'), origin: 'ci' }];

  it('keeps the latest first without a query', () => {
    expect(titles(rank_batches(batches, ''))).toEqual(['sweep', 'denoise', 'CI batch']);
  });

  it('matches their name or project', () => {
    expect(titles(rank_batches(batches, 'deno'))).toEqual(['denoise']);
    expect(titles(rank_batches(batches, 'tonemap'))).toEqual(['denoise']);
    // not their branch: many batches share one
    expect(titles(rank_batches(batches, 'feature'))).toEqual([]);
    // matches outside of the name are not highlighted
    expect(rank_batches(batches, 'tonemap')[0].positions).toEqual([]);
  });

  it('links to the batch', () => {
    expect(rank_batches(batches, 'sweep')[0].url).toBe(`/kitefin/k3/commit/${'a'.repeat(40)}?batch=sweep&batch_ref=sweep`);
  });
});

describe('branches and commits', () => {
  it("keeps the branches that match, the server's order breaking ties", () => {
    const items = rank_branches('group/repo', ['feature/denoise', 'master', 'denoise-v2'], 'denoise');
    expect(titles(items)).toEqual(['denoise-v2', 'feature/denoise']);
    expect(items[1].url).toBe('/group/repo/commits/feature/denoise');
    expect(rank_branches('group/repo', ['master'], '')).toEqual([]);
    expect(rank_branches(null, ['master'], 'mas')).toEqual([]);
  });

  it('knows hashes', () => {
    expect(looks_like_sha('abc1')).toBe(true);
    expect(looks_like_sha(' ABC123def ')).toBe(true);
    expect(looks_like_sha('abc')).toBe(false);
    expect(looks_like_sha('abcg')).toBe(false);
    expect(looks_like_sha('a'.repeat(41))).toBe(false);
  });

  it('offers commits whose hash starts with the query', () => {
    const commits = [{ id: 'abc123'.padEnd(40, '0'), message: 'Hello' }, { id: 'ffff'.padEnd(40, '0') }];
    const items = rank_commits('group/repo', commits, 'ABC1');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: 'abc12300', url: `/group/repo/commit/${commits[0].id}`, positions: [0, 1, 2, 3] });
    expect(rank_commits('group/repo', commits, 'hello')).toEqual([]);
    // a long prefix is almost surely a hash
    expect(rank_commits('group/repo', commits, 'abc1230')[0].score).toBeGreaterThan(500);
  });
});

describe('pages and actions', () => {
  const alice = { is_logged: true, is_admin: false };

  it('depend on who users are', () => {
    const keys = user => app_items({ user }).map(item => item.key);
    expect(keys(alice)).toContain('page:storage');
    expect(keys(alice)).toContain('action:sign-out');
    expect(keys(alice)).not.toContain('page:admin');
    expect(keys({ ...alice, is_admin: true })).toContain('page:admin');
    expect(keys({ is_logged: false })).not.toContain('page:storage');
    expect(keys({ is_logged: false })).toContain('action:sign-in');
  });

  it('match their title, else their description', () => {
    const items = app_items({ user: alice, docs_root: '/qa/', is_dark: true });
    expect(titles(rank_app_items(items, 'tokens'))[0]).toBe('Access tokens');
    expect(rank_app_items(items, 'tokens')[0]).toMatchObject({ url: '/settings/tokens', subtitle: 'Settings' });
    expect(titles(rank_app_items(items, 'dark'))).toEqual(['Switch to the light theme']);
    expect(titles(rank_app_items(items, 'release'))).toEqual(["What's new"]);
    // not letters scattered among the words
    expect(titles(rank_app_items(items, 'deno'))).toEqual([]);
    expect(rank_app_items(items, 'guide')[0].href).toBe('/qa/docs/user-guide/overview');
    // a few suggestions without a query
    expect(titles(rank_app_items(items, ''))).toContain('Explore projects');
    expect(titles(rank_app_items(items, ''))).not.toContain('Access tokens');
  });
});

describe('group_sections', () => {
  const item = (section, score) => ({ key: `${section}${score}`, section, title: section, score });

  it('keeps a fixed order without a query', () => {
    const sections = group_sections([item('pages', 50), item('projects', 1), item('batches', 2)], '');
    expect(sections.map(s => s.id)).toEqual(['projects', 'batches', 'pages']);
    expect(sections[1].title).toBe('Your recent batches');
  });

  it('puts the best match first', () => {
    const sections = group_sections([item('projects', 10), item('pages', 50), item('pages', 5)], 'stor');
    expect(sections.map(s => s.id)).toEqual(['pages', 'projects']);
    expect(sections[0].items).toHaveLength(2);
  });
});

it('highlights the matched characters', () => {
  expect(highlight_parts('tonemap', [0, 1, 4])).toEqual([
    { text: 'to', match: true }, { text: 'ne', match: false }, { text: 'm', match: true }, { text: 'ap', match: false },
  ]);
});
