/**
 * Explore's tree: projects under their closest ancestor project, groups for shared prefixes, quiet projects.
 * Run with: cd webapp && npm test -- explore
 */
import { build_tree, count_projects, filter_projects, is_quiet, last_activity, path_segments, quiet_after_days } from '../tree';
import { claimView, view_throttle_ms } from '../views';

const now = Date.UTC(2026, 9, 24);
const days_ago = n => new Date(now - n * 24 * 3600 * 1000).toISOString();

// what /api/v1/projects says, by default: someone used it yesterday
const project = (fields = {}) => ({
  data: { qatools_config: { project: { name: 'x' } } },
  latest_commit_datetime: days_ago(1),
  latest_human_activity: days_ago(1),
  views_90d: 0,
  my_last_view: null,
  activity: null,
  ...fields,
});
const quiet = (fields = {}) => project({ latest_human_activity: null, latest_output_datetime: days_ago(1), ...fields });

const ids = nodes => nodes.map(n => n.id);

describe('is_quiet', () => {
  it('only the CI ran it in 90 days, whoever viewed it', () => {
    expect(is_quiet(project(), { now })).toBe(false);
    expect(is_quiet(quiet(), { now })).toBe(true);
    expect(is_quiet(quiet({ latest_human_activity: days_ago(quiet_after_days + 1) }), { now })).toBe(true);
    expect(is_quiet(quiet({ latest_human_activity: days_ago(quiet_after_days - 1) }), { now })).toBe(false);
    expect(is_quiet(quiet({ views_90d: 1 }), { now })).toBe(true);
    expect(is_quiet(quiet({ my_last_view: days_ago(3) }), { now })).toBe(true);
  });

  it('never for pinned projects', () => {
    expect(is_quiet(quiet(), { now, pinned: true })).toBe(false);
  });

  it("doesn't guess with servers that don't say", () => {
    expect(is_quiet({ data: {}, latest_commit_datetime: days_ago(400) }, { now })).toBe(false);
  });

  it('reads dates without timezones as UTC', () => {
    const date = new Date(now - (quiet_after_days - 1) * 24 * 3600 * 1000).toISOString().replace('Z', '');
    expect(is_quiet(quiet({ latest_human_activity: date }), { now })).toBe(false);
  });
});

describe('last_activity', () => {
  it("prefers people's batches, then runs, then commits", () => {
    expect(last_activity(project({ latest_output_datetime: days_ago(0) }))).toEqual({ date: days_ago(1), kind: 'human' });
    expect(last_activity(quiet())).toEqual({ date: days_ago(1), kind: 'run' });
    expect(last_activity({ data: {}, latest_commit_datetime: days_ago(5) })).toEqual({ date: days_ago(5), kind: 'commit' });
  });
});

describe('build_tree', () => {
  it('puts projects under their closest ancestor project', () => {
    const { nodes } = build_tree({
      'repo': project(), 'repo/a': project(), 'repo/a/deep': project(), 'repo/b': project(), 'other': project(),
    }, { now });
    expect(ids(nodes).sort()).toEqual(['other', 'repo']);
    const repo = nodes.find(n => n.id === 'repo');
    expect(repo.nb_projects).toBe(3);
    expect(ids(repo.children).sort()).toEqual(['repo/a', 'repo/b']);
    const a = repo.children.find(n => n.id === 'repo/a');
    expect(a.name).toBe('a');
    expect(ids(a.children)).toEqual(['repo/a/deep']);
  });

  it('groups projects that share a prefix without a project of its own', () => {
    const { nodes } = build_tree({
      'kitefin/k3': project(), 'kitefin/k5': project(), 'solo/only/one': project(),
      'repo': project(), 'repo/sub/x': project(), 'repo/sub/y': project(), 'repo/lonely/z': project(),
    }, { now });
    const kitefin = nodes.find(n => n.id === 'kitefin');
    expect(kitefin.project).toBe(null);
    expect(kitefin.nb_projects).toBe(2);
    expect(kitefin.children.map(n => n.name).sort()).toEqual(['k3', 'k5']);
    // a prefix with a single project: no group, the project goes up, named from its parent
    const solo = nodes.find(n => n.id === 'solo/only/one');
    expect(solo.name).toBe('solo/only/one');
    const repo = nodes.find(n => n.id === 'repo');
    const sub = repo.children.find(n => n.id === 'repo/sub');
    expect(sub.project).toBe(null);
    expect(sub.name).toBe('sub');
    expect(sub.children.map(n => n.name).sort()).toEqual(['x', 'y']);
    expect(repo.children.find(n => n.id === 'repo/lonely/z').name).toBe('lonely/z');
  });

  it('collapses quiet subprojects, and quiet groups at the top', () => {
    const tree = build_tree({
      'repo': project(), 'repo/ci-only': quiet(), 'repo/used': project(), 'repo/viewed': quiet({ views_90d: 2 }),
      'old/a': quiet(), 'old/b': quiet(),
    }, { now });
    const repo = tree.nodes.find(n => n.id === 'repo');
    // only the CI runs them: being viewed doesn't make them interesting
    expect(ids(repo.children)).toEqual(['repo/used']);
    expect(ids(repo.quiet_children).sort()).toEqual(['repo/ci-only', 'repo/viewed']);
    expect(ids(tree.quiet_nodes)).toEqual(['old']);
    expect(count_projects(tree.quiet_nodes)).toBe(2);
  });

  it('keeps quiet projects whose subprojects are used, and pinned ones', () => {
    const tree = build_tree({
      'repo': quiet(), 'repo/used': project(), 'pinned': quiet(), 'gone': quiet(),
    }, { now, favorites: { pinned: true } });
    expect(ids(tree.nodes)).toEqual(['pinned', 'repo']);
    expect(ids(tree.quiet_nodes)).toEqual(['gone']);
  });

  it('shows pinned projects first, then the most recently used', () => {
    const tree = build_tree({
      'a': project({ latest_human_activity: days_ago(10) }), 'b': project({ latest_human_activity: days_ago(2) }),
      'c': project({ latest_human_activity: days_ago(30) }), 'g/x': project({ latest_human_activity: days_ago(50) }), 'g/y': project(),
    }, { now, favorites: { c: true } });
    expect(ids(tree.nodes)).toEqual(['c', 'g', 'b', 'a']);
  });

  it('adds up the activity of what is below', () => {
    const activity = n => Array.from({ length: 30 }, () => n);
    const { nodes } = build_tree({ 'repo': project({ activity: activity(1) }), 'repo/a': project({ activity: activity(2) }), 'repo/b': project() }, { now });
    expect(nodes[0].activity).toEqual(activity(3));
  });
});

describe('filter_projects', () => {
  it('lists matches flat, quiet ones included and marked', () => {
    const matches = filter_projects({ 'repo': project(), 'repo/ci-only': quiet(), 'other': project() }, 'repo', { now });
    expect(matches.map(m => [m.id, m.name, m.quiet])).toEqual([['repo', 'repo', false], ['repo/ci-only', 'repo/ci-only', true]]);
  });
});

describe('path_segments', () => {
  it('says which ancestors are projects', () => {
    expect(path_segments('group/repo/sub', { 'group/repo': {}, 'group/repo/sub': {} })).toEqual([
      { name: 'group', path: 'group', is_project: false },
      { name: 'repo', path: 'group/repo', is_project: true },
      { name: 'sub', path: 'group/repo/sub', is_project: true },
    ]);
  });
});

describe('claimView', () => {
  beforeEach(() => localStorage.clear());

  it('sends views at most once an hour per project', () => {
    expect(claimView('repo', now)).toBe(true);
    expect(claimView('repo', now + 1000)).toBe(false);
    expect(claimView('other', now + 1000)).toBe(true);
    expect(claimView('repo', now + view_throttle_ms)).toBe(true);
  });

  it('works without storage', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(claimView('repo', now)).toBe(true);
    getItem.mockRestore();
    setItem.mockRestore();
  });
});
