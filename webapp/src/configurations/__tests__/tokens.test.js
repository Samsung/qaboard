import {
  config_tokens, diff_configurations, diff_tokens, config_distance, string_change, shared_configuration, summarize_changes, count_changes,
  run_tokens, output_tokens, reference_tokens, value_separator,
} from '../tokens';
import distances from '../../../../tests/fixtures/config-distance.json';

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
  // qaboard/matching.py has a port of config_distance, for the CLI and the server: they must pick the same reference runs
  it('gives the distances the Python port is tested against (tests/fixtures/config-distance.json)', () => {
    for (const { a, b, distance } of distances) expect(config_distance(a, b)).toBe(distance);
  });

  it('counts different settings, a changed value or a replaced string as one', () => {
    expect(config_distance(['a', { g: 1 }], ['a', { g: 1 }])).toBe(0);
    expect(Math.floor(config_distance(['a', { g: 1 }], ['a', { g: 2 }]))).toBe(1);
    expect(Math.floor(config_distance(['a'], ['a', 'b']))).toBe(1);
    expect(Math.floor(config_distance(['a', 'x.yaml'], ['a', 'y.yaml']))).toBe(1);
    expect(config_distance(['a', 'b'], ['b', 'a'])).toBe(0.5);
    expect(Math.floor(config_distance({ g: 1, h: 2 }, {}))).toBe(2);
  });

  it('breaks ties with how similar the values are', () => {
    const run = ['base-v1'];
    expect(config_distance(run, ['base-v2'])).toBeLessThan(config_distance(run, ['blabla']));
    expect(config_distance([{ gain: 3 }], [{ gain: 4 }])).toBeLessThan(config_distance([{ gain: 3 }], [{ gain: 100 }]));
    // but never over the number of different settings
    expect(config_distance(run, ['blabla'])).toBeLessThan(config_distance(['base-v1', 'a'], ['base-v1', 'b', 'c']));
  });
});

describe('run_tokens', () => {
  it('has the tuning parameters last, apart from the configuration', () => {
    const tokens = run_tokens(['base', { gain: 4 }], { gain: 5 });
    expect(tokens.map(t => [t.source, t.key ?? t.text, t.text])).toEqual([
      ['config', 'base', 'base'], ['config', 'gain', '4'], ['tuning', 'gain', '5'],
    ]);
    expect(run_tokens(['base'], {})).toBe(config_tokens(['base']));
  });

  it("compares them with the reference's", () => {
    const output = { configurations: ['base'], extra_parameters: { gain: 5 }, reference_mismatch: { configurations: null, extra_parameters: { gain: 4 } } };
    expect(describe_ops(diff_tokens(output_tokens(output), reference_tokens(output)))).toEqual(['same base', 'changed gain=4>5']);
    expect(reference_tokens({ ...output, reference_mismatch: { platform: 'arm' } })).toBeNull();
  });
});

const outputs = list => list.map(([configurations, extra_parameters], id) => ({ id, configurations, extra_parameters }));

describe('shared_configuration', () => {
  it('finds the settings all runs share, worth hiding when there are enough', () => {
    const shared = shared_configuration(outputs([
      [['base', 'conf/camera.yaml', { gain: 4, mode: 'fast' }], { nr: 1 }],
      [['base', 'conf/camera.yaml', { gain: 3, mode: 'fast' }], { nr: 1 }],
    ]));
    expect(shared.tokens.map(t => t.text)).toEqual(['base', 'conf/camera.yaml', '"fast"', '1']);
    expect(shared).toMatchObject({ runs: 2, varies: true, collapse: true });
  });

  it('is the same object for the same result', () => {
    const configurations = [[['base', 'a', 'b', 'c']], [['base', 'a', 'b', 'd']]];
    expect(shared_configuration(outputs(configurations))).toBe(shared_configuration(outputs(configurations)));
  });

  it("doesn't hide a few short settings, nor a single run's", () => {
    expect(shared_configuration(outputs([[['base', 'a']], [['base', 'b']]]))).toMatchObject({ collapse: false });
    expect(shared_configuration(outputs([[['base', 'conf/camera.yaml', { gain: 4 }]]]))).toBeNull();
  });

  it('hides long settings even if there are few', () => {
    const long = 'configurations/projects/camera/defaults/v2.yaml';
    expect(shared_configuration(outputs([[[long]], [[long]]]))).toMatchObject({ collapse: true, varies: false });
  });

  it("elides the long prefix of strings that vary, keeping their last folder", () => {
    const { elided } = shared_configuration(outputs([
      [['conf/projects/camera/scenes/night.yaml']], [['conf/projects/camera/scenes/day.yaml']], [['short/a']], [['short/b']],
    ]));
    const night = 'conf/projects/camera/scenes/night.yaml';
    expect(night.slice(elided.get(night))).toBe('scenes/night.yaml');
    expect(elided.has('short/a')).toBe(false);
  });
});

describe('summarize_changes', () => {
  it('counts the runs with each change', () => {
    const changes = summarize_changes([
      [run_tokens(['a', { g: 2 }]), run_tokens(['a', { g: 1 }])],
      [run_tokens(['b', { g: 2 }]), run_tokens(['b', { g: 1 }])],
      [run_tokens(['c', { g: 2 }, 'x']), run_tokens(['c', { g: 2 }])],
    ]);
    expect(changes.map(c => [c.op, c.token.text, c.runs])).toEqual([['changed', '2', 2], ['added', 'x', 1]]);
  });
});

describe('lists', () => {
  it('keeps lists of values as one setting, shown as people write them', () => {
    const [ccm] = config_tokens([{ ccm: [[1, 0], [0, 1.5]] }]);
    expect(ccm).toMatchObject({ key: 'ccm', text: '[[1,0],[0,1.5]]', display: '[[1, 0], [0, 1.5]]' });
  });

  it('has a setting per leaf of lists of objects, so that their changes show', () => {
    const layers = [{ type: 'conv', stride: 1 }, { type: 'pool' }];
    expect(config_tokens([{ layers, tags: ['a', 'b'] }]).map(t => `${t.key}=${t.text}`))
      .toEqual(['layers[0].type="conv"', 'layers[0].stride=1', 'layers[1].type="pool"', 'tags=["a","b"]']);
    const ops = diff_configurations([{ layers: [layers[0], { type: 'pool', size: 2 }] }], [{ layers }]);
    expect(describe_ops(ops)).toEqual(['same layers[0].type="conv"', 'same layers[0].stride=1', 'same layers[1].type="pool"', 'added layers[1].size=2']);
  });

  it("ignores empty objects, but not empty lists", () => {
    expect(config_tokens([{}, { a: [] }]).map(t => t.display)).toEqual(['[]']);
  });
});

describe('string_change in values', () => {
  it('keeps numbers whole', () => {
    expect(string_change('[0.7, 1]', '[0.635, 1]', value_separator)).toEqual({ prefix: '[', before: '0.7', after: '0.635', suffix: ', 1]' });
    expect(string_change('-0.5', '-0.25', value_separator)).toMatchObject({ before: '-0.5', after: '-0.25' });
  });
});
