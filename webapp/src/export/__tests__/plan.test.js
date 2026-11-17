import { describe, it, expect } from 'vitest';
import { export_runs, settings_labels, settings_candidates, default_naming, layout_of, example_name, presets_for, saved_settings, side_separator, with_side_separator, LAYOUTS } from '../plan';
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
      { key: 'gain', kind: 'parameter', needed: true, on_input: true, values: 2 },
      { key: 'iso', kind: 'parameter', needed: false, on_input: false, values: 2 },
    ]);
    expect(plan.picked).toEqual(['gain']);
    // the reference run is named like each new run it's compared to: files pair up
    // ...and only the runs that share their input say it: b.raw has one run
    expect(names(plan)).toEqual(['a__gain=1__out__new.png', 'a__gain=2__out__new.png', 'b__out__new.png', 'a__gain=1__out__ref.png', 'a__gain=2__out__ref.png']);
    // or every name says it, for scripts that expect the same fields everywhere
    const everywhere = export_runs({ new_batch, ref_batch, labels: { new: 'new', reference: 'ref' }, naming: { ...default_naming, settings_where: 'all' } });
    expect(names(everywhere).slice(0, 3)).toEqual(['a__gain=1__out__new.png', 'a__gain=2__out__new.png', 'b__gain=1__out__new.png']);
    expect(plan.counts).toEqual({ new: 3, reference: 1, without_reference: 1 });
    // or once, saying the same settings, with its own values
    const once = export_runs({ new_batch, ref_batch, labels: { new: 'new', reference: 'ref' }, naming: { ...default_naming, pair_references: false } });
    expect(names(once).slice(3)).toEqual(['a__out__ref.png']);
    // users pick the settings
    const both = export_runs({ new_batch, ref_batch, labels: {}, naming: { ...default_naming, settings_keys: ['iso', 'gain'] } });
    // gain where runs share an input; iso only differs between inputs, so every run says it
    expect(both.items.slice(0, 3).map(i => i.fields.settings)).toEqual(['gain=1,iso=100', 'gain=2,iso=100', 'iso=200']);
    const both_everywhere = export_runs({ new_batch, ref_batch, labels: {}, naming: { ...default_naming, settings_keys: ['iso', 'gain'], settings_where: 'all' } });
    expect(both_everywhere.items.slice(0, 3).map(i => i.fields.settings)).toEqual(['gain=1,iso=100', 'gain=2,iso=100', 'gain=1,iso=200']);
    const none = export_runs({ new_batch, ref_batch, labels: {}, naming: { ...default_naming, settings_keys: [] } });
    expect(none.items.map(i => i.fields.settings).every(s => s === '')).toBe(true);
  });

  it('says only the fewest settings that tell runs on the same input apart', () => {
    // runs of 3 batches of qaboard.yaml on the same image, configured and run differently: the batch is enough
    const outputs = [
      run('a', { configurations: ['base'], platform: 'linux' }), run('a', { configurations: ['base', 'low-light'], platform: 'linux' }), run('a', { configurations: ['base'], platform: 'hw-model' }),
    ];
    ['ci', 'night', 'bitexact'].forEach((batch, i) => { outputs[i].data = { batch }; });
    const candidates = settings_candidates(outputs);
    expect(candidates.map(c => [c.key, c.needed, c.on_input])).toEqual([['batch', true, true], ['configurations', false, true], ['platform', false, true]]);
    expect([...settings_labels(outputs).values()]).toEqual(['ci', 'night', 'bitexact']);
    // a 2x2 sweep needs both parameters
    const sweep = [[1, 1], [1, 2], [2, 1], [2, 2]].map(([gain, iso]) => run('a', { extra_parameters: { gain, iso } }));
    expect([...settings_labels(sweep).values()]).toEqual(['gain=1,iso=1', 'gain=1,iso=2', 'gain=2,iso=1', 'gain=2,iso=2']);
  });

  it('leaves parameters out of the names of the runs that do not set them, or says "default"', () => {
    const outputs = [run('a', { extra_parameters: { gain: 4 } }), run('a'), run('a', { extra_parameters: { gain: 4, iso: 100 } })];
    expect([...settings_labels(outputs).values()]).toEqual(['gain=4', '', 'gain=4,iso=100']);
    expect([...settings_labels(outputs, { ...default_naming, settings_where: 'all' }).values()]).toEqual(['gain=4,iso=default', 'gain=default,iso=default', 'gain=4,iso=100']);
    // values without their names need a place for each: "default"
    expect([...settings_labels(outputs, { ...default_naming, settings_assign: '' }).values()]).toEqual(['4,default', 'default,default', '4,100']);
  });

  it('says a setting only for the runs that need it: one image with a non-standard crop', () => {
    // 3 images; one ran twice, with and without a crop
    const outputs = [run('a.raw'), run('b.raw'), run('c.raw'), run('c.raw', { extra_parameters: { crop: 'center' } })];
    const batch = { filtered: { outputs: outputs.map(o => o.id) }, outputs: Object.fromEntries(outputs.map(o => [o.id, o])) };
    const plan = export_runs({ new_batch: batch, ref_batch: { outputs: {} } });
    expect(plan.picked).toEqual(['crop']);
    expect(names(plan)).toEqual(['a__out.png', 'b__out.png', 'c__out.png', 'c__crop=center__out.png']);
    // short ids and numbers too
    expect(export_runs({ new_batch: batch, ref_batch: { outputs: {} }, naming: { ...default_naming, settings_format: 'number' } }).items.map(i => i.fields.settings)).toEqual(['', '', '', 's1']);
  });

  it('exports one side alone, named like a page without a reference', () => {
    const ref = run('a.raw');
    const { new_batch, ref_batch } = batches([
      [run('a.raw', { extra_parameters: { gain: 1 } }), ref],
      [run('a.raw', { extra_parameters: { gain: 2 } }), ref],
      [run('b.raw'), run('b.raw')],
    ]);
    const labels = { new: 'new', reference: 'v1' };
    const only_new = export_runs({ new_batch, ref_batch, labels, sides: 'new' });
    expect(names(only_new)).toEqual(['a__gain=1__out.png', 'a__gain=2__out.png', 'b__out.png']);
    expect(only_new).toMatchObject({ has_reference: true, both: false, side: 'new', labels: { new: '', reference: '' } });
    // the reference runs, once each, with their own settings: here they don't differ
    const only_ref = export_runs({ new_batch, ref_batch, labels, sides: 'reference', regions: new Map([[new_batch.filtered.outputs[0], [{ name: 'face' }]]]) });
    expect(names(only_ref)).toEqual(['a__out.png', 'b__out.png']);
    expect(only_ref.items.map(i => [i.side, i.id, i.regions?.[0].name])).toEqual([['reference', ref.id, 'face'], ['reference', ref_batch.outputs[new_batch.outputs[new_batch.filtered.outputs[2]].reference_id].id, undefined]]);
    expect(only_ref.counts).toEqual({ new: 3, reference: 2, without_reference: 0 });
    // without a reference on the page, it's the new runs
    expect(export_runs({ new_batch, ref_batch: { outputs: {} }, sides: 'reference' }).items.every(i => i.side === 'new')).toBe(true);
    // users can still name the side exported, e.g. after the tuning batch
    const named = export_runs({ new_batch, ref_batch, labels: { ...labels, alone: 'tuning-gain' }, sides: 'new' });
    expect(names(named)).toEqual(['a__gain=1__out__tuning-gain.png', 'a__gain=2__out__tuning-gain.png', 'b__out__tuning-gain.png']);
    expect(named.labels).toEqual({ new: 'tuning-gain', reference: '' });
    const named_ref = export_runs({ new_batch, ref_batch, labels: { ...labels, alone: 'v1' }, sides: 'reference' });
    expect(names(named_ref)).toEqual(['a__out__v1.png', 'b__out__v1.png']);
    expect(named_ref.labels).toEqual({ new: '', reference: 'v1' });
    // a batch without a reference too
    const alone = export_runs({ new_batch, ref_batch: { outputs: {} }, labels: { alone: 'tuning-gain' } });
    expect(alone.items.every(i => i.fields.side === 'tuning-gain')).toBe(true);
  });

  it('puts what users want before new or reference, e.g. @', () => {
    const flat = LAYOUTS[0].template;
    expect(side_separator(flat)).toBe('__');
    const at = with_side_separator(flat, '@');
    expect(at).toBe('{input}__{settings}__{file}__{region}@{side}');
    expect(layout_of(at, '_')).toBe('flat');
    const plan = export_runs({ ...batches([[run('x/a.raw'), run('x/a.raw')]]), labels: { new: 'new', reference: 'ref' } });
    expect(names(plan, { ...default_naming, template: at })).toEqual(['x_a__out@new.png', 'x_a__out@ref.png']);
    // one side alone: nothing to separate
    const alone = export_runs({ ...batches([[run('x/a.raw'), null]]) });
    expect(names(alone, { ...default_naming, template: at })).toEqual(['x_a__out.png']);
    // a folder per side has no separator
    expect(side_separator(LAYOUTS[1].template)).toBe(null);
    expect(with_side_separator(LAYOUTS[1].template, '@')).toBe(LAYOUTS[1].template);
  });

  it('names configurations, nested parameters and platforms briefly, unless that would be ambiguous', () => {
    const outputs = [
      run('a', { configurations: ['base', 'conf/day.yaml', { isp: { awb: { mode: 'auto' } }, denoise: { mode: 1 } }] }),
      run('a', { configurations: ['base', 'conf/night.yaml', { isp: { awb: { mode: 'manual' } }, denoise: { mode: 2 } }] }),
      run('a', { configurations: ['base', { isp: { awb: { mode: 'manual' } }, denoise: { mode: 3 } }] }),
    ];
    expect(settings_candidates(outputs).map(c => c.key)).toEqual(['configurations', 'isp.awb.mode', 'denoise.mode']);
    // the configurations tell them apart already
    expect([...settings_labels(outputs).values()]).toEqual(['day', 'night', 'default']);
    const all = { ...default_naming, settings_keys: ['configurations', 'isp.awb.mode', 'denoise.mode'] };
    expect([...settings_labels(outputs, all).values()]).toEqual(['day,isp.awb.mode=auto,denoise.mode=1', 'night,isp.awb.mode=manual,denoise.mode=2', 'default,isp.awb.mode=manual,denoise.mode=3']);
    const one_key = [run('a', { extra_parameters: { isp: { gain: [1, 2] } } }), run('a', { extra_parameters: { isp: { gain: [1, 3] } } })];
    expect([...settings_labels(one_key).values()]).toEqual(['gain=[1,2]', 'gain=[1,3]']);
    const platforms = [run('a', { platform: 'linux' }), run('a', { platform: 'arm' })];
    expect([...settings_labels(platforms).values()]).toEqual(['linux', 'arm']);
  });

  it('lets users choose how settings show', () => {
    const outputs = [run('a', { extra_parameters: { gain: 1, iso: 5 } }), run('a', { extra_parameters: { gain: 2, iso: 6 } }), run('b', { extra_parameters: { gain: 3, iso: 7 } })];
    const show = naming => [...settings_labels(outputs, { ...default_naming, settings_keys: ['gain', 'iso'], settings_where: 'all', ...naming }).values()];
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

describe('crops and presets', () => {
  it('names regions after their labels, else their source and rank, uniquely', async () => {
    const { crop_regions, QUARTERS } = await import('../plan');
    const regions = crop_regions([
      ['presets', [{ x: 0, y: 0, w: 10, h: 10, label: 'Face', imageWidth: 100, imageHeight: 50 }, { x: 1, y: 1, w: 2, h: 2 }, { x: 1, y: 1, w: 2, h: 2, label: 'face' }]],
      // labels of differences say how much images differ: not names
      ['auto-yiq', [{ x: 5, y: 5, w: 4, h: 4, label: '#1 · 3.2%' }, { x: 0, y: 0, w: 0, h: 4 }], 'out.png'],
      ['quarters', QUARTERS.slice(0, 1)],
    ]);
    expect(regions.map(r => r.name)).toEqual(['Face', 'roi-02', 'face-2', 'diff-01', 'top-left']);
    expect(regions[0]).toEqual({ name: 'Face', x: 0, y: 0, w: 10, h: 10, image_width: 100, image_height: 50, label: 'Face', source: 'presets' });
    expect(regions[3]).toMatchObject({ file: 'out.png', source: 'auto-yiq' });
  });

  it('gives references the regions of the new runs they are compared to', () => {
    const { new_batch, ref_batch } = batches([[run('a.raw'), run('a.raw')]]);
    const id = new_batch.filtered.outputs[0];
    const plan = export_runs({ new_batch, ref_batch, regions: new Map([[id, [{ name: 'face', x: 0, y: 0, w: 1, h: 1 }]]]) });
    expect(plan.items.map(i => i.regions?.[0]?.name)).toEqual(['face', 'face']);
  });

  it("disables presets that would give runs the same names, and says what's unused", async () => {
    const { preset_fit } = await import('../plan');
    const { new_batch, ref_batch } = batches([
      [run('a.raw', { extra_parameters: { gain: 1 } }), null],
      [run('a.raw', { extra_parameters: { gain: 2 } }), null],
    ]);
    expect(preset_fit({ settings_keys: ['iso'] }, { new_batch, ref_batch }))
      .toEqual({ disabled: "Runs would get the same names: they don't say gain", notes: ["These runs don't differ by iso: names won't say it"] });
    expect(preset_fit({}, { new_batch, ref_batch }).disabled).toBe(null);
  });

  it('colors names by field: each part says which field it comes from', async () => {
    const { file_name_parts } = await import('../names');
    const parts = file_name_parts('{side}/{input}__{settings}__{file}__{region}', { side: 'new', input: 'x/a', settings: '' }, 'out.png', '_', true, false);
    expect(parts).toEqual([
      { text: 'new', field: 'side' }, { text: '/', field: null, folder: true }, { text: 'x_a', field: 'input' }, { text: '.png', field: null },
    ]);
  });
});
