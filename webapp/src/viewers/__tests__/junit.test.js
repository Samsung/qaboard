/**
 * The JUnit viewer's parser and model: reports of several test runners, comparison with the reference, the tree.
 * Run with: cd webapp && npm test -- junit
 */
import { parseJunit } from '../junit/parse';
import {
  buildTree, compareTests, countTests, defaultExpanded, flatten, testFilter, visibleCounts, ancestorKeys,
  allGroupKeys, parseSearch, formatTime,
} from '../junit/model';

const PYTEST = `<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest" tests="5" failures="1" skipped="1">
  <testcase classname="tests.codec.test_crc" name="test_known[a]" file="tests/codec/test_crc.py" line="12" time="0.001"/>
  <testcase classname="tests.codec.test_crc" name="test_known[b]" time="0.002"/>
  <testcase classname="tests.codec.test_varint" name="test_fuzz[3]" time="0.010">
    <failure message="assert 1 == 2">def test_fuzz():
&gt;       assert 1 == 2
E       assert 1 == 2</failure>
    <system-out>seed 3</system-out>
  </testcase>
  <testcase classname="tests.codec.test_varint.TestEdges" name="test_zero" time="0"><skipped message="later"/></testcase>
  <testcase classname="tests.planning.test_astar" name="test_big" time="0.30"/>
</testsuite></testsuites>`;

const GTEST = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="3" name="AllTests">
  <testsuite name="Bits/VarintRoundTrip" tests="3">
    <testcase name="Encodes/7" status="run" result="completed" time="0.004" classname="Bits/VarintRoundTrip"/>
    <testcase name="DISABLED_Huge" status="notrun" result="suppressed" time="0" classname="Bits/VarintRoundTrip"/>
    <testcase name="NeedsBigEndian" status="run" result="skipped" time="0" classname="Bits/VarintRoundTrip"><skipped message="little-endian"/></testcase>
  </testsuite>
</testsuites>`;

const SUREFIRE = `<testsuite name="com.kitefin.ClientTest">
  <testcase name="deadline" classname="com.kitefin.ClientTest" time="0.5">
    <flakyFailure message="expected 3.5 but was 3.7" type="AssertionError"><stackTrace>at ClientTest.deadline</stackTrace></flakyFailure>
  </testcase>
  <testcase name="crash" classname="com.kitefin.ClientTest" time="0.1"><error message="NullPointerException" type="NPE">at Client.connect</error></testcase>
</testsuite>`;

describe('parseJunit', () => {
  it('reads pytest reports', () => {
    const { tests, error } = parseJunit(PYTEST);
    expect(error).toBe(null);
    expect(tests.map(t => t.status)).toEqual(['passed', 'passed', 'failed', 'skipped', 'passed']);
    const failed = tests[2];
    expect(failed.id).toBe('tests.codec.test_varint::test_fuzz[3]');
    expect(failed.path).toEqual(['tests', 'codec', 'test_varint', 'test_fuzz[3]']);
    expect(failed.message).toBe('assert 1 == 2');
    expect(failed.text).toContain('>       assert 1 == 2');
    expect(failed.stdout).toBe('seed 3');
    expect(tests[0]).toMatchObject({ file: 'tests/codec/test_crc.py', line: '12', time: 0.001 });
    expect(tests[3]).toMatchObject({ message: 'later', path: ['tests', 'codec', 'test_varint', 'TestEdges', 'test_zero'] });
  });

  it('reads GoogleTest reports: disabled and skipped tests', () => {
    const { tests } = parseJunit(GTEST);
    expect(tests.map(t => [t.path, t.status])).toEqual([
      [['Bits/VarintRoundTrip', 'Encodes/7'], 'passed'],
      [['Bits/VarintRoundTrip', 'DISABLED_Huge'], 'skipped'],
      [['Bits/VarintRoundTrip', 'NeedsBigEndian'], 'skipped'],
    ]);
  });

  it('reads flaky tests and errors from Maven Surefire', () => {
    const { tests } = parseJunit(SUREFIRE);
    expect(tests.map(t => t.status)).toEqual(['flaky', 'error']);
    expect(tests[0]).toMatchObject({ message: 'expected 3.5 but was 3.7', text: 'at ClientTest.deadline', failure_type: 'AssertionError' });
  });

  it('keeps tests listed twice apart', () => {
    const { tests } = parseJunit('<testsuite><testcase classname="a" name="t"/><testcase classname="a" name="t"/></testsuite>');
    expect(tests.map(t => t.id)).toEqual(['a::t', 'a::t #2']);
  });

  it('reads entities, CDATA and comments', () => {
    const { tests, error } = parseJunit(`<?xml version="1.0"?>
<!-- generated -->
<testsuites><testsuite name='s'><properties><property name="seed" value="1"/></properties>
  <testcase classname="a" name="x &lt; y &amp; &#x7a;"><failure message="&quot;1&quot; != 2"><![CDATA[if a < b && c:
  fail()]]></failure></testcase>
</testsuite></testsuites>`);
    expect(error).toBe(null);
    expect(tests).toHaveLength(1);
    expect(tests[0]).toMatchObject({ name: 'x < y & z', message: '"1" != 2', text: 'if a < b && c:\n  fail()', suite: 's' });
  });

  it('says what is wrong with other files', () => {
    expect(parseJunit('').error).toMatch(/empty/);
    expect(parseJunit('<testsuite><testcase').error).toMatch(/not valid XML/);
    expect(parseJunit('<html><body/></html>').error).toMatch(/not a JUnit XML report/);
    expect(parseJunit('<testsuite><testcase></testsuite>').error).toMatch(/closes <testcase>/);
    expect(parseJunit('<testsuite>').error).toMatch(/never closed/);
  });
});

const test = (id, status, time = 0.01) => {
  const parts = id.split('::');
  return { id, path: [...parts[0].split('.'), parts[1]], name: parts[1], status, time, message: '', text: '' };
};

describe('compareTests', () => {
  const ref = [test('a.b::fixed', 'failed'), test('a.b::broken', 'passed'), test('a.b::same', 'passed'),
    test('a.b::gone', 'passed'), test('a.c::flaky', 'passed'), test('a.c::skip', 'passed'), test('a.c::slow', 'passed', 0.1),
    test('a.c::still', 'error'), test('a.c::hidden', 'failed')];
  const now = [test('a.b::fixed', 'passed'), test('a.b::broken', 'failed'), test('a.b::same', 'passed'),
    test('a.b::new', 'passed'), test('a.c::flaky', 'flaky'), test('a.c::skip', 'skipped'), test('a.c::slow', 'passed', 0.5),
    test('a.c::still', 'failed'), test('a.c::hidden', 'skipped')];

  it('says how each test changed', () => {
    const compared = compareTests(now, ref);
    expect(Object.fromEntries(compared.map(t => [t.name, t.change]))).toEqual({
      fixed: 'fixed', broken: 'new-failure', same: null, new: 'added', flaky: 'newly-flaky', skip: 'newly-skipped',
      slow: 'slower', still: 'still-failing', gone: 'removed',
      // skipping a failing test doesn't fix it
      hidden: 'newly-skipped',
    });
    expect(compared.find(t => t.name === 'gone').status).toBe('removed');
  });

  it('counts tests, removed ones apart', () => {
    const { counts, changes } = countTests(compareTests(now, ref));
    expect(counts).toMatchObject({ tests: 9, passed: 4, failed: 2, flaky: 1, skipped: 2, removed: 1 });
    expect(changes['new-failure']).toBe(1);
  });

  it('has no changes without a reference', () => {
    expect(compareTests(now, null).every(t => t.change === null)).toBe(true);
  });
});

describe('the tree', () => {
  const { tests } = parseJunit(PYTEST);
  const root = buildTree(compareTests(tests, null));

  it('merges groups with a single child', () => {
    expect(root.children.map(c => c.name)).toEqual(['tests']);
    expect(root.children[0].children.map(c => c.name)).toEqual(['codec', 'planning.test_astar']);
  });

  it('counts the tests of each group', () => {
    const codec = root.children[0].children[0];
    expect(codec.counts).toMatchObject({ tests: 4, passed: 2, failed: 1, skipped: 1 });
  });

  it('opens the groups that need a look, and flattens them failures first', () => {
    const expanded = defaultExpanded(root, { has_reference: false });
    const rows = flatten(root, { expanded, visible: null, sort: 'status' });
    const names = rows.map(r => r.kind === 'group' ? `[${r.node.name}]` : r.test.name);
    // planning has no failure: closed; codec's varint (a failure) comes before crc
    // TestEdges only has a skipped test: closed
    expect(names).toEqual(['[tests]', '[codec]', '[test_varint]', '[TestEdges]', 'test_fuzz[3]', '[test_crc]', '[planning.test_astar]']);
  });

  it('shows everything when all groups are open', () => {
    const rows = flatten(root, { expanded: allGroupKeys(root), visible: null, sort: 'name' });
    expect(rows.filter(r => r.kind === 'test')).toHaveLength(5);
  });

  it('filters by status and search, and drops the groups left empty', () => {
    const filter = testFilter({ statuses: new Set(['passed']), change: '', search: 'codec -[b]' });
    const visible = visibleCounts(root, filter);
    const rows = flatten(root, { expanded: true, visible, sort: 'name', filter });
    expect(rows.filter(r => r.kind === 'test').map(r => r.test.name)).toEqual(['test_known[a]']);
    expect(rows.some(r => r.kind === 'group' && r.node.name === 'planning.test_astar')).toBe(false);
  });

  it('finds the groups above a test', () => {
    const fuzz = tests.find(t => t.name === 'test_fuzz[3]');
    expect(ancestorKeys(fuzz, allGroupKeys(root))).toEqual(['tests', 'tests\u0000codec', 'tests\u0000codec\u0000test_varint']);
  });
});

describe('helpers', () => {
  it('parses searches', () => {
    expect(parseSearch('Codec  -Fuzz -')).toEqual({ include: ['codec'], exclude: ['fuzz'] });
  });
  it('formats times', () => {
    expect([0, 0.0004, 0.012, 1.5, 75].map(formatTime)).toEqual(['0 s', '<1 ms', '12 ms', '1.50 s', '1 min 15 s']);
  });
});

describe('performance', () => {
  it('reads, compares and flattens 50,000 tests in well under a second', () => {
    const cases = Array.from({ length: 50000 }, (_, i) =>
      `<testcase classname="tests.m${i % 40}.test_f${i % 400}" name="test_${i}" time="0.001">${i % 997 === 0 ? '<failure message="x">y</failure>' : ''}</testcase>`);
    const xml = `<testsuite>${cases.join('')}</testsuite>`;
    const start = performance.now();
    const { tests } = parseJunit(xml);
    const compared = compareTests(tests, tests);
    const root = buildTree(compared);
    const filter = testFilter({ statuses: new Set(), change: '', search: 'test_1' });
    flatten(root, { expanded: true, visible: visibleCounts(root, filter), sort: 'status', filter });
    // about 0.5 s in Node on a CI runner: the bound only catches quadratic slowdowns
    expect(performance.now() - start).toBeLessThan(5000);
    expect(tests).toHaveLength(50000);
  });
});
