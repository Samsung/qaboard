/**
 * The flame graph viewer reads what profilers write. The fixtures are real profiles (py-spy, node --cpu-prof),
 * shared with qaboard/flamegraphs.py's tests: tests/fixtures/flamegraphs/.
 * Run with: cd webapp && npm test -- flamegraph
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cwd } from 'node:process';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { decodeProfileBytes, detectFormat, parseProfile, selectTree } from '../formats';
import { findPath } from '../profile';

// vitest runs in webapp/
const fixture = name => readFileSync(resolve(cwd(), '../tests/fixtures/flamegraphs', name), 'utf-8');

describe('profile formats', () => {
  it('reads folded stacks, with their unit', () => {
    const profile = parseProfile(fixture('py-spy.folded'), 'py-spy.folded');
    expect(profile.format).toBe('folded');
    expect(profile.unit).toBe('samples');
    const tree = selectTree(profile);
    expect(tree.value).toBe(196);
    const parse = findPath(tree, 'all;Thread._bootstrap (threading.py);Thread._bootstrap_inner (threading.py);Thread.run (threading.py);worker (gateway.py);handle (gateway.py);parse (gateway.py)');
    expect(parse.self).toBe(48);
    expect(parse.value).toBe(48 + 69);

    const timed = parseProfile('# unit: microseconds of CPU per 1,000 requests\nworker;model 1500\r\nworker;respond\t750\nworker 0.5\n\nnot a stack\n');
    expect(timed.unit).toBe('microseconds');
    expect(timed.note).toBe('of CPU per 1,000 requests');
    expect(selectTree(timed).value).toBe(2250.5);
    expect(findPath(selectTree(timed), 'all;worker').self).toBe(0.5);
    // the visualization's unit option wins
    expect(parseProfile('a 1\n', 'x.folded', { unit: 'bytes' }).unit).toBe('bytes');
  });

  it('merges the threads of a speedscope file, or shows one', () => {
    const profile = parseProfile(fixture('py-spy.speedscope.json'), 'py-spy.speedscope.json');
    expect(profile.format).toBe('speedscope');
    expect(profile.unit).toBe('seconds');
    expect(profile.profiles.map(p => p.name)).toEqual(['Thread 3687 ""', 'Thread 3690 "worker-0"', 'Thread 3691 ""']);
    const all = selectTree(profile);
    const worker = selectTree(profile, 1);
    expect(all.value).toBeGreaterThan(worker.value);
    expect(all.value).toBeCloseTo(profile.profiles.reduce((sum, p) => sum + p.tree.value, 0));
    // frames are named after their function and file, without line numbers: they match from commit to commit
    expect(findPath(worker, 'all;Thread._bootstrap (threading.py);Thread._bootstrap_inner (threading.py);Thread.run (threading.py);worker (gateway.py)')).toBeTruthy();
  });

  it('reads evented speedscope profiles', () => {
    const file = JSON.stringify({
      $schema: 'https://www.speedscope.app/file-format-schema.json',
      shared: { frames: [{ name: 'main' }, { name: 'parse', file: 'src/parse.rb' }, { name: 'render' }] },
      profiles: [{ type: 'evented', name: 'rbspy', unit: 'milliseconds', startValue: 0, endValue: 10, events: [
        { type: 'O', frame: 0, at: 0 }, { type: 'O', frame: 1, at: 1 }, { type: 'C', frame: 1, at: 4 },
        { type: 'O', frame: 2, at: 4 }, { type: 'C', frame: 2, at: 9 }, { type: 'C', frame: 0, at: 10 },
      ] }],
    });
    const tree = selectTree(parseProfile(file));
    expect(tree.value).toBe(10);
    expect(findPath(tree, 'all;main').self).toBe(2);
    expect(findPath(tree, 'all;main;parse (parse.rb)').value).toBe(3);
    expect(findPath(tree, 'all;main;render').value).toBe(5);
  });

  it('reads Chrome .cpuprofile files', () => {
    const text = fixture('node.cpuprofile');
    const data = JSON.parse(text);
    const profile = parseProfile(text, 'node.cpuprofile');
    expect(profile.format).toBe('cpuprofile');
    expect(profile.unit).toBe('microseconds');
    const tree = selectTree(profile);
    // each sample lasts until the next: all of the profile's time
    expect(tree.value).toBeCloseTo(data.endTime - data.startTime - data.timeDeltas[0], -1);
    const names = [];
    const walk = node => { names.push(node.name); node.children.forEach(walk); };
    walk(tree);
    expect(names).toContain('parse (gateway.js)');
    expect(names).toContain('(program)');
    expect(names).not.toContain('(root)');
  });

  it("keeps reading QA-Board's JSON, and merges siblings with the same name", () => {
    const tree = selectTree(parseProfile(JSON.stringify({ name: 'gateway-bench', value: 100, children: [
      { name: 'worker', value: 60, children: [{ name: 'model', value: 50 }] },
      { name: 'worker', value: 30 },
    ] }), 'cpu.flame.json'));
    expect(tree.name).toBe('gateway-bench');
    expect(tree.value).toBe(100);
    expect(tree.children).toHaveLength(1);
    expect(findPath(tree, 'gateway-bench;worker')).toMatchObject({ value: 90, self: 40 });
  });

  it('reads folded stacks whose first frame starts with a bracket', () => {
    const profile = parseProfile('[unknown];main;parse 3\n[unknown];main 1\n', 'cpu.folded');
    expect(findPath(selectTree(profile), 'all;[unknown];main;parse')).toMatchObject({ value: 3 });
    expect(() => parseProfile('{"name": "all", "value": 3', 'cpu.flame.json')).toThrow(/Not a profile/);
  });

  it('says how to convert what the browser does not read', () => {
    expect(() => parseProfile(' '.repeat(200e6 + 1), 'cpu.folded')).toThrow(/too large to show \(200 MB/);
    expect(detectFormat(fixture('perf.script.txt'))).toBe('perf-script');
    expect(() => parseProfile(fixture('perf.script.txt'))).toThrow(/qaboard.flamegraphs.save_flame_graph/);
    expect(() => parseProfile('\n\u0012\u0008samples\u0000\u0001', 'cpu.pb.gz')).toThrow(/pprof/);
  });

  it('decompresses gzipped files', async () => {
    const gz = gzipSync(new TextEncoder().encode('a;b 3\n'));
    expect(await decodeProfileBytes(gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength))).toBe('a;b 3\n');
    expect(await decodeProfileBytes(new TextEncoder().encode('a 1\n').buffer)).toBe('a 1\n');
  });
});
