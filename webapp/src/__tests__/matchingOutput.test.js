import { matching_output, reference_candidates, rules_for_all, index_outputs } from '../matching/match';
import { rules_from_query } from '../matching/rules';

// like normalize_output's
const run = (id, { configurations = ['base'], extra_parameters = {}, ...extra } = {}) => ({
  id,
  input_path: 'photos/facade.png',
  test_input_path: 'photos/facade.png',
  test_input_metadata: {},
  configurations,
  configurations_str: JSON.stringify(configurations),
  extra_parameters,
  extra_parameters_str: JSON.stringify(extra_parameters),
  platform: 'linux',
  is_pending: false,
  ...extra,
});

const batch = outputs => ({
  outputs: Object.fromEntries(outputs.map(o => [o.id, o])),
  filtered: { outputs: outputs.map(o => o.id) },
});

describe('matching_output', () => {
  it('compares a run with the reference run of the same platform', () => {
    const output = run(1);
    for (const outputs of [[run(2, { platform: 'hw-model' }), run(3)], [run(3), run(2, { platform: 'hw-model' })]]) {
      const { output_ref, mismatch } = matching_output({ output, batch: batch(outputs) });
      expect(output_ref.id).toBe(3);
      expect(mismatch).toBeNull();
    }
  });

  it('falls back to another platform, and says so', () => {
    const { output_ref, mismatch } = matching_output({ output: run(1), batch: batch([run(2, { platform: 'hw-model' })]) });
    expect(output_ref.id).toBe(2);
    expect(mismatch.platform).toBe('hw-model');
  });

  it('prefers the same configuration over the same platform', () => {
    const outputs = [run(2, { configurations: ['low-light'] }), run(3, { platform: 'hw-model' })];
    expect(matching_output({ output: run(1), batch: batch(outputs) }).output_ref.id).toBe(3);
  });

  it('compares with the reference run whose configuration has the fewest different settings', () => {
    const long = 'conf/a/very/long/path/to/the/default/configuration/of/the/camera.yaml';
    const output = run(1, { configurations: [long, { gain: 4, exposure: 10 }] });
    const outputs = [
      // fewer different characters, but 2 different settings
      run(2, { configurations: [long, { gain: 3, exposure: 11 }] }),
      run(3, { configurations: [long.replace('camera', 'phone'), { gain: 4, exposure: 10 }] }),
    ];
    const { output_ref, mismatch } = matching_output({ output, batch: batch(outputs) });
    expect(output_ref.id).toBe(3);
    expect(mismatch.configurations).toEqual(outputs[1].configurations);
  });

  it('prefers the closest tuning parameters', () => {
    const output = run(1, { extra_parameters: { gain: 4, mode: 'fast' } });
    const outputs = [run(2, { extra_parameters: { gain: 3, mode: 'slow' } }), run(3, { extra_parameters: { gain: 4 } })];
    expect(matching_output({ output, batch: batch(outputs) }).output_ref.id).toBe(3);
  });

  it('breaks ties with the most similar values, and says other reference runs were as close', () => {
    const output = run(1, { configurations: ['base-v1'] });
    const outputs = [run(2, { configurations: ['base-blabla'] }), run(3, { configurations: ['base-v2'] }), run(4, { configurations: ['base-v2'] })];
    const { output_ref, mismatch } = matching_output({ output, batch: batch(outputs) });
    expect(output_ref.id).toBe(3);
    // run 4 has the same configuration as run 3
    expect(mismatch.alternatives).toBe(1);
  });

  it('counts reference runs on other inputs that are as close: two shots with the same metadata.id', () => {
    const output = run(1, { input_path: 'sensor-a/scene.png', test_input_path: 'sensor-a/scene.png', test_input_metadata: { id: 'scene' } });
    const shot = (id, path) => run(id, { input_path: path, test_input_path: path, test_input_metadata: { id: 'scene' } });
    const { output_ref, mismatch, match } = matching_output({ output, batch: batch([shot(2, 'sensor-b/scene-1.png'), shot(3, 'sensor-b/scene-2.png')]) });
    expect(output_ref.id).toBe(2);
    expect(mismatch.alternatives).toBe(1);
    expect(match).toEqual({ by: 'id', others: 1, tied: 1, preferred: false });
  });

  it('says how it matched', () => {
    expect(matching_output({ output: run(1), batch: batch([run(2)]) }).match).toMatchObject({ by: 'input', others: 0, tied: 0 });
    expect(matching_output({ output: run(1), batch: batch([]) }).match).toBeNull();
  });

  const named = (id, path, extra) => run(id, { input_path: `/db/${path}`, test_input_path: path, ...extra });

  it('pairs runs by name, before the same input', () => {
    const output = named(1, 'street_reg05.png');
    const outputs = [named(2, 'street_reg05.png'), named(3, 'street_reg03.png')];
    expect(matching_output({ output, batch: batch(outputs) }).output_ref.id).toBe(2);
    const rules = { pairs: [{ from: 'reg05', to: 'reg03' }], prefer: [], pins: {} };
    const { output_ref, match } = matching_output({ output, batch: batch(outputs), rules });
    expect(output_ref.id).toBe(3);
    expect(match.by).toBe('pair');
  });

  it('prefers reference runs with the facts users picked', () => {
    const outputs = [run(2), run(3, { platform: 'arm' })];
    expect(matching_output({ output: run(1), batch: batch(outputs) }).output_ref.id).toBe(2);
    const rules = { pairs: [], prefer: [{ key: 'platform', value: 'arm' }], pins: {} };
    const { output_ref, match } = matching_output({ output: run(1), batch: batch(outputs), rules });
    expect(output_ref.id).toBe(3);
    expect(match.preferred).toBe(true);
  });

  it('compares with the reference run users picked, if it is still there', () => {
    const outputs = [run(2), run(3, { configurations: ['other'] })];
    expect(matching_output({ output: run(1), batch: batch(outputs), rules: { pairs: [], prefer: [], pins: { 1: '3' } } }))
      .toMatchObject({ output_ref: { id: 3 }, match: { by: 'pin' } });
    expect(matching_output({ output: run(1), batch: batch(outputs), rules: { pairs: [], prefer: [], pins: { 1: '99' } } }).output_ref.id).toBe(2);
  });

  it('lists the reference runs users can pick, similar names last', () => {
    const output = named(1, 'street_reg05.png');
    const outputs = [named(2, 'street_reg03.png'), named(3, 'street_reg05.png', { configurations: ['other'] }), named(4, 'office_reg09.png')];
    expect(reference_candidates({ output, batch: batch(outputs) }).map(c => [c.o.id, c.kind])).toEqual([[3, 'input'], [2, 'similar']]);
  });

  it("doesn't count as tied the reference runs the platform tells apart", () => {
    const output = run(1, { input_path: 'a/scene.png', test_input_path: 'a/scene.png', test_input_metadata: { id: 'scene' } });
    const shot = (id, path, platform = 'linux') => run(id, { input_path: path, test_input_path: path, test_input_metadata: { id: 'scene' }, platform });
    const { output_ref, match } = matching_output({ output, batch: batch([shot(2, 'b/scene-1.png', 'arm'), shot(3, 'b/scene-2.png')]) });
    expect(output_ref.id).toBe(3);
    expect(match.tied).toBe(0);
  });

  it('says a preference picked the reference run only when it changed the pick', () => {
    const rules = { pairs: [], prefer: [{ key: 'platform', value: 'linux' }], pins: {} };
    expect(matching_output({ output: run(1), batch: batch([run(2), run(3, { platform: 'arm' })]), rules }).match.preferred).toBe(false);
  });

  it('matches like the backend without rules in the URL', () => {
    const output = named(1, 'street_reg05.png');
    const outputs = [named(2, 'street_reg03.png'), named(3, 'street_reg05.png', { configurations: ['other'] })];
    expect(matching_output({ output, batch: batch(outputs), rules: rules_from_query({}) }))
      .toEqual(matching_output({ output, batch: batch(outputs) }));
  });

  describe('rules for all the runs like one', () => {
    const rules = (extra = {}) => ({ pairs: [], prefer: [], pins: {}, custom: true, ...extra });
    const candidate = (o, kind) => ({ o, kind });

    it('pairs by name from the run\'s own name, with the rules users have', () => {
      const output = named(1, 'a_reg05_s1.raw');
      const ref = named(2, 'a_reg03_s2.raw');
      const index = index_outputs(batch([ref]));
      const all = rules_for_all({ output, candidate: candidate(ref, 'similar'), current: undefined, rules: rules({ pairs: [{ from: 'reg05', to: 'reg03' }] }), index });
      expect(matching_output({ output, index, rules: all.rules }).output_ref).toBe(ref);
    });

    it('pins instead when no rule would pick the reference run', () => {
      // another input, while one on the same input ranks first: a preference can't pick it
      const output = run(1, { input_path: 'x.raw', test_input_path: 'x.raw', test_input_metadata: { id: 's', sensor: 'a' } });
      const same = run(10, { input_path: 'x.raw', test_input_path: 'x.raw', test_input_metadata: { id: 's', sensor: 'a' } });
      const other = run(11, { input_path: 'y.raw', test_input_path: 'y.raw', test_input_metadata: { id: 's', sensor: 'b' } });
      const index = index_outputs(batch([same, other]));
      expect(rules_for_all({ output, candidate: candidate(other, 'id'), current: same, rules: rules(), index })).toBeNull();
      // an empty part ("/a/b" and "x/a/b"): no rule
      const odd = named(5, '/a/b');
      const ref = named(6, 'x/a/b');
      expect(rules_for_all({ output: odd, candidate: candidate(ref, 'similar'), rules: rules(), index: index_outputs(batch([ref])) })).toBeNull();
    });

    it('prefers what the other reference run has', () => {
      const shot = (id, unit) => run(id, { input_path: `b/${unit}.png`, test_input_path: `b/${unit}.png`, test_input_metadata: { id: 'scene', unit } });
      const output = run(1, { input_path: 'a.png', test_input_path: 'a.png', test_input_metadata: { id: 'scene' } });
      const [one, two] = [shot(2, 1), shot(3, 2)];
      const index = index_outputs(batch([one, two]));
      const all = rules_for_all({ output, candidate: candidate(two, 'id'), current: one, rules: rules(), index });
      expect(all.added.prefer).toEqual([{ key: 'meta:unit', value: '2' }]);
    });
  });
});
