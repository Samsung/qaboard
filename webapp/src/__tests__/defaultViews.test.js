/**
 * The view commit pages open on when qaboard.yaml doesn't choose one.
 * Run with: cd webapp && npm test -- defaultViews
 */
import { automatic_default_view, batch_facts, default_views_of, has_result_metrics } from '../defaultViews';

const run = (metrics, extra = {}) => ({ metrics, ...extra });
const view_of = ({ config_outputs = {}, outputs }) => automatic_default_view(batch_facts({ config_outputs, outputs }));

describe('the default view', () => {
  it('opens the visualizations when the project has some, even with metrics', () => {
    expect(view_of({ config_outputs: { visualizations: [{ path: 'out.png' }] }, outputs: { 1: run({ psnr: 30 }) } })).toBe('output-list');
    // older projects named them detailed_views
    expect(view_of({ config_outputs: { detailed_views: [{ path: 'out.png' }] }, outputs: { 1: run({}) } })).toBe('output-list');
    // runs started from code show what they logged
    expect(view_of({ outputs: { 1: run({ compute_time: 3 }, { data: { sdk: true } }) } })).toBe('output-list');
  });

  it('opens the metrics without visualizations, but not for their compute time alone', () => {
    expect(view_of({ outputs: { 1: run({ psnr: 30, compute_time: 3 }) } })).toBe('summary');
    expect(view_of({ outputs: { 1: run({ compute_time: 3, is_failed: false }) } })).toBe('bit-accuracy');
    expect(view_of({ outputs: { 1: run({}) } })).toBe('bit-accuracy');
  });

  it('opens the logs when every run failed', () => {
    const outputs = { 1: run({}, { is_failed: true }), 2: run({ psnr: 1 }, { is_failed: true }) };
    expect(view_of({ config_outputs: { visualizations: [{ path: 'out.png' }] }, outputs })).toBe('logs');
    // not while others still run
    expect(batch_facts({ config_outputs: {}, outputs: { ...outputs, 3: run({}, { is_pending: true }) } }).all_failed).toBe(false);
  });

  it('knows enough to settle once a run succeeded or all finished', () => {
    expect(batch_facts({ outputs: {} }).ready).toBe(false);
    expect(batch_facts({ outputs: { 1: run({}, { is_pending: true }) } }).ready).toBe(false);
    expect(batch_facts({ outputs: { 1: run({}, { is_pending: true }), 2: run({ psnr: 1 }) } }).ready).toBe(true);
    expect(batch_facts({ outputs: { 1: run({}, { is_failed: true }) } }).ready).toBe(true);
  });

  it("uses qaboard.yaml's choice", () => {
    expect(default_views_of('output_list', 'summary')).toEqual(['output-list']);
    expect(default_views_of(['summary', 'bit_accuracy'], 'logs')).toEqual(['summary', 'bit-accuracy']);
    expect(default_views_of(undefined, 'bit-accuracy')).toEqual(['bit-accuracy']);
  });

  it('tells result metrics from those every run has', () => {
    expect(has_result_metrics(new Set(['compute_time', 'is_failed', '.hidden']))).toBe(false);
    expect(has_result_metrics(new Set(['compute_time', 'loss']))).toBe(true);
    expect(has_result_metrics(undefined)).toBe(false);
  });
});
