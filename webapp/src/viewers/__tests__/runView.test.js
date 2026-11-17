import { describe, it, expect } from 'vitest';

import { has_run_view, is_visualization_shown, run_shown, run_view } from '../runView';
import { presetRegions } from '../images/regionProviders';
import { config_tokens, configurationSummary } from '../../configurations/tokens';


const visualizations = [{ name: 'Output' }, { name: 'Histogram', default_hidden: true }, { name: 'Debug', default_hidden: true }];

describe('run_view', () => {
  it("merges the input's metadata, then the configurations in order: the last wins, regions add up", () => {
    const output = {
      test_input_metadata: { roi: [{ x: 0, y: 0, w: 1, h: 1, label: 'input' }], view: { show: ['Output'], images: { mode: 'wipe', analysis: 'stats' } } },
      configurations: [
        'base',
        { view: { show: ['Histogram'], images: { analysis: 'profiles', roi: [{ x: 1, y: 1, w: 1, h: 1, label: 'batch' }] } } },
        { roi: [{ x: 2, y: 2, w: 1, h: 1, label: 'legacy' }] },
      ],
    };
    const view = run_view(output);
    expect(view.show).toEqual(['Histogram']);
    expect(view.images).toMatchObject({ mode: 'wipe', analysis: 'profiles' });
    expect(view.images.roi.map(r => r.label)).toEqual(['input', 'batch', 'legacy']);
    expect(presetRegions(output).map(r => r.label)).toEqual(['input', 'batch', 'legacy']);
    expect(has_run_view(output)).toBe(true);
  });

  it('is empty for runs that ask nothing, and regions alone are not a view', () => {
    expect(run_view({ configurations: ['base'] })).toEqual({ images: { roi: [] } });
    expect(run_view(undefined).images.roi).toEqual([]);
    expect(has_run_view({ configurations: [{ roi: [{ x: 0, y: 0, w: 1, h: 1 }] }] })).toBe(false);
  });

  it("leaves a project's own `view` parameter alone", () => {
    const output = { configurations: [{ view: 'left' }], extra_parameters: {} };
    expect(has_run_view(output)).toBe(false);
    expect(configurationSummary(output)).toBe('view: "left"');
    expect(config_tokens(output.configurations).map(t => t.key)).toEqual(['view']);
    // the hint is not a setting
    const hinted = { configurations: ['base', { view: { show: ['Histogram'] }, gain: 2 }], extra_parameters: {} };
    expect(configurationSummary(hinted)).toBe('base · gain: 2');
    expect(config_tokens(hinted.configurations).map(t => t.key ?? t.text)).toEqual(['base', 'gain']);
  });
});

describe('which visualizations a run shows', () => {
  const run = { configurations: [{ view: { show: ['Histogram', 'Not in qaboard.yaml'] } }] };
  const shown = (output, controls) => visualizations
    .filter(view => is_visualization_shown(view, controls, run_shown(output, visualizations)))
    .map(view => view.name);
  // like controls_defaults: the project's defaults are in controls.show
  const defaults = { show: { Histogram: false, Debug: false } };

  it("shows what the run asks for, instead of the project's defaults", () => {
    expect(shown({ configurations: [] }, defaults)).toEqual(['Output']);
    expect(shown(run, defaults)).toEqual(['Histogram']);
  });

  it('lets what users chose win, for all runs', () => {
    expect(shown(run, { show: { ...defaults.show, Debug: true } })).toEqual(['Histogram', 'Debug']);
    expect(shown(run, { show: { ...defaults.show, Output: false, Histogram: true } })).toEqual(['Histogram']);
    expect(shown(run, { ...defaults, run_views: false })).toEqual(['Output']);
  });

  it("ignores a run that names no visualization of the project", () => {
    expect(shown({ configurations: [{ view: { show: ['Typo'] } }] }, defaults)).toEqual(['Output']);
  });
});
