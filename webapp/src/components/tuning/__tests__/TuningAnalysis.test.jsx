/**
 * The Tuning Analysis view of batches that weren't tuned automatically: a grid, values tried by hand, or nothing yet.
 * Run with: cd webapp && npm test -- TuningAnalysis
 */
import { screen, fireEvent, within, act } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import TuningAnalysis from '../TuningAnalysis';
import TuningBanner from '../TuningBanner';
import { parse } from '../optimize_config';
import { history } from '../../../router';
import { renderWithProviders } from '../../../test-utils';
import { usePrefsStore } from '../../../stores/prefs';

const plots = [];
vi.mock('../../Plot', () => ({ default: ({ data, layout }) => { plots.push({ data, layout }); return <div data-testid="plot"/>; } }));
const parallel = [];
vi.mock('../ParallelCoordinatesPlot', () => ({ default: props => {
  parallel.push(props);
  return <button type="button" aria-label="Filter" data-testid="parallel" onClick={() => props.onSelectionChange([props.rows[0].id])}/>;
} }));

let next_id = 1;
const run = (input, params, metrics, extra = {}) => ({ id: next_id++, test_input_path: input, configurations: ['base'], params, metrics, ...extra });
// 4 strengths on 3 images: the noise drops with the strength, the sharpness too; chart.png prefers a low strength
const grid = (metrics = true) => [0.5, 1, 2, 4].flatMap(strength => ['chart.png', 'night.png', 'face.png'].map(input => run(
  input, { denoise: { strength } },
  metrics ? { noise: 10 / strength + (input === 'chart.png' ? strength * 4 : 0), sharpness: 1 - strength / 10 } : {},
)));
const as_batch = (outputs, label = 'tune-denoise') => ({
  label, data: {},
  outputs: Object.fromEntries(outputs.map(o => [o.id, o])),
  filtered: { outputs: outputs.map(o => String(o.id)) },
});
const available_metrics = {
  noise: { key: 'noise', label: 'Noise', short_label: 'noise', scale: 1, suffix: '', smaller_is_better: true },
  sharpness: { key: 'sharpness', label: 'Sharpness', short_label: 'sharp', scale: 1, suffix: '', smaller_is_better: null },
};

const show = (batch, props = {}) => renderWithProviders(<HistoryRouter history={history}>
  <TuningAnalysis batch={batch} project="isp/denoise" commit_id="c0ffee" selected_metrics={['noise']} available_metrics={available_metrics} {...props}/>
</HistoryRouter>, { siteConfig: {} });

describe('TuningAnalysis', () => {
  beforeEach(() => {
    plots.length = 0;
    parallel.length = 0;
    usePrefsStore.setState({ tuning: {} });
    history.replace('/isp/denoise/commit/c0ffee?selected_views=optimization');
  });

  it('says which parameters are best, and what to do next', () => {
    show(as_batch(grid()));
    expect(screen.getByRole('heading', { name: /4 parameter sets compared/ })).toBeInTheDocument();
    expect(within(screen.getByTestId('tile-best')).getByText('7.67')).toBeInTheDocument();
    expect(within(screen.getByTestId('best-parameters')).getByText('2')).toBeInTheDocument();
    // the other images prefer a stronger denoising
    expect(screen.getByTestId('tile-wins')).toHaveTextContent('1 of 3 tests');
    expect(screen.getByTestId('insight-tests_disagree')).toHaveTextContent('night.png');
    expect(screen.getByTestId('test-by-test')).toBeInTheDocument();
    expect(screen.getByTestId('insight-automate')).toBeInTheDocument();
    // the parallel coordinates: the metrics, then the parameters, colored by the metric compared
    const { columns, rows, colorBy, marks } = parallel.at(-1);
    expect(columns.map(c => [c.key, c.group, c.better])).toEqual([
      ['metric:noise', 'Metrics', 'lower'], ['metric:sharpness', 'Metrics', undefined], ['param:denoise.strength', 'Parameters', undefined],
    ]);
    expect(rows).toHaveLength(4);
    expect(colorBy).toBe('metric:noise');
    expect(Object.values(marks)).toEqual([{ label: 'Best' }]);
  });

  it('runs the best parameters, and sets up a search from the ranges tried', () => {
    show(as_batch(grid()));
    fireEvent.click(screen.getByTestId('run-best'));
    let form = usePrefsStore.getState().tuning['isp/denoise'];
    expect(JSON.parse(form.parameter_search)).toEqual({ denoise: { strength: 2 } });
    expect(form.experiment_name).toBe('tune-denoise-best');

    fireEvent.click(screen.getByTestId('search-automatically'));
    form = usePrefsStore.getState().tuning['isp/denoise'];
    expect(form.search_type).toBe('optimize');
    expect(parse(form.parameter_search_auto).config).toEqual({
      evaluations: 20,
      objective: { noise: 'min' },
      search_space: [{ Real: { name: 'denoise.strength', low: 0.5, high: 4 } }],
    });
    expect(new URLSearchParams(history.location.search).get('selected_views')).toBe('tuning');
  });

  it("asks which way is better when the project doesn't say", async () => {
    history.replace('/isp/denoise/commit/c0ffee?selected_views=optimization&selected_metric=sharpness');
    show(as_batch(grid()));
    expect(screen.getByTestId('tuning-goal')).toHaveTextContent('Is a higher or a lower Sharpness better?');
    expect(screen.queryByTestId('tile-best')).toBeNull();
    await act(async () => fireEvent.click(within(screen.getByTestId('tuning-goal')).getByRole('button', { name: 'Higher is better' })));
    expect(new URLSearchParams(history.location.search).get('goal')).toBe('max');
    expect(within(screen.getByTestId('tile-best')).getByText('0.95')).toBeInTheDocument();
  });

  it("follows the parallel coordinates' filters in the table", async () => {
    show(as_batch(grid()));
    expect(within(screen.getByTestId('sets-table')).getAllByRole('row')).toHaveLength(5);
    await act(async () => fireEvent.click(screen.getByTestId('parallel')));
    expect(within(screen.getByTestId('sets-table')).getAllByRole('row')).toHaveLength(2);
    expect(screen.getByTestId('sets-selection')).toHaveTextContent('1 kept');
  });

  it('gives a script to score the runs when they have no metrics', () => {
    show(as_batch(grid(false)));
    expect(screen.getByTestId('tuning-no-metrics')).toHaveTextContent('The runs have no metrics yet');
    expect(screen.getByTestId('metrics-script')).toHaveTextContent('run.log_metrics');
    expect(screen.getByTestId('metrics-script')).toHaveTextContent('/isp/denoise/commit/c0ffee?batch=tune-denoise');
  });

  it("says how to start when nothing was tuned, and points to the commit's tunings", async () => {
    const batch = as_batch([run('a.png', { x: 1 }, { noise: 1 }), run('b.png', { x: 1 }, { noise: 2 })], 'default');
    const commit = { batches: { default: batch, 'tune-denoise': as_batch(grid()) } };
    show(batch, { commit });
    expect(screen.getByTestId('tuning-get-started')).toHaveTextContent('use the same parameters');
    expect(screen.getByTestId('tuning-get-started')).toHaveTextContent('the runs have 1 metric');
    await act(async () => fireEvent.click(within(screen.getByTestId('other-tunings')).getByRole('button', { name: /tune-denoise/ })));
    expect(new URLSearchParams(history.location.search).get('batch')).toBe('tune-denoise');
    await act(async () => fireEvent.click(screen.getByTestId('start-automated')));
    expect(usePrefsStore.getState().tuning['isp/denoise'].search_type).toBe('optimize');
    expect(new URLSearchParams(history.location.search).get('selected_views')).toBe('tuning');
  });

  it('says when the filter hides what was tried', () => {
    const batch = as_batch(grid());
    show({ ...batch, filtered: { outputs: batch.filtered.outputs.slice(0, 3) } });
    expect(screen.getByTestId('tuning-get-started')).toHaveTextContent('The filter leaves a single parameter set');
  });
});

describe('TuningBanner', () => {
  it('points to the analysis from the results of a batch that tried several parameters', async () => {
    history.replace('/isp/denoise/commit/c0ffee');
    const { rerender } = renderWithProviders(<HistoryRouter history={history}><TuningBanner batch={as_batch(grid())}/></HistoryRouter>);
    expect(screen.getByTestId('tuning-banner')).toHaveTextContent('This batch tried 4 parameter sets of denoise.strength on 3 tests.');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'See which is best' })));
    expect(new URLSearchParams(history.location.search).get('selected_views')).toBe('optimization');
    rerender(<HistoryRouter history={history}><TuningBanner batch={as_batch([run('a.png', { x: 1 }, {})])}/></HistoryRouter>);
    expect(screen.queryByTestId('tuning-banner')).toBeNull();
  });
});
