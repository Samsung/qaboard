// The run cards' reference tags: the user guide lists them (website/docs/user-guide/reference-runs.mdx#pick-another)
import { describe_match } from '../ReferenceMatchTag';
import { index_outputs } from '../match';

const run = (id, test_input_path, test_input_metadata = {}) => ({ id, test_input_path, input_path: `/db/${test_input_path}`, test_input_metadata, configurations: [], extra_parameters: {}, platform: 'linux' });
const lookup = outputs => index_outputs({ outputs: Object.fromEntries(outputs.map(o => [o.id, o])) });
const rules = { pairs: [], prefer: [], pins: {} };

describe('reference tags', () => {
  it('says nothing in the usual case', () => {
    expect(describe_match(run(1, 'a.png'), { by: 'input', others: 0, tied: 0 }, run(2, 'a.png'), lookup([]), rules)).toBeNull();
  });

  it('is amber only when there is nothing to compare with', () => {
    expect(describe_match(run(1, 'night/x.png'), null, undefined, lookup([run(2, 'a.png')]), rules)).toMatchObject({ text: 'no reference', intent: 'warning' });
    expect(describe_match(run(1, 'a_05.png'), null, undefined, lookup([run(2, 'a_03.png')]), rules)).toMatchObject({ text: 'no reference · 1 similar', quiet: true, clickable: true });
  });

  it('says how other inputs were found, and when there is a choice', () => {
    const output = run(1, 'imx766/a.png', { id: 'a' });
    expect(describe_match(output, { by: 'id', others: 0, tied: 0 }, run(2, 'imx586/a.png'), lookup([]), rules).text).toBe('≈ a');
    expect(describe_match(output, { by: 'id', others: 2, tied: 0 }, run(2, 'imx586/a.png'), lookup([]), rules).text).toBe('≈ a · 3');
    expect(describe_match(run(1, 'a_reg05.png'), { by: 'pair', others: 0, tied: 0 }, run(2, 'a_reg03.png'), lookup([]), rules).text).toBe('↔ a_reg03');
    expect(describe_match(output, { by: 'id', others: 1, tied: 1 }, run(2, 'imx586/a.png'), lookup([]), rules)).toMatchObject({ text: '1 of 2', quiet: true });
    expect(describe_match(output, { by: 'pin' }, run(2, 'imx586/a.png'), lookup([]), rules).text).toBe('picked by you');
  });
});
