import { describe, it, expect } from 'vitest';
import { export_runs, settings_labels, settings_candidates, default_naming, layout_of, example_name, presets_for, saved_settings, LAYOUTS } from '../plan';
import { file_name } from '../names';

let next_id = 1;
const run = (input, { configurations = ['base'], extra_parameters = {}, platform = 'linux', reference_id } = {}) =>
  ({ id: next_id++, test_input_path: input, configurations, extra_parameters, platform, reference_id });

const batches = (pairs) => {
  const new_outputs = pairs.map(([n]) => n);
  const ref_outputs = pairs.map(([, r]) => r).filter(Boolean);
  new_outputs.forEach((n, i) => { n.reference_id = pairs[i][1]?.id; });
  return {
    new_batch: { filtered: { outputs: new_outputs.map(o => o.id) }, outputs: Object.fromEntries(new_outputs.map(o => [o.id, o])) },
    ref_batch: { outputs: Object.fromEntries(ref_outputs.map(o => [o.id, o])) },
  };
};

const names = (plan, naming = default_naming, file = 'out.png') =>
  plan.items.map(item => file_name(naming.template, item.fields, file, naming.separator));

describe('export names', () => {
  it('uses what the page calls the new and reference results', () => {
    const plan = export_runs({ ...batches([[run('scenes/a.raw'), run('scenes/a.raw')], [run('scenes/b.raw'), run('scenes/b.raw')]]), labels: { new: 'new', reference: 'Release 2.3' } });
    expect(names(plan)).toEqual(['scenes_a__out__new.png', 'scenes_b__out__new.png', 'scenes_a__out__Release_2.3.png', 'scenes_b__out__Release_2.3.png']);
    expect(plan.counts).toEqual({ new: 2, reference: 2, without_reference: 0 });
  });

  it("doesn't say new without a reference", () => {
    const a = run('a.raw');
    a.reference_id = a.id; // the batch compared with itself
    const plan = export_runs({ new_batch: { filtered: { outputs: [a.id] }, outputs: { [a.id]: a } }, ref_batch: { outputs: { [a.id]: a } }, labels: { new: 'new', reference: 'ref' } });
    expect(names(plan)).toEqual(['a__out.png']);
    expect(plan.labels.reference).toBe('');
  });

  it('says the settings that tell runs on the same input apart, only when they share an input', () => {
    const ref = run('a.raw');
    const { new_batch, ref_batch } = batches([
      [run('a.raw', { extra_parameters: { gain: 1, iso: 100 } }), ref],
      [run('a.raw', { extra_parameters: { gain: 2, iso: 100 } }), ref],
      [run('b.raw', { extra_parameters: { gain: 1, iso: 200 } }), null],
    ]);
    const plan = export_runs({ new_batch, ref_batch, labels: { new: 'new', reference: 'ref' } });
    // gain tells runs on a.raw apart, iso only differs between inputs: it's listed, not in names
    expect(plan.candidates).toEqual([
      { key: 'gain', kind: 'parameter', needed: true, values: 2 },
      { key: 'iso', kind: 'parameter', needed: false, values: 2 },
    ]);
    expect(plan.picked).toEqual(['gain']);
    // the reference run is named like each new run it's compared to: files pair up
    expect(names(plan)).toEqual(['a__gain=1__out__new.png', 'a__gain=2__out__new.png', 'b__gain=1__out__new.png', 'a__gain=1__out__ref.png', 'a__gain=2__out__ref.png']);
    expect(plan.counts).toEqual({ new: 3, reference: 1, without_reference: 1 });
    // or once, saying the same settings, with its own values
    const once = export_runs({ new_batch, ref_batch, labels: { new: 'new', reference: 'ref' }, naming: { ...default_naming, pair_references: false } });
    expect(names(once).slice(3)).toEqual(['a__gain=default__out__ref.png']);
    // users pick the settings
    const both = export_runs({ new_batch, ref_batch, labels: {}, naming: { ...default_naming, settings_keys: ['iso', 'gain'] } });
    expect(both.items.slice(0, 3).map(i => i.fields.settings)).toEqual(['gain=1,iso=100', 'gain=2,iso=100', 'gain=1,iso=200']);
    const none = export_runs({ new_batch, ref_batch, labels: {}, naming: { ...default_naming, settings_keys: [] } });
    expect(none.items.map(i => i.fields.settings).every(s => s === '')).toBe(true);
  });

  it('says "default" for runs that do not set a parameter', () => {
    const outputs = [run('a', { extra_parameters: { gain: 4 } }), run('a'), run('a', { extra_parameters: { gain: 4, iso: 100 } })];
    expect([...settings_labels(outputs).values()]).toEqual(['gain=4,iso=default', 'gain=default,iso=default', 'gain=4,iso=100']);
  });

  it('names configurations, nested parameters and platforms briefly, unless that would be ambiguous', () => {
    const outputs = [
      run('a', { configurations: ['base', 'conf/day.yaml', { isp: { awb: { mode: 'auto' } }, denoise: { mode: 1 } }] }),
      run('a', { configurations: ['base', 'conf/night.yaml', { isp: { awb: { mode: 'manual' } }, denoise: { mode: 2 } }] }),
      run('a', { configurations: ['base', { isp: { awb: { mode: 'manual' } }, denoise: { mode: 3 } }] }),
    ];
    expect(settings_candidates(outputs).map(c => c.key)).toEqual(['configurations', 'isp.awb.mode', 'denoise.mode']);
    expect([...settings_labels(outputs).values()]).toEqual(['day,isp.awb.mode=auto,denoise.mode=1', 'night,isp.awb.mode=manual,denoise.mode=2', 'default,isp.awb.mode=manual,denoise.mode=3']);
    const one_key = [run('a', { extra_parameters: { isp: { gain: [1, 2] } } }), run('a', { extra_parameters: { isp: { gain: [1, 3] } } })];
    expect([...settings_labels(one_key).values()]).toEqual(['gain=[1,2]', 'gain=[1,3]']);
    const platforms = [run('a', { platform: 'linux' }), run('a', { platform: 'arm' })];
    expect([...settings_labels(platforms).values()]).toEqual(['linux', 'arm']);
  });

  it('lets users choose how settings show', () => {
    const outputs = [run('a', { extra_parameters: { gain: 1, iso: 5 } }), run('a', { extra_parameters: { gain: 2, iso: 6 } }), run('b', { extra_parameters: { gain: 3, iso: 7 } })];
    const show = naming => [...settings_labels(outputs, { ...default_naming, ...naming }).values()];
    expect(show({ settings_assign: '-', settings_join: '_' })).toEqual(['gain-1_iso-5', 'gain-2_iso-6', 'gain-3_iso-7']);
    expect(show({ settings_assign: '' })).toEqual(['1,5', '2,6', '3,7']);
    const ids = show({ settings_format: 'id' });
    expect(ids.every(id => /^[0-9a-f]{6}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(3);
    // the same id for the same values, whatever the separators
    expect(show({ settings_format: 'id', settings_join: '+' })).toEqual(ids);
    expect(show({ settings_format: 'number' })).toEqual(['s1', 's2', 's3']);
    // runs on different inputs: nothing needed, unless users pick it
    const alone = [run('a', { extra_parameters: { gain: 1 } }), run('b', { extra_parameters: { gain: 2 } })];
    expect([...settings_labels(alone).values()]).toEqual(['', '']);
    expect([...settings_labels(alone, { ...default_naming, settings_keys: ['gain'] }).values()]).toEqual(['gain=1', 'gain=2']);
  });

  it('saves export settings, and lists the presets of a project', () => {
    expect(saved_settings({ ...default_naming, files: '*.png', type: 'copy', folder_name: 'not this', folder_mode: 'path', folder_path: '/x' }))
      .toEqual({ ...default_naming, files: '*.png', type: 'copy', folder_mode: 'path', folder_path: '/x' });
    const presets = [{ name: 'b', project: null }, { name: 'a', project: null }, { name: 'z', project: 'p' }, { name: 'q', project: 'other' }];
    expect(presets_for(presets, 'p').map(p => p.name)).toEqual(['z', 'a', 'b']);
  });

  it('has layouts', () => {
    expect(layout_of(LAYOUTS[1].template, LAYOUTS[1].separator)).toBe('by-side');
    expect(layout_of('{run}_{file}', '_')).toBe('custom');
    const plan = export_runs({ ...batches([[run('x/a.raw'), run('x/a.raw')]]), labels: { new: 'new', reference: 'ref' } });
    const by_side = { ...default_naming, template: LAYOUTS[1].template, separator: LAYOUTS[1].separator };
    expect(names(plan, by_side)).toEqual(['new/x_a__out.png', 'ref/x_a__out.png']);
    expect(example_name(plan.items[0], default_naming, '**/*.png', 'abcdef123456', 'default')).toBe('x_a__file__new.png');
  });
});
