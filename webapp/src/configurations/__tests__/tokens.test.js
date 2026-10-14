import {
  config_tokens, diff_configurations, config_distance, string_change, shared_configuration, summarize_changes, count_changes,
} from '../tokens';

const describe_ops = ops => ops.map(({ op, token, ref }) =>
  `${op} ${token.key ? `${token.key}=` : ''}${op === 'changed' ? `${ref.text}>` : ''}${token.text}`);

describe('config_tokens', () => {
  it('has a setting per string and per leaf of objects, without the keys viewers use', () => {
    const tokens = config_tokens(['base', { gain: 4, isp: { awb: 'auto', nr: [1, 2] }, roi: [0, 0, 1, 1], empty: {} }]);
    expect(tokens.map(t => [t.kind, t.key, t.text])).toEqual([
      ['string', null, 'base'],
      ['param', 'gain', '4'],
      ['param', 'isp.awb', '"auto"'],
      ['param', 'isp.nr', '[1,2]'],
      ['param', 'empty', '{}'],
    ]);
  });

  it('gives the same tokens to equal configurations', () => {
    expect(config_tokens(['base', { gain: 4 }])).toBe(config_tokens(['base', { gain: 4 }]));
    expect(config_tokens(null)).toEqual([]);
  });
});

describe('diff_configurations', () => {
  it('says which settings were added, removed or changed, in order', () => {
    const ops = diff_configurations(
      ['base', 'conf/night.yaml', { gain: 4, isp: { awb: 'auto', nr: 2 } }],
      ['base', 'conf/day.yaml', { gain: 3, isp: { awb: 'auto' } }, 'debug'],
    );
    expect(describe_ops(ops)).toEqual([
      'same base',
      'changed conf/day.yaml>conf/night.yaml',
      'changed gain=3>4',
      'same isp.awb="auto"',
      'removed debug',
      'added isp.nr=2',
    ]);
    expect(count_changes(ops)).toEqual({ added: 1, removed: 1, changed: 2 });
  });

  it("doesn't pair strings that have nothing in common", () => {
    expect(describe_ops(diff_configurations(['base', 'hdr'], ['base', 'low-light']))).toEqual(['same base', 'removed low-light', 'added hdr']);
  });

  it('handles empty and huge configurations', () => {
    expect(describe_ops(diff_configurations(['a'], []))).toEqual(['added a']);
    const huge = Array.from({ length: 3000 }, (_, i) => ({ [`k${i}`]: i }));
    const ops = diff_configurations([...huge, { k5: 'new' }], huge.toReversed());
    expect(ops.filter(d => d.op === 'same').length).toBeGreaterThan(0);
  });
});

describe('string_change', () => {
  it('cuts at separators', () => {
    expect(string_change('conf/day.yaml', 'conf/dusk.yaml')).toEqual({ prefix: 'conf/', before: 'day', after: 'dusk', suffix: '.yaml' });
    expect(string_change('gain=10', 'gain=12')).toEqual({ prefix: 'gain=', before: '10', after: '12', suffix: '' });
    expect(string_change('a.yaml', 'a.v2.yaml')).toEqual({ prefix: 'a.', before: '', after: 'v2.', suffix: 'yaml' });
  });
});

describe('config_distance', () => {
  it('counts different settings, a changed value as one', () => {
    expect(config_distance(['a', { g: 1 }], ['a', { g: 1 }])).toBe(0);
    expect(config_distance(['a', { g: 1 }], ['a', { g: 2 }])).toBe(1);
    expect(config_distance(['a'], ['a', 'b'])).toBe(1);
    expect(config_distance(['a', 'b'], ['b', 'a'])).toBe(0.5);
    expect(config_distance({ g: 1, h: 2 }, {})).toBe(2);
  });
});

const outputs = configurations => Object.fromEntries(configurations.map((configurations, id) => [id, { id, configurations }]));

describe('shared_configuration', () => {
  it('finds the settings all runs share, worth hiding when there are enough', () => {
    const shared = shared_configuration(outputs([
      ['base', 'conf/camera.yaml', { gain: 4, mode: 'fast' }],
      ['base', 'conf/camera.yaml', { gain: 3, mode: 'fast' }],
    ]));
    expect(shared.tokens.map(t => t.text)).toEqual(['base', 'conf/camera.yaml', '"fast"']);
    expect(shared).toMatchObject({ runs: 2, varies: true, collapse: true });
  });

  it("doesn't hide a few short settings, nor a single run's", () => {
    expect(shared_configuration(outputs([['base', 'a'], ['base', 'b']]))).toMatchObject({ collapse: false });
    expect(shared_configuration(outputs([['base', 'conf/camera.yaml', { gain: 4 }]]))).toBeNull();
  });

  it('hides long settings even if there are few', () => {
    const long = 'configurations/projects/camera/defaults/v2.yaml';
    expect(shared_configuration(outputs([[long], [long]]))).toMatchObject({ collapse: true, varies: false });
  });
});

describe('summarize_changes', () => {
  it('counts the runs with each change', () => {
    const changes = summarize_changes([
      [['a', { g: 2 }], ['a', { g: 1 }]],
      [['b', { g: 2 }], ['b', { g: 1 }]],
      [['c', { g: 2 }, 'x'], ['c', { g: 2 }]],
    ]);
    expect(changes.map(c => [c.op, c.token.text, c.runs])).toEqual([['changed', '2', 2], ['added', 'x', 1]]);
  });
});
