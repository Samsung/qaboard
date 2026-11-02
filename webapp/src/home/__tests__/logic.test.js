/**
 * What goes where on the home page.
 * Run with: cd webapp && npm test -- home/__tests__/logic
 */
import { my_projects, needs_attention, learn } from '../logic';

const now = Date.UTC(2026, 9, 24);
const days_ago = n => new Date(now - n * 24 * 3600 * 1000).toISOString();
const project = (extra = {}) => ({ data: { qatools_config: { project: { name: 'x' } } }, latest_commit_datetime: days_ago(1), ...extra });

describe('my_projects', () => {
  const projects = {
    'a/ran': project({ my_latest_activity: days_ago(2) }),
    'a/viewed': project({ my_last_view: days_ago(1) }),
    'a/old': project({ my_latest_activity: days_ago(200) }),
    'a/pinned': project({ latest_human_activity: days_ago(3) }),
    'a/batches': project(),
    'a/others': project({ latest_human_activity: days_ago(0) }),
  };
  it('lists where users ran, committed or looked lately, and their pins, the most recent first', () => {
    const batches = [{ project: 'a/batches', latest_output_datetime: days_ago(0.5) }];
    const ids = my_projects(projects, { favorites: { 'a/pinned': true, 'a/gone': true }, batches, now }).map(p => p.id);
    expect(ids).toEqual(['a/batches', 'a/viewed', 'a/ran', 'a/pinned']);
  });
});

describe('needs_attention', () => {
  const batch = (id, extra) => ({ id, failed_outputs: 2, pending_outputs: 0, latest_output_datetime: days_ago(1), ...extra });
  it('keeps the batches that ended with failures this week, unless dismissed', () => {
    const batches = [batch(1), batch(2, { pending_outputs: 1 }), batch(3, { failed_outputs: 0 }), batch(4, { latest_output_datetime: days_ago(9) }), batch(5), batch(6, { failed_outputs: 5 })];
    const dismissed = { 5: { failed: 2, at: days_ago(0) }, 6: { failed: 2, at: days_ago(0) } };
    // more runs failed in 6 since it was dismissed
    expect(needs_attention(batches, dismissed, now).map(b => b.id)).toEqual([1, 6]);
  });

  it('shows a dismissed batch again when it runs again, even with as many failures', () => {
    const redone = batch(7, { latest_output_datetime: days_ago(0) });
    expect(needs_attention([redone], { 7: { failed: 2, latest: days_ago(1), at: days_ago(1) } }, now)).toEqual([redone]);
    expect(needs_attention([redone], { 7: { failed: 2, latest: redone.latest_output_datetime, at: days_ago(0) } }, now)).toEqual([]);
  });
});

describe('learn', () => {
  it('suggests what users have not tried yet', () => {
    expect(learn({ has_batches: false, has_webapp: false, has_running: false }).map(l => l.id)).toEqual(['first-review', 'webapp', 'milestones']);
    expect(learn({ has_batches: true, has_webapp: true, has_running: true }).map(l => l.id)).toEqual(['activity', 'compare', 'milestones']);
  });
});
