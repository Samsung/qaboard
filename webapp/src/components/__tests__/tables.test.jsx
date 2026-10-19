/**
 * Tests for the tables and summaries of metrics.
 * Run with: cd webapp && npm test -- tables
 */
import { screen, fireEvent } from '@testing-library/react';
import { Classes } from '@blueprintjs/core';

import { TableCompare, TableKpi } from '../tables';
import { MetricsSummary } from '../metrics';
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

  it('shows the unit of metrics without a target, without a stray space', () => {
    const { container } = renderWithProviders(<TableKpi {...photos()} metrics={['psnr', 'overshoot', 'runtime']} available_metrics={kpi_metrics} />);
    const [headers] = container.querySelectorAll('thead tr');
    const units = [...headers.children].slice(1).map(th => th.querySelector(`span.${Classes.TEXT_MUTED}`)?.textContent ?? null);
    expect(units).toEqual(['[30]', '[0.05]', '[s]']);
  });
});


describe('MetricsSummary', () => {
  it('says when there are no summary metrics, or no finished runs', () => {
    const { unmount } = renderWithProviders(<MetricsSummary metrics={{ available_metrics, summary_metrics: [] }} new_batch={new_batch} ref_batch={ref_batch}/>, { siteConfig: {} });
    expect(screen.getByText('No summary metrics configured')).toBeInTheDocument();
    unmount();
    const pending = { ...new_batch, filtered: { outputs: ['c'] } };
    renderWithProviders(<MetricsSummary metrics={{ available_metrics, summary_metrics: ['loss'] }} new_batch={pending} ref_batch={ref_batch}/>, { siteConfig: {} });
    expect(screen.getByText('No finished run to summarize yet')).toBeInTheDocument();
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
