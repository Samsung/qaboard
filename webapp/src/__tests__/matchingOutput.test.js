import { matching_output } from '../utils';

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
});
