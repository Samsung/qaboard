/**
 * The Tuning Analysis view of an automated tuning. The batches come from webapp/e2e/fixtures/make_tuning.py.
 * Run with: cd webapp && npm test -- OptimizationReport
 */
import { screen, fireEvent, within, act } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import batches from '../../../../e2e/fixtures/tuning.json';
import TuningExploration from '../TuningExploration';
import { history } from '../../../router';
import { renderWithProviders } from '../../../test-utils';
import { usePrefsStore } from '../../../stores/prefs';

const plots = [];
vi.mock('../../Plot', () => ({ default: ({ data, layout }) => { plots.push({ data, layout }); return <div data-testid="plot"/>; } }));

const available_metrics = {
  map: { key: 'map', label: 'mAP', short_label: 'mAP', scale: 1, suffix: '', smaller_is_better: false },
  ap_small: { key: 'ap_small', label: 'AP small objects', short_label: 'AP small', scale: 1, suffix: '', smaller_is_better: false },
  model_mb: { key: 'model_mb', label: 'Model size', short_label: 'size', scale: 1, suffix: ' MB', smaller_is_better: true },
};

// what the commit page's selectors give TuningExploration (selectors/batches.js)
const as_page_batch = label => {
  const batch = batches[label];
  const outputs = Object.fromEntries(Object.entries(batch.outputs).map(([id, o]) => [id, { ...o, params: o.extra_parameters }]));
  const iterations = Object.values(outputs).filter(o => o.output_type === 'optim_iteration');
  const extra_parameters = {};
  for (const o of iterations)
    for (const [k, v] of Object.entries(o.params)) (extra_parameters[k] ??= new Set()).add(v);
  return {
    ...batch, outputs,
    filtered: { outputs: Object.keys(outputs) },
    extra_parameters,
    sorted_extra_parameters: Object.keys(extra_parameters),
  };
};

const show = (label, { data = {}, metrics = available_metrics } = {}) => {
  const batch = as_page_batch(label);
  return renderWithProviders(<HistoryRouter history={history}>
    <TuningExploration batch={{ ...batch, data: { ...batch.data, ...data } }} project="kitefin/detector" commit_id="c0ffee" selected_metrics={['map']} available_metrics={metrics}/>
  </HistoryRouter>);
};

describe('OptimizationReport', () => {
  beforeEach(() => {
    plots.length = 0;
    usePrefsStore.setState({ tuning: {} });
    history.replace('/kitefin/detector/commit/c0ffee?selected_views=optimization');
  });

  it('says how the search went, and what to do next', () => {
    show('tune-int8');
    expect(screen.getByTestId('optimization-status')).toHaveTextContent('Done');
    expect(screen.getByText('40 of 40 evaluations')).toBeInTheDocument();
    expect(within(screen.getByTestId('optimization-insights')).getByText('1 evaluation failed')).toBeInTheDocument();
    expect(screen.getByTestId('insight-unimportant')).toBeInTheDocument();
    // the convergence, and one plot per parameter
    expect(plots.some(p => p.data.some(t => t.name === 'Best so far'))).toBe(true);
    expect(screen.getAllByTestId(/^effect-/)).toHaveLength(4);
  });

  it('shows categories as they were configured', () => {
    show('tune-int8');
    const table = screen.getByTestId('best-parameters');
    expect(within(table).getAllByText('99.999').length).toBeGreaterThan(0);
    expect(within(table).queryByText('100')).toBeNull();
  });

  it('runs the best parameters from the Manual tuning form', () => {
    show('tune-int8');
    fireEvent.click(screen.getByTestId('run-best'));
    const form = usePrefsStore.getState().tuning['kitefin/detector'];
    expect(form.search_type).toBe('grid');
    expect(form.experiment_name).toBe('tune-int8-best');
    const best = batches['tune-int8'].data.best_params;
    expect(JSON.parse(form.parameter_search)).toEqual(best);
    expect(new URLSearchParams(history.location.search).get('selected_views')).toBe('tuning');
  });

  it('shows a running search as running', () => {
    show('tune-int8-running');
    expect(screen.getByTestId('optimization-status')).toHaveTextContent('Running');
    expect(screen.getByText('17 of 40 evaluations')).toBeInTheDocument();
    expect(screen.queryByTestId('insight-unimportant')).toBeNull();
  });

  it('in Pareto mode, shows the trade-offs instead of a single best', () => {
    show('tune-int8-tradeoffs');
    const front = batches['tune-int8-tradeoffs'].data.pareto_front;
    expect(within(screen.getByTestId('tile-front')).getByText(String(front.length))).toBeInTheDocument();
    expect(screen.queryByTestId('run-best')).toBeNull();
    expect(within(screen.getByTestId('pareto')).getAllByRole('button', { name: /Run/ })).toHaveLength(front.length);
    // no summed objective
    expect(plots.some(p => p.data.some(t => t.name === 'Best so far'))).toBe(false);
  });

  it("knows which way is better from the objective, without a metrics file", () => {
    show('tune-int8', { metrics: {} });
    const table = screen.getByTestId('objective-metrics');
    expect(within(table).getByText('ap_small').closest('tr')).toHaveTextContent('higher');
    expect(within(table).getByText('model_mb').closest('tr')).toHaveTextContent('lower');
  });

  it('says why the search stopped', () => {
    show('tune-int8-running', { data: {
      optimization_status: 'failed',
      optimization_error: "qa optimize doesn't know whether higher or lower values of psnr are better. Say it in the objective: `psnr: max` (higher is better) or `psnr: min`.",
    } });
    const error = screen.getByTestId('optimization-error');
    expect(error).toHaveTextContent('The search stopped');
    expect(within(error).getByText('psnr: max').tagName).toBe('CODE');
  });

  it('keeps the other plots one click away', async () => {
    show('tune-int8');
    expect(plots.some(p => p.data[0]?.type === 'parcoords')).toBe(false);
    await act(async () => fireEvent.click(screen.getByTestId('more-plots')));
    expect(plots.some(p => p.data[0]?.type === 'parcoords')).toBe(true);
  });
});
