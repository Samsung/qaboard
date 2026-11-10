/**
 * The flame graph viewer's model: differential trees, search, top functions, units.
 * Run with: cd webapp && npm test -- flamegraph
 */
import { describe, expect, it } from 'vitest';

import { parseFolded } from '../formats';
import { generateFolded } from '../generate';
import {
  MAX_DEPTH_DRAWN, drawnTree, findPath, formatPoints, mergeTrees, formatShare, formatValue, functionTotals, makeMatcher, matchedValue, parseUnit,
  topFunctions,
} from '../profile';

const tree = text => parseFolded(text).profiles[0].tree;

// the gateway's workers: the new code takes a lock in respond, and the model runs less
const reference = tree('worker;respond 20\nworker;model 80\nworker 100\n');
const now = tree('worker;respond 20\nworker;respond;lock 30\nworker;model 50\nworker 100\n');

// what d3-flame-graph's computeDelta does with the deltas: each node's plus its drawn children's
const inclusive = node => (node.delta ?? 0) + (node.children ?? []).reduce((sum, c) => sum + inclusive(c), 0);

describe('differential flame graphs', () => {
  it('gives each frame its delta, so that d3-flame-graph sums them right', () => {
    const drawn = drawnTree(now, reference, { mode: 'absolute' });
    const respond = findPath(drawn, 'all;worker;respond');
    expect(inclusive(respond)).toBe(30);          // the new lock frame and its callers: more time
    expect(inclusive(respond.children[0])).toBe(30);
    expect(respond.children[0].missing).toBe('new');
    expect(inclusive(findPath(drawn, 'all;worker;model'))).toBe(-30);   // the model: less
    expect(inclusive(drawn)).toBe(0);             // the same total
    expect(findPath(drawn, 'all;worker;model')).toMatchObject({ value: 50, self: 50, other_value: 80, other_self: 80 });
  });

  it('compares shares when the totals differ', () => {
    // the same profile, recorded twice as long
    const longer = tree('worker;respond 40\nworker;model 160\nworker 200\n');
    const shares = drawnTree(longer, reference);
    expect(inclusive(shares)).toBe(0);
    expect(inclusive(findPath(shares, 'all;worker;model'))).toBe(0);
    const absolute = drawnTree(longer, reference, { mode: 'absolute' });
    expect(inclusive(findPath(absolute, 'all;worker;model'))).toBe(80);
  });

  it('counts frames only in the other profile, and frames too narrow to draw', () => {
    const before = tree('main;parse 50\nmain;legacy 50\n');
    const after = tree('main;parse 99\nmain;tiny 1\n');
    const drawn = drawnTree(after, before, { mode: 'absolute', minShare: 0.05 });
    const main = findPath(drawn, 'all;main');
    expect(main.children.map(c => c.name)).toEqual(['parse']);   // tiny isn't drawn
    expect(inclusive(main)).toBe(0);
    expect(inclusive(main.children[0])).toBe(49);
    // the reference's tree: legacy was removed, it's blue
    const drawn_ref = drawnTree(before, after, { mode: 'absolute', side: 'reference' });
    expect(findPath(drawn_ref, 'all;main;legacy')).toMatchObject({ missing: 'removed', delta: -50 });
    expect(inclusive(findPath(drawn_ref, 'all;main;parse'))).toBe(49);
  });
});

describe('search', () => {
  it('reads regular expressions, or text', () => {
    expect(makeMatcher('lock|wait')('lock_contended')).toBe(true);
    expect(makeMatcher('LOCK')('lock')).toBe(true);
    expect(makeMatcher('LOCK', { matchCase: true })('lock')).toBe(false);
    expect(makeMatcher('a|b', { regex: false })('b')).toBe(false);
    const invalid = makeMatcher('Mutex<T>::lock(');
    expect(invalid.invalid).toBe(true);
    expect(invalid('std::Mutex<T>::lock(&self)')).toBe(true);
    expect(makeMatcher('')).toBe(null);
  });

  it('counts nested matches once', () => {
    const recursive = tree('main;walk;walk;walk 10\nmain;walk 10\nmain;parse 80\n');
    expect(matchedValue(recursive, makeMatcher('walk'))).toBe(20);
    expect(matchedValue(recursive, makeMatcher('^main$')) / recursive.value).toBe(1);
  });
});

describe('top functions', () => {
  it('sums each function over its stacks, recursion counted once', () => {
    const totals = functionTotals(tree('main;walk;walk;leaf 10\nmain;walk 5\nmain;other;walk 5\nmain 1\n'));
    expect(totals.get('walk')).toEqual({ self: 10, total: 20 });
    expect(totals.get('main')).toEqual({ self: 1, total: 21 });
    expect(totals.has('all')).toBe(false);
  });

  it('says what changed against the reference', () => {
    const rows = Object.fromEntries(topFunctions(now, reference).map(r => [r.name, r]));
    expect(rows.lock).toMatchObject({ is_new: true, self: 30, other_self: 0 });
    expect(rows.lock.change).toBeCloseTo(30 / 200);
    expect(rows.model.change).toBeCloseTo(50 / 200 - 80 / 200);
    const absolute = Object.fromEntries(topFunctions(now, reference, { mode: 'absolute' }).map(r => [r.name, r]));
    expect(absolute.model.change).toBe(-30);
    const removed = Object.fromEntries(topFunctions(reference, now).map(r => [r.name, r]));
    expect(removed.lock).toMatchObject({ is_removed: true, self: 0 });
  });

  it('finds the known changes of the generated profiles', () => {
    const [after, before] = [tree(generateFolded()), tree(generateFolded({ reference: true }))];
    expect(after.value).toBeGreaterThan(before.value * 1.1);
    const rows = Object.fromEntries(topFunctions(after, before).map(r => [r.name, r]));
    expect(rows.lock_contended.is_new).toBe(true);
    expect(rows['legacy::checksum'].is_removed).toBe(true);
    const model = rows['gateway::model::forward'];
    expect(model.total_share).toBeCloseTo(0.3 / 0.96, 1);
    expect(model.other_total / before.value).toBeCloseTo(0.45, 1);
  });
});

describe('units', () => {
  it('formats values in their unit', () => {
    expect(formatValue(12345, 'samples')).toBe('12,345 samples');
    expect(formatValue(1, 'samples')).toBe('1 sample');
    expect(formatValue(1500, 'microseconds')).toBe('1.5 ms');
    expect(formatValue(720000000, 'nanoseconds')).toBe('720 ms');
    expect(formatValue(0.25, 'seconds')).toBe('250 ms');
    expect(formatValue(3 * 1024 * 1024, 'bytes')).toBe('3 MiB');
    expect(formatValue(12, 'allocations')).toBe('12 allocations');
    expect(formatShare(0.1234)).toBe('12.3%');
    expect(formatShare(0.01234)).toBe('1.23%');
    expect(formatPoints(-0.023)).toBe('−2.3 pp');
  });

  it('reads units with a description', () => {
    expect(parseUnit('µs of CPU per 1,000 requests')).toEqual({ unit: 'microseconds', note: 'of CPU per 1,000 requests' });
    expect(parseUnit('none')).toEqual({ unit: 'samples', note: '' });
    expect(parseUnit('cycles')).toEqual({ unit: 'cycles', note: '' });
  });
});

describe('deep stacks', () => {
  it('handles stacks deeper than the call stack, and draws them up to MAX_DEPTH_DRAWN', () => {
    const deep = tree(`${Array.from({ length: 50000 }, (_, i) => `f${i % 3}`).join(';')} 10\nmain 5\n`);
    expect(topFunctions(deep, deep).find(r => r.name === 'f0')).toMatchObject({ total: 10, change: 0 });
    expect(mergeTrees([deep, deep]).value).toBe(30);
    const drawn = drawnTree(deep, deep);
    let depth = 0;
    for (let node = drawn; node.children.length; node = node.children[0]) depth++;
    expect(depth).toBe(MAX_DEPTH_DRAWN);
    expect(drawn.too_deep).toBe(true);
    expect(drawnTree(now, reference).too_deep).toBeUndefined();
  });
});
