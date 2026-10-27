/**
 * Tests for the tables and summaries of metrics.
 * Run with: cd webapp && npm test -- tables
 */
import { screen, fireEvent } from '@testing-library/react';
import { Classes, Colors } from '@blueprintjs/core';

import { TableCompare, TableKpi } from '../tables';
import { MetricsSummary, MetricsTags } from '../metrics';
import { metrics_fill_defaults, with_undeclared_metrics } from '../../utils';
import { renderWithProviders } from '../../test-utils';

const metric = (key, extra) => ({ key, label: key, short_label: key, scale: 1, suffix: '', smaller_is_better: true, ...extra });
const available_metrics = { loss: metric('loss'), status: metric('status'), time: metric('time', { suffix: 's' }) };

const output = (id, metrics, extra) => ({ id, test_input_path: `${id}.jpg`, configurations: [], extra_parameters: {}, metrics, ...extra });
const ref_batch = Object.freeze({ outputs: { r1: output('r1', { loss: 2, status: 'ok' }) }, filtered: { outputs: ['r1'] } });
const new_batch = Object.freeze({
  outputs: {
    a: output('a', { loss: 1, status: 'ok', time: 3 }, { reference_id: 'r1' }),
    b: output('b', { loss: 2, status: 'failed', time: 4 }, { reference_id: 'r1' }),
    c: output('c', { loss: 5 }, { is_pending: true }),
  },
  filtered: { outputs: ['a', 'b', 'c'] },
  used_metrics: new Set(['loss', 'status', 'time']),
  metrics_with_refs: new Set(['loss', 'status']),
  sorted_extra_parameters: [],
  data: {},
});


// Like the docs' screenshot: the runs left by a filter, photos, which have no edge overshoot (only the slanted edge chart has one)
const kpi_metrics = metrics_fill_defaults({
  psnr: { label: 'PSNR', target: 30, smaller_is_better: false },
  overshoot: { label: 'Edge overshoot', target: 0.05 },
  runtime: { label: 'Runtime', suffix: ' s' },
});
const photo = (id, metrics, extra = {}) => ({
  id, metrics, test_input_path: 'photos/facade.png', configurations: ['low-light'], extra_parameters: {}, platform: 'linux', ...extra,
});
const photos = () => ({
  new_batch: {
    outputs: { 1: photo(1, { psnr: 26.7, runtime: 1.44 }, { reference_id: 2 }) },
    filtered: { outputs: [1] },
    used_metrics: new Set(['psnr', 'overshoot', 'runtime']),
    metrics_with_refs: new Set(['psnr', 'runtime']),
  },
  ref_batch: { outputs: { 2: photo(2, { psnr: 26.2, runtime: 1.23 }) } },
});


describe('TableCompare', () => {
  it('compares the metrics of outputs with their reference', () => {
    renderWithProviders(<TableCompare new_batch={new_batch} ref_batch={ref_batch} metrics={[]} available_metrics={available_metrics}/>);
    expect(screen.getByText('2 runs')).toBeInTheDocument();
    // only metrics with references
    expect(screen.queryByText('time')).not.toBeInTheDocument();
    const [row_a, row_b] = screen.getAllByRole('row').slice(2);
    expect(row_a).toHaveTextContent('-1 (-50%)');
    // equal values
    expect(row_a).toHaveTextContent('=');
    expect(row_b).toHaveTextContent('failed');
  });

  it('shows small changes with enough precision, and colors them', () => {
    const { new_batch, ref_batch } = photos();
    renderWithProviders(<TableCompare new_batch={new_batch} ref_batch={{ outputs: { 2: { ...ref_batch.outputs[2], metrics: { psnr: 26.8 } } } }} metrics={['psnr']} available_metrics={kpi_metrics}/>);
    const cell = screen.getAllByRole('row')[2].querySelector('td');
    // not "-0%"
    expect(cell).toHaveTextContent('-0.1 (-0.37%)');
    renderWithProviders(<TableCompare new_batch={new_batch} ref_batch={{ outputs: { 2: { ...ref_batch.outputs[2], metrics: { psnr: 25.4 } } } }} metrics={['psnr']} available_metrics={kpi_metrics}/>);
    // +5% PSNR is clearly better: green, not yellow
    const better = screen.getAllByRole('row').at(-1).querySelector('td');
    expect(better).toHaveTextContent('1.3 (5%)');
    const [r, g] = better.style.getPropertyValue('--heat').match(/\d+/g).map(Number);
    expect(g - r).toBeGreaterThan(40);
  });

  it('names the columns and tooltips after what we compare', () => {
    const { unmount } = renderWithProviders(<TableCompare new_batch={new_batch} ref_batch={ref_batch} metrics={['loss']} available_metrics={available_metrics}/>);
    expect(screen.getByText('new − reference')).toBeInTheDocument();
    expect(screen.getAllByRole('row')[2].querySelector('td')).toHaveAttribute('title', 'new: 1\nreference: 2');
    unmount();
    renderWithProviders(<TableCompare new_batch={new_batch} ref_batch={ref_batch} metrics={['loss']} available_metrics={available_metrics} labels={['ISP v2', 'v1.4']}/>);
    expect(screen.getByText('ISP v2 − v1.4')).toBeInTheDocument();
    expect(screen.getAllByRole('row')[2].querySelector('td')).toHaveAttribute('title', 'ISP v2: 1\nv1.4: 2');
  });

  it("shows metrics that were not declared, colored by how much they change", () => {
    const { new_batch, ref_batch } = photos();
    // runtime is not in the definitions: we don't know which way is better
    const { runtime: _runtime, ...without_runtime } = kpi_metrics;
    const ref = { outputs: { 2: { ...ref_batch.outputs[2], metrics: { runtime: 1.2 } } } };
    renderWithProviders(<TableCompare new_batch={new_batch} ref_batch={ref} metrics={['runtime']} available_metrics={without_runtime}/>);
    expect(screen.getByRole('columnheader', { name: 'runtime' })).toBeInTheDocument();
    const cell = screen.getAllByRole('row')[2].querySelector('td');
    expect(cell).toHaveTextContent('0.24 (20%)');
    // a neutral blue, neither green nor red
    const [r, g, b] = cell.style.getPropertyValue('--heat').match(/\d+/g).map(Number);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });

  it('says when no run matches the filter', () => {
    renderWithProviders(<TableCompare new_batch={{ ...new_batch, filtered: { outputs: [] } }} ref_batch={ref_batch} metrics={[]} available_metrics={available_metrics}/>);
    expect(screen.getByText('No finished run matches the filter.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('says when the reference has no matching runs', () => {
    const without_refs = { ...new_batch, metrics_with_refs: new Set() };
    renderWithProviders(<TableCompare new_batch={without_refs} ref_batch={ref_batch} metrics={[]} available_metrics={available_metrics}/>);
    expect(screen.getByText('No metric to compare')).toBeInTheDocument();
    expect(screen.getByText(/Pick another reference/)).toBeInTheDocument();
  });
});


describe('TableKpi', () => {
  it('shows the selected metrics', () => {
    renderWithProviders(<TableKpi new_batch={new_batch} ref_batch={ref_batch} metrics={['time', 'loss']} available_metrics={available_metrics}/>);
    const headers = screen.getAllByRole('columnheader').map(th => th.textContent);
    expect(headers.slice(1, 3)).toEqual(['time[s]', 'loss']);
    expect(screen.getAllByRole('row')).toHaveLength(4);
  });

  it('has a header cell over each column, also for metrics without references', () => {
    const { container } = renderWithProviders(<TableKpi {...photos()} metrics={['psnr', 'overshoot', 'runtime']} available_metrics={kpi_metrics} />);
    const [, labels] = container.querySelectorAll('thead tr');
    const row = container.querySelector('tbody tr');
    expect(labels.children).toHaveLength(row.children.length);
    // new and reference over PSNR and Runtime, an empty cell over the overshoot
    expect([...labels.children].slice(1).map(th => th.textContent)).toEqual(['new', 'reference', '', 'new', 'reference']);
    expect(labels.children[0].textContent).toBe('1 run');
  });

  it('names the columns after what we compare', () => {
    const same = photos();
    same.ref_batch.outputs[2].metrics.runtime = 1.44;
    const { container } = renderWithProviders(<TableKpi {...same} metrics={['psnr', 'runtime']} available_metrics={kpi_metrics} labels={['ISP v2', 'v1.4']}/>);
    const [, labels] = container.querySelectorAll('thead tr');
    expect([...labels.children].slice(1).map(th => th.textContent)).toEqual(['ISP v2', 'v1.4', 'ISP v2', 'v1.4']);
    // the reference's runtime is the new one's
    expect(screen.getByTitle('Same as ISP v2')).toHaveTextContent('=');
  });

  it('shades metrics without a target by how they rank among the runs', () => {
    const runs = {
      outputs: {
        a: output('a', { runtime: 1, psnr: 35 }),
        b: output('b', { runtime: 2, psnr: 20 }),
        c: output('c', { runtime: 3 }),
      },
      filtered: { outputs: ['a', 'b', 'c'] },
      used_metrics: new Set(['runtime', 'psnr']),
      metrics_with_refs: new Set(),
    };
    const { container } = renderWithProviders(<TableKpi new_batch={runs} ref_batch={{ outputs: {} }} metrics={['runtime', 'psnr']} available_metrics={kpi_metrics}/>);
    const cells = [...container.querySelectorAll('tbody tr')].map(row => row.querySelectorAll('td'));
    const strength = td => Number(td.style.getPropertyValue('--heat-strength'));
    expect(cells.map(([runtime]) => strength(runtime))).toEqual([0, 0.5, 1]);
    // PSNR has a target: green when it's met, red when it's not
    const [, psnr_a] = cells[0];
    const [r, g] = psnr_a.style.getPropertyValue('--heat').match(/\d+/g).map(Number);
    expect(g).toBeGreaterThan(r);
  });

  it('shows at most 20 columns of metrics that were not declared, unless users pick them', () => {
    const keys = Array.from({ length: 30 }, (_, i) => `m${String(i).padStart(2, '0')}`);
    const runs = {
      outputs: { a: output('a', { loss: 1, ...Object.fromEntries(keys.map(k => [k, 1])) }) },
      filtered: { outputs: ['a'] },
      used_metrics: new Set(['loss', ...keys]),
      metrics_with_refs: new Set(),
    };
    const all = with_undeclared_metrics(available_metrics, runs.used_metrics);
    const headers = container => container.querySelectorAll('thead tr:first-child th').length - 1;
    const { container, unmount } = renderWithProviders(<TableKpi new_batch={runs} ref_batch={{ outputs: {} }} metrics={[]} available_metrics={all}/>);
    // the declared metric, and 19 others
    expect(headers(container)).toBe(20);
    expect(screen.getByText('20 of 31 metrics. Pick others above.')).toBeInTheDocument();
    unmount();
    const picked = renderWithProviders(<TableKpi new_batch={runs} ref_batch={{ outputs: {} }} metrics={keys} available_metrics={all}/>);
    expect(headers(picked.container)).toBe(30);
    expect(screen.queryByText(/Pick others above/)).not.toBeInTheDocument();
  });

  it('shows the unit of metrics without a target, without a stray space', () => {
    const { container } = renderWithProviders(<TableKpi {...photos()} metrics={['psnr', 'overshoot', 'runtime']} available_metrics={kpi_metrics} />);
    const [headers] = container.querySelectorAll('thead tr');
    const units = [...headers.children].slice(1).map(th => th.querySelector(`span.${Classes.TEXT_MUTED}`)?.textContent ?? null);
    expect(units).toEqual(['[30]', '[0.05]', '[s]']);
  });
});


describe('MetricsSummary', () => {
  // a reference run on the same input as the new run "a"
  const ref_a = Object.freeze({ outputs: { r1: output('r1', { loss: 2, status: 'ok' }, { test_input_path: 'a.jpg' }) }, filtered: { outputs: ['r1'] } });

  it('says when there are no metrics to summarize, or no finished runs', () => {
    const strings = { ...new_batch, used_metrics: new Set(['status']) };
    const { unmount } = renderWithProviders(<MetricsSummary metrics={{ available_metrics, summary_metrics: [] }} new_batch={strings} ref_batch={ref_batch}/>, { siteConfig: {} });
    expect(screen.getByText('No metrics to summarize')).toBeInTheDocument();
    unmount();
    const pending = { ...new_batch, filtered: { outputs: ['c'] } };
    renderWithProviders(<MetricsSummary metrics={{ available_metrics, summary_metrics: ['loss'] }} new_batch={pending} ref_batch={ref_batch}/>, { siteConfig: {} });
    expect(screen.getByText('No finished run to summarize yet')).toBeInTheDocument();
  });

  it('names the reference after what we compare, in its color', () => {
    const metrics = { available_metrics, summary_metrics: ['loss'] };
    // the summary compares runs on the same inputs
    const ref_batch = { outputs: { r1: output('a', { loss: 2 }) }, filtered: { outputs: ['r1'] } };
    const { unmount } = renderWithProviders(<MetricsSummary metrics={metrics} new_batch={new_batch} ref_batch={ref_batch}/>);
    expect(screen.getByRole('heading', { name: /^2\s*reference$/ })).toBeInTheDocument();
    unmount();
    const labels = { new: 'ISP v2', reference: 'v1.4', colors: { new: { css: 'var(--qa-side-0)', hex: '#2d72d2' }, reference: { css: 'var(--qa-side-2)', hex: '#cf0494' } } };
    renderWithProviders(<MetricsSummary metrics={metrics} new_batch={new_batch} ref_batch={ref_batch} labels={labels}/>);
    const heading = screen.getByRole('heading', { name: /^2\s*v1.4$/ });
    expect(heading.querySelector('[aria-hidden]')).toHaveStyle({ background: 'var(--qa-side-2)' });
  });

  it("shows the metrics that changed the most when projects don't choose", () => {
    // loss changed, time has no reference, status is not a number
    renderWithProviders(<MetricsSummary metrics={{ available_metrics, summary_metrics: [] }} new_batch={new_batch} ref_batch={ref_a}/>, { siteConfig: {} });
    expect(screen.getAllByRole('heading', { level: 5, name: /^(loss|time)$/ }).map(h => h.textContent)).toEqual(['loss', 'time']);
    expect(screen.getByText(/The 2 metrics that changed the most vs the reference/)).toBeInTheDocument();
  });

  it('keeps the metrics users pick while runs finish, and when nothing is configured', () => {
    const { rerender } = renderWithProviders(<MetricsSummary metrics={{ available_metrics, summary_metrics: [] }} new_batch={new_batch} ref_batch={ref_a}/>, { siteConfig: {} });
    fireEvent.click(screen.getAllByLabelText('Remove tag')[0]);
    expect(screen.queryByRole('heading', { level: 5, name: 'loss' })).not.toBeInTheDocument();
    // a refetch: new runs, with other changes
    const refetched = { ...new_batch, outputs: { ...new_batch.outputs, b: { ...new_batch.outputs.b, metrics: { loss: 9, time: 1 } } } };
    rerender(<MetricsSummary metrics={{ available_metrics, summary_metrics: [] }} new_batch={refetched} ref_batch={ref_a}/>);
    expect(screen.queryByRole('heading', { level: 5, name: 'loss' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 5, name: 'time' })).toBeInTheDocument();
  });

  it('shows nothing when users clear the selection', () => {
    renderWithProviders(<MetricsSummary metrics={{ available_metrics, summary_metrics: [] }} selected_metrics={[]} new_batch={new_batch} ref_batch={ref_a}/>, { siteConfig: {} });
    expect(screen.queryByRole('heading', { level: 5 })).not.toBeInTheDocument();
    expect(screen.queryByText('No metrics to summarize')).not.toBeInTheDocument();
  });

  it("helps declare the metrics that don't say which way is better", () => {
    const metrics = { available_metrics: { ...available_metrics, loss: metric('loss', { smaller_is_better: null }) }, summary_metrics: ['loss'] };
    renderWithProviders(<MetricsSummary metrics={metrics} new_batch={new_batch} ref_batch={ref_a}/>, { siteConfig: {} });
    expect(screen.getByText(/Higher or lower is better\? QA-Board doesn't know for loss/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Declare them' })).toHaveAttribute('href', expect.stringContaining('#declaring-metrics'));
    // the change is neutral: neither green nor red
    expect(screen.getByText('-25%').closest(`.${Classes.TAG}`)).not.toHaveClass(Classes.INTENT_SUCCESS);
    expect(screen.getByText('-25%').closest(`.${Classes.TAG}`)).not.toHaveClass(Classes.INTENT_DANGER);
  });

  it('draws box plots of the new and reference runs, with their numbers on hover', () => {
    renderWithProviders(<MetricsSummary metrics={{ available_metrics, summary_metrics: ['loss'] }} new_batch={new_batch} ref_batch={ref_a}/>);
    const plot = screen.getByRole('img', { name: 'Box plots of loss' });
    expect([...plot.querySelectorAll('title')].map(title => title.textContent)).toEqual([
      'new: 2 runs\nmedian 1.5, mean 1.5\nquartiles 1 to 2\nwhiskers 1 to 2',
      'reference: 1 run\nmedian 2, mean 2\nquartiles 2 to 2\nwhiskers 2 to 2',
    ]);
    expect(plot.querySelectorAll('circle')).toHaveLength(3);
  });

  it('shades the range where runs miss the target in red, where they meet it in green', () => {
    const zones = loss => {
      const metrics = { available_metrics: { ...available_metrics, loss: metric('loss', loss) }, summary_metrics: ['loss'] };
      const { unmount } = renderWithProviders(<MetricsSummary metrics={metrics} new_batch={new_batch} ref_batch={ref_a}/>);
      const fills = [...screen.getByRole('img', { name: 'Box plots of loss' }).querySelectorAll('rect[fill]')].map(rect => rect.getAttribute('fill'));
      unmount();
      return fills;
    };
    expect(zones({ target: 1.5 })).toEqual([Colors.RED5, Colors.GREEN2]);
    // higher is better, and all the runs meet the target
    expect(zones({ target: 0.5, smaller_is_better: false })).toEqual([Colors.GREEN2]);
  });

  it('labels the axis with distinct round values, on the axis, also when the values are close', () => {
    const ticks = (values, loss) => {
      const ids = values.map((_, i) => `o${i}`);
      const batch = { ...new_batch, outputs: Object.fromEntries(values.map((value, i) => [ids[i], output(ids[i], { loss: value })])), filtered: { outputs: ids } };
      const metrics = { available_metrics: { ...available_metrics, loss: metric('loss', loss) }, summary_metrics: ['loss'] };
      const { unmount } = renderWithProviders(<MetricsSummary metrics={metrics} new_batch={batch} ref_batch={null}/>);
      const labels = [...screen.getByRole('img', { name: 'Box plots of loss' }).querySelectorAll('text[text-anchor="end"]')];
      const ticks = labels.map(label => [label.textContent, Number(label.getAttribute('y'))]);
      unmount();
      return ticks;
    };
    // on a log scale there's no round value between them: the single one was drawn far outside the plot
    const close = ticks([35.12, 35.125, 35.13], {});
    expect(close.map(([label]) => label)).toEqual(['35.12', '35.125', '35.13']);
    expect(close.every(([, y]) => y >= 8 && y <= 75)).toBe(true);
    // they were rounded: 1000, 1010, 1010
    expect(ticks([1000, 1004, 1010], { plot_scale: 'linear' }).map(([label]) => label)).toEqual(['1000', '1005', '1010']);
  });

  it('shows the summary metrics, until users choose others', () => {
    const metrics = { available_metrics, summary_metrics: ['loss'] };
    const { rerender } = renderWithProviders(<MetricsSummary metrics={metrics} new_batch={new_batch} ref_batch={ref_batch}/>);
    expect(screen.getByRole('heading', { name: 'loss' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'time' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Remove tag'));
    expect(screen.queryByRole('heading', { name: 'loss' })).not.toBeInTheDocument();
    // re-rendering with the same metrics keeps the user's choice
    rerender(<MetricsSummary metrics={{ ...metrics }} new_batch={new_batch} ref_batch={ref_batch}/>);
    expect(screen.queryByRole('heading', { name: 'loss' })).not.toBeInTheDocument();
    // new defaults replace it
    rerender(<MetricsSummary metrics={{ available_metrics, summary_metrics: ['time'] }} new_batch={new_batch} ref_batch={ref_batch}/>);
    expect(screen.getByRole('heading', { name: 'time' })).toBeInTheDocument();
  });
});


describe('MetricsTags', () => {
  it("shows the run's first metrics, declared or not, when projects don't choose", () => {
    const metrics_new = { is_failed: false, zoom: 2, loss: 1, alpha: 3, compute_time: 4 };
    const { container, unmount } = renderWithProviders(<MetricsTags metrics_new={metrics_new} available_metrics={available_metrics}/>);
    const labels = () => [...container.querySelectorAll(`.${Classes.COMPOUND_TAG_LEFT}`)].map(tag => tag.textContent);
    expect(labels()).toEqual(['loss', 'alpha', 'compute_time', 'zoom']);
    unmount();
    renderWithProviders(<MetricsTags metrics_new={metrics_new} available_metrics={available_metrics} selected_metrics={['zoom', 'missing']}/>);
    expect(screen.getByText('zoom')).toBeInTheDocument();
    expect(screen.queryByText('loss')).not.toBeInTheDocument();
  });
});
