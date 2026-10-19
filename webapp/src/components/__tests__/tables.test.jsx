/**
 * Tests for the tables and summaries of metrics.
 * Run with: cd webapp && npm test -- tables
 */
import { screen, fireEvent } from '@testing-library/react';
import { Classes } from '@blueprintjs/core';

import { TableCompare, TableKpi } from '../tables';
import { MetricsSummary, MetricsTags } from '../metrics';
import { metrics_fill_defaults } from '../../utils';
import { renderWithProviders } from '../../test-utils';

vi.mock('../Plot', () => ({ default: () => <div data-testid="plot"/> }));

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
    // New and Ref over PSNR and Runtime, an empty cell over the overshoot
    expect([...labels.children].slice(1).map(th => th.textContent)).toEqual(['New', 'Ref', '', 'New', 'Ref']);
    expect(labels.children[0].textContent).toBe('1 run');
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
    expect(screen.getByRole('columnheader', { name: /Runtime/ })).toHaveAttribute('title', expect.stringContaining('compared with the other runs'));
    // PSNR has a target: green when it's met, red when it's not
    const [, psnr_a] = cells[0];
    const [r, g] = psnr_a.style.getPropertyValue('--heat').match(/\d+/g).map(Number);
    expect(g).toBeGreaterThan(r);
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

  it("shows the metrics that changed the most when projects don't choose", () => {
    // loss changed, time has no reference, status is not a number
    renderWithProviders(<MetricsSummary metrics={{ available_metrics, summary_metrics: [] }} new_batch={new_batch} ref_batch={ref_a}/>, { siteConfig: {} });
    expect(screen.getAllByRole('heading', { level: 5, name: /^(loss|time)$/ }).map(h => h.textContent)).toEqual(['loss', 'time']);
    expect(screen.getByText(/The 2 metrics that changed the most vs the reference/)).toBeInTheDocument();
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
