import { matching_output } from '../utils';

const run = (id, extra = {}) => ({
  id,
  input_path: 'photos/facade.png',
  test_input_path: 'photos/facade.png',
  test_input_metadata: {},
  configurations_str: '["base"]',
  extra_parameters_str: '{}',
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
    const outputs = [run(2, { configurations_str: '["low-light"]' }), run(3, { platform: 'hw-model' })];
    expect(matching_output({ output: run(1), batch: batch(outputs) }).output_ref.id).toBe(3);
  });
});
