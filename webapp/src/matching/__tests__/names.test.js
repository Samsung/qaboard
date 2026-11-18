import { name_changes, name_rewrite, names_by_likeness, rename, same_file_positions, rule_of_change, rule_text, similar_positions, split_name, suggest_pairs } from '../names';
import { index_outputs } from '../match';

const output = (id, test_input_path) => ({
  id, test_input_path, input_path: `/db/${test_input_path}`, test_input_metadata: {},
  configurations: [], configurations_str: '[]', extra_parameters: {}, extra_parameters_str: '{}', platform: 'linux',
});
const batch = outputs => ({ outputs: Object.fromEntries(outputs.map(o => [o.id, o])), filtered: { outputs: outputs.map(o => o.id) } });

describe('names', () => {
  it('splits names in parts at separators, folders included', () => {
    expect(split_name('captures/reg05/street dusk.raw')).toEqual(['captures', '/', 'reg05', '/', 'street', ' ', 'dusk', '.', 'raw']);
    expect(split_name('C:\\caps\\a,b=1.raw').filter((_, i) => i % 2 === 0)).toEqual(['C', 'caps', 'a', 'b', '1', 'raw']);
  });

  it('finds the parts that differ, with the part before', () => {
    expect(name_changes('street_reg0x1A=05_g4.raw', 'street_reg0x1A=03_g4.raw')).toEqual([{ index: 4, from: '05', to: '03', before: 'reg0x1A=' }]);
    expect(name_changes('sensorA/day/1.raw', 'sensorB/day/1.raw')).toEqual([{ index: 0, from: 'sensorA', to: 'sensorB', before: '' }]);
    // not built alike
    expect(name_changes('run1/street.raw', 'run1/sub/street.raw')).toBeNull();
    expect(name_changes('a_b.raw', 'a-b.raw')).toBeNull();
  });

  it('renames whole parts', () => {
    const rule = rule_of_change(name_changes('x_reg0x1A=05_g4', 'x_reg0x1A=03_g4')[0]);
    expect(rule).toEqual({ from: 'reg0x1A=05', to: 'reg0x1A=03' });
    expect(rename('street_reg0x1A=05_g4.raw', [rule])).toBe('street_reg0x1A=03_g4.raw');
    expect(rename('street_reg0x1A=055_g4.raw', [rule])).toBeNull();
    expect(rename('caps/reg05/street.raw', [{ from: 'reg05', to: 'reg03' }])).toBe('caps/reg03/street.raw');
    // only whole parts
    expect(rename('street_reg05gain4.raw', [{ from: '05gain', to: '03gain' }])).toBeNull();
    expect(rename('street.raw', [{ from: 'night', to: 'day' }])).toBeNull();
  });

  it('shows rules short', () => {
    expect(rule_text({ from: 'reg0x1A=05', to: 'reg0x1A=03' })).toBe('reg0x1A=05 → 03');
    expect(rule_text({ from: 'sensorA', to: 'sensorB' })).toBe('sensorA → sensorB');
  });

  it('finds the reference runs whose name differs by one part', () => {
    const refs = [output(1, 'a_03_b.raw'), output(2, 'a_04_c.raw'), output(3, 'z_05_b.raw'), output(4, 'a_05_b.raw')];
    const index = index_outputs(batch(refs));
    expect(similar_positions('a_05_b.raw', index).map(i => index.outputs[i].id)).toEqual([1, 3]);
  });

  it('suggests the name changes that pair the most runs, batch-wide changes first', () => {
    const scenes = ['street', 'office', 'macbeth', 'star'];
    const runs = scenes.map((s, i) => output(10 + i, `${s}_reg0x1A=05_g4.raw`));
    const refs = [
      ...scenes.map((s, i) => output(20 + i, `${s}_reg0x1A=03_g4.raw`)),
      // a scene's name differs: pairs one run, and it's another scene
      output(30, 'night_reg0x1A=05_g4.raw'),
    ];
    const index = index_outputs(batch(refs));
    const suggestions = suggest_pairs({ unmatched: runs, outputs: runs, index, labels: { new: 'sweep-0x1A=05', reference: 'sweep-0x1A=03' } });
    expect(suggestions[0]).toEqual({ rule: { from: 'reg0x1A=05', to: 'reg0x1A=03' }, pairs: 4 });
    expect(suggestions.map(s => s.rule.to)).toContain('night');
    // rules users have are not suggested again
    expect(suggest_pairs({ unmatched: runs, outputs: runs, index, pairs: [suggestions[0].rule] })[0].rule.to).not.toBe('reg0x1A=03');
  });

  it("doesn't call similar the names that differ by a part every name has, nor empty parts", () => {
    // set_a/scene_<i>.raw: leaving out the scene, every name is the same. Looking them up would compare all with all.
    const refs = Array.from({ length: 30 }, (_, i) => output(i, `set_a/scene_${i}.raw`));
    const runs = Array.from({ length: 30 }, (_, i) => output(100 + i, `set_a/scene_${i}x.raw`));
    const index = index_outputs(batch(refs));
    expect(similar_positions('set_a/scene_3x.raw', index)).toEqual([]);
    expect(suggest_pairs({ unmatched: runs, outputs: runs, index })).toEqual([]);
    // "_a" and "b_a": an empty part
    const odd = index_outputs(batch([output(1, 'b_a')]));
    expect(suggest_pairs({ unmatched: [output(2, '_a')], outputs: [output(2, '_a')], index: odd })).toEqual([]);
    expect(rename('a_b', [{ from: '', to: 'x' }])).toBeNull();
  });

  it('counts names, not runs, so tuning batches with many runs per input keep their similar names', () => {
    // 25 runs per input: tuning parameters
    const refs = ['scene0_reg03.raw', 'scene1_reg03.raw'].flatMap((name, s) => Array.from({ length: 25 }, (_, i) => output(s * 100 + i, name)));
    const index = index_outputs(batch(refs));
    expect(similar_positions('scene0_reg05.raw', index)).toHaveLength(25);
    const run = output(1000, 'scene0_reg05.raw');
    expect(suggest_pairs({ unmatched: [run], outputs: [run], index })[0].rule).toEqual({ from: 'scene0_reg05', to: 'scene0_reg03' });
  });

  it('rewrites names that are not built alike, keeping their common end', () => {
    expect(name_rewrite('run1/street.raw', 'run1/sub/street.raw')).toEqual({ from: 'run1', to: 'run1/sub' });
    expect(name_rewrite('dataset_v1/day/street.raw', 'datasets/v2/day/street.raw')).toEqual({ from: 'dataset_v1', to: 'datasets/v2' });
    expect(name_rewrite('a_b.raw', 'a-b.raw')).toEqual({ from: 'a_b', to: 'a-b' });
    // nothing in common: the whole name
    expect(name_rewrite('x.png', 'y/z.jpg')).toEqual({ from: 'x.png', to: 'y/z.jpg' });
    // nothing between their common start and end: the part before
    expect(name_rewrite('a/street.raw', 'a/b/street.raw')).toEqual({ from: 'a', to: 'a/b' });
    expect(name_rewrite('street.raw', 'sub/street.raw')).toEqual({ from: 'street', to: 'sub/street' });
    // an empty part at the start, the same names, a part the rule would also change elsewhere
    expect(name_rewrite('/a/b', 'x/a/b')).toBeNull();
    expect(name_rewrite('a/b', 'a/b')).toBeNull();
    expect(name_rewrite('x/q/x', 'y/q/x')).toBeNull();
    expect(name_rewrite('a/x/a/f.raw', 'a/y/f.raw')).toEqual({ from: 'x/a', to: 'y' });
    for (const [a, b] of [['run1/street.raw', 'run1/sub/street.raw'], ['p/q_r.s', 'p/t/q-r.s'], ['1_2_3', '1_x_2_y_3']]) {
      const rule = name_rewrite(a, b);
      expect(rename(a, [rule])).toBe(b);
    }
  });

  it('suggests a change of folder for the same files elsewhere', () => {
    const scenes = ['street', 'office', 'macbeth'];
    const runs = scenes.map((s, i) => output(10 + i, `captures/v1/${s}.raw`));
    const refs = scenes.map((s, i) => output(20 + i, `datasets/captures-v2/day/${s}.raw`));
    const index = index_outputs(batch(refs));
    expect(same_file_positions('captures/v1/street.raw', index)).toEqual([0]);
    expect(same_file_positions('street.raw', index)).toEqual([]);
    expect(suggest_pairs({ unmatched: runs, outputs: runs, index })[0]).toEqual({ rule: { from: 'captures/v1', to: 'datasets/captures-v2/day' }, pairs: 3 });
  });

  it('sorts all the names, the closest first', () => {
    const refs = [output(1, 'other/thing.png'), output(2, 'b/street_day.png'), output(3, 'b/street_night.png'), output(4, 'b/street_day.png')];
    const index = index_outputs(batch(refs));
    const names = names_by_likeness('a/street_day.png', index);
    expect(names.map(n => n.name)).toEqual(['b/street_day.png', 'b/street_night.png', 'other/thing.png']);
    expect(names[0].positions).toEqual([1, 3]);
  });

  it('applies all the rules to the name as it is', () => {
    expect(rename('x_A_y', [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }])).toBe('x_B_y');
    expect(rename('A_B', [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }])).toBe('B_C');
  });
});
