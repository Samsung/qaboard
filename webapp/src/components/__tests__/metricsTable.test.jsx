/**
 * Tests for the metrics tables' column summaries, sorting, copies, and sticky header.
 * Run with: cd webapp && npm test -- metricsTable
 */
import { screen, fireEvent, within } from '@testing-library/react';
import { vi } from 'vitest';

import { TableCompare, TableKpi } from '../tables';
import { distribution, changes, column_decimals, format_fixed, to_tsv } from '../metricsTable/stats';
import { renderWithProviders } from '../../test-utils';
import { copyWithToast } from '../../utils/clipboard';

vi.mock('../../utils/clipboard', () => ({ copyWithToast: vi.fn() }));

const metric = (key, extra) => ({ key, label: key, short_label: key, scale: 1, suffix: '', smaller_is_better: true, ...extra });
const available_metrics = {
  loss: metric('loss', { target: 1.5 }),
  status: metric('status'),
  time: metric('time', { suffix: ' s', smaller_is_better: null }),
};
const output = (id, metrics, extra) => ({ id, test_input_path: `${id}.jpg`, configurations: [], extra_parameters: {}, metrics, ...extra });
const ref_batch = Object.freeze({
  outputs: {
    r1: output('r1', { loss: 2, status: 'ok', time: 3 }),
    r2: output('r2', { loss: 2, status: 'ok', time: 4 }),
    r3: output('r3', { loss: 1, status: 'ok', time: 1 }),
  },
});
// a gets better, b doesn't change (but its status does), c gets worse and failed
const new_batch = Object.freeze({
  outputs: {
    a: output('a', { loss: 1, status: 'ok', time: 3 }, { reference_id: 'r1' }),
    b: output('b', { loss: 2, status: 'failed', time: 4 }, { reference_id: 'r2' }),
    c: output('c', { loss: 3, status: 'ok', time: 2 }, { reference_id: 'r3', is_failed: true }),
  },
  filtered: { outputs: ['a', 'b', 'c'] },
  used_metrics: new Set(['loss', 'status', 'time']),
  metrics_with_refs: new Set(['loss', 'status', 'time']),
});
const body_rows = container => [...container.querySelectorAll('tbody tr')];


describe('column statistics', () => {
  it('summarizes the distribution of values, and how many meet the target', () => {
    const stats = distribution([1, 2, 3, 4, null, 'badge'], metric('loss', { target: 2.5 }));
    expect(stats).toMatchObject({ count: 4, missing: 2, min: 1, max: 4, median: 2.5, met: 2 });
    expect(stats.bins.reduce((a, b) => a + b)).toBe(4);
    // higher is better
    expect(distribution([1, 2, 3], metric('psnr', { target: 2, smaller_is_better: false })).met).toBe(2);
    // without a target, or a known direction, nothing to meet
    expect(distribution([1, 2], metric('x')).met).toBeNull();
    expect(distribution([1, 2], metric('x', { target: 1, smaller_is_better: null })).met).toBeNull();
    expect(distribution([5, 5], metric('x')).bins).toEqual([2]);
  });

  it('counts the runs that got better, worse, or stayed the same', () => {
    const [values, values_ref] = [[1, 2, 3, null, 4], [2, 2, 1, 1, 2]];
    expect(changes(values, values_ref, metric('loss'))).toMatchObject({ better: 1, worse: 2, changed: 3, unchanged: 1, missing: 1, median_change: expect.closeTo(0.5, 4) });
    // we don't know which way is better: only changes
    expect(changes(values, values_ref, metric('loss', { smaller_is_better: null }))).toMatchObject({ better: null, worse: null, changed: 3, unchanged: 1 });
    expect(changes(['ok', 'ok'], ['ok', 'failed'], metric('status'))).toMatchObject({ changed: 1, unchanged: 1 });
  });

  it('formats a column with the same decimals, so that numbers line up', () => {
    expect(column_decimals([1.2, 1.44, 1.3], metric('x'))).toBe(2);
    expect(column_decimals([26.7, 35.2], metric('x'))).toBe(1);
    // integers stay integers, scaled values are what we show
    expect(column_decimals([1, 2, 3], metric('x'))).toBe(0);
    expect(column_decimals([0.0421, 0.05], metric('x', { scale: 1000 }))).toBe(1);
    expect(column_decimals(['badge', null], metric('x'))).toBeNull();
    const fallback = v => `~${v}`;
    expect(format_fixed(1.2, 2, fallback)).toBe('1.20');
    expect(format_fixed(-0.001, 2, fallback)).toBe('~-0.001');
    expect(format_fixed(-0.004, 1, fallback)).toBe('~-0.004');
    expect(format_fixed(-0, 2, fallback)).toBe('0.00');
  });

  it('writes tab-separated values that paste into spreadsheets', () => {
    expect(to_tsv([['a\tb', 'line\nbreak'], [1, null]])).toBe('a b\tline break\n1\t');
  });
});


describe('TableKpi', () => {
  it('summarizes each column: its median, and how many runs meet the target', () => {
    const { container } = renderWithProviders(<TableKpi new_batch={new_batch} ref_batch={ref_batch} metrics={['loss', 'time']} available_metrics={available_metrics}/>);
    const summary = container.querySelector('tr.summary-row');
    const [loss_new, loss_ref, time_new] = summary.querySelectorAll('td');
    expect(loss_new).toHaveTextContent('2 median');
    expect(loss_new).toHaveTextContent('1/3 met');
    expect(loss_new.title).toContain('loss (new): 3 runs');
    expect(loss_new.title).toContain('1 of 3 meet the target (≤ 1.5)');
    expect(loss_new.querySelector('svg.histogram')).toBeInTheDocument();
    expect(loss_ref).toHaveTextContent('1/3 met');
    // no target: no count
    expect(time_new).not.toHaveTextContent('met');
  });

  it('shows numbers with the decimals of their column, and missing values as a dash', () => {
    const runs = {
      ...new_batch,
      outputs: { a: output('a', { loss: 1.2 }), b: output('b', { loss: 1.44 }), c: output('c', {}) },
      metrics_with_refs: new Set(),
    };
    const { container } = renderWithProviders(<TableKpi new_batch={runs} ref_batch={{ outputs: {} }} metrics={['loss']} available_metrics={available_metrics}/>);
    const cells = body_rows(container).map(row => row.querySelector('td'));
    expect(cells.map(td => td.textContent)).toEqual(['1.20', '1.44', '–']);
    expect(cells[2]).toHaveAttribute('aria-label', 'No value');
  });

  it('flags failed runs', () => {
    const { container } = renderWithProviders(<TableKpi new_batch={new_batch} ref_batch={ref_batch} metrics={['loss']} available_metrics={available_metrics}/>);
    expect(body_rows(container).map(row => row.hasAttribute('data-failed'))).toEqual([false, false, true]);
    expect(screen.getByText('3 runs, 1 failed')).toBeInTheDocument();
  });

  it('sorts the runs when users click the headers', () => {
    const onSort = vi.fn();
    const sorting = { by: 'loss', order: -1, default_by: 'test_input_path' };
    renderWithProviders(<TableKpi new_batch={new_batch} ref_batch={ref_batch} metrics={['loss', 'time']} available_metrics={available_metrics} sorting={sorting} onSort={onSort}/>);
    const loss = screen.getByRole('columnheader', { name: /^loss/ });
    expect(loss).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByRole('columnheader', { name: /^time/ })).not.toHaveAttribute('aria-sort');
    // the sorted column: the other way
    fireEvent.click(within(loss).getByRole('button'));
    expect(onSort).toHaveBeenLastCalledWith({ by: 'loss', order: 1 });
    // another metric: largest first
    fireEvent.click(within(screen.getByRole('columnheader', { name: /^time/ })).getByRole('button'));
    expect(onSort).toHaveBeenLastCalledWith({ by: 'time', order: -1 });
    // the runs: by name, A to Z
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(onSort).toHaveBeenLastCalledWith({ by: 'test_input_path', order: 1 });
  });

  it("doesn't sort without onSort", () => {
    renderWithProviders(<TableKpi new_batch={new_batch} ref_batch={ref_batch} metrics={['loss']} available_metrics={available_metrics} sorting={{ by: 'loss', order: -1 }}/>);
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('columnheader', { name: /^loss/ })).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^loss/ })).not.toHaveAttribute('aria-sort');
  });

  it('copies the table as tab-separated values', () => {
    renderWithProviders(<TableKpi new_batch={new_batch} ref_batch={ref_batch} metrics={['loss', 'time']} available_metrics={available_metrics}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    const [text, { what }] = copyWithToast.mock.lastCall;
    expect(what).toBe('the table (3 runs)');
    expect(text.split('\n')).toEqual([
      'Run\tFailed\tloss new\tloss reference\ttime [s] new\ttime [s] reference',
      'a.jpg\t\t1\t2\t3\t3',
      'b.jpg\t\t2\t2\t4\t4',
      'c.jpg\tyes\t3\t1\t2\t1',
    ]);
  });
});


describe('TableCompare', () => {
  it('counts the runs that got better, worse, or changed when the direction is unknown', () => {
    const { container } = renderWithProviders(<TableCompare new_batch={new_batch} ref_batch={ref_batch} metrics={['loss', 'status', 'time']} available_metrics={available_metrics}/>);
    const [loss, status, time] = container.querySelectorAll('tr.summary-row td');
    expect(loss).toHaveTextContent('1 better · 1 worse');
    expect(loss.title).toContain('1 better, 1 worse, 1 the same');
    expect(status).toHaveTextContent('1 changed');
    expect(time).toHaveTextContent('1 changed');
    expect(time.title).toContain("doesn't know if higher or lower is better");
  });

  it("doesn't color the runs that didn't change", () => {
    const { container } = renderWithProviders(<TableCompare new_batch={new_batch} ref_batch={ref_batch} metrics={['loss']} available_metrics={available_metrics}/>);
    const [, same] = body_rows(container).map(row => row.querySelector('td'));
    expect(same).toHaveTextContent('=');
    expect(same).not.toHaveClass('heat-cell');
  });

  it('shows only the runs that changed, when users ask', () => {
    const { container } = renderWithProviders(<TableCompare new_batch={new_batch} ref_batch={ref_batch} metrics={['loss']} available_metrics={available_metrics}/>);
    expect(body_rows(container)).toHaveLength(3);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Only runs that changed' }));
    expect(body_rows(container).map(row => row.querySelector('th').textContent)).toEqual([expect.stringContaining('a.jpg'), expect.stringContaining('c.jpg')]);
    expect(screen.getByText('2 of 3 runs, 1 failed')).toBeInTheDocument();
  });

  it('says when the runs are sorted by name', () => {
    renderWithProviders(<TableCompare new_batch={new_batch} ref_batch={ref_batch} metrics={['loss']} available_metrics={available_metrics} sorting={{ by: 'test_input_path', order: 1 }} onSort={() => {}}/>);
    expect(screen.getByRole('columnheader', { name: 'Run' })).toHaveAttribute('aria-sort', 'ascending');
    expect(screen.getByRole('columnheader', { name: /^loss/ })).not.toHaveAttribute('aria-sort');
  });

  it('copies the values, their difference and relative change', () => {
    renderWithProviders(<TableCompare new_batch={new_batch} ref_batch={ref_batch} metrics={['loss']} available_metrics={available_metrics}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    const [text] = copyWithToast.mock.lastCall;
    const [header, a] = text.split('\n');
    expect(header).toBe('Run\tFailed\tloss new\tloss reference\tloss change\tloss change (%)');
    expect(a).toBe('a.jpg\t\t1\t2\t-1\t-50');
  });
});


describe('sticky header', () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the header under the page's fixed headers while the window scrolls", () => {
    // the table starts 100px above the top of the window, and is 1000px tall
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: -100, bottom: 900, height: 1000, left: 0, right: 500, width: 500 });
    const { container } = renderWithProviders(<TableKpi new_batch={new_batch} ref_batch={ref_batch} metrics={['loss']} available_metrics={available_metrics} stickyTop={50}/>);
    fireEvent.scroll(window);
    const thead = container.querySelector('thead');
    expect(thead.style.getPropertyValue('--qa-stick')).toBe('150px');
    expect(thead).toHaveAttribute('data-stuck');
  });

  it('scrolls with the page without stickyTop', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: -100, bottom: 900, height: 1000, left: 0, right: 500, width: 500 });
    const { container } = renderWithProviders(<TableKpi new_batch={new_batch} ref_batch={ref_batch} metrics={['loss']} available_metrics={available_metrics}/>);
    fireEvent.scroll(window);
    expect(container.querySelector('thead').style.getPropertyValue('--qa-stick')).toBe('');
  });
});
