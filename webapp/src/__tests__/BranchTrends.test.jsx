/**
 * Above a branch's commits, its Trends: a card closed until people open it, then as they left it.
 * cd webapp && npm test -- BranchTrends
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { renderWithProviders } from '../test-utils';
import { BranchTrends } from '../CommitsTrends';
import { usePrefsStore } from '../stores/prefs';
import { http } from '../api/http';
import { TEST_DEFINITIONS } from '../trends/generate';

const commit = (id, date, aggregated_metrics) => ({ id, authored_datetime: date, message: id, batches: { default: { aggregated_metrics, outputs: {}, valid_outputs: 1 } } });
const commits = [
  commit('bbbbbbbbbbbb', '2026-11-02T10:00:00Z', { tests_sum: 12, passed_sum: 11, failed_sum: 1 }),
  commit('aaaaaaaaaaaa', '2026-11-01T10:00:00Z', { tests_sum: 10, passed_sum: 10, failed_sum: 0 }),
];
const date_range = [new Date('2026-10-30'), new Date('2026-11-03')];
const render = available_metrics => renderWithProviders(<MemoryRouter>
  <BranchTrends project="group/sdk" branch="main" commits={commits} date_range={date_range} available_metrics={available_metrics} chart={<p>the chart</p>}/>
</MemoryRouter>);

afterEach(() => {
  usePrefsStore.setState({ branchTrendsOpen: false });
  vi.restoreAllMocks();
});

describe('the Trends card of a branch', () => {
  it('is closed by default, and asks for nothing more', () => {
    const get = vi.spyOn(http, 'get');
    render({ ...TEST_DEFINITIONS, bench: { group: 'Benchmarks/codec' } });
    expect(screen.getByText('Tests, benchmarks and metrics over these commits')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show the trends' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Tests failing')).not.toBeInTheDocument();
    expect(screen.queryByText('the chart')).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
    // the Trends page, on the same dates as the list
    expect(screen.getByRole('link', { name: /Trends page/ })).toHaveAttribute('href', '/group/sdk/trends/main?from=2026-10-30&to=2026-11-03');
  });

  it("shows the tests' numbers once opened, and stays open", async () => {
    render(TEST_DEFINITIONS);
    fireEvent.click(screen.getByRole('button', { name: 'Show the trends' }));
    expect(await screen.findByText('Tests failing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide the trends' })).toHaveAttribute('aria-expanded', 'true');
    expect(usePrefsStore.getState().branchTrendsOpen).toBe(true);
  });

  it('asks for the runs when commits have several, and says when they ran the same tests in several configurations', async () => {
    usePrefsStore.setState({ branchTrendsOpen: true });
    const run = (input, mode, tests, failed) => ({ test_input_path: input, configurations: [mode], metrics: { tests, passed: tests - failed, failed } });
    const with_runs = (id, date, failed) => ({ id, authored_datetime: date, message: id, batches: { default: { valid_outputs: 4, outputs: {
      1: run('codec', 'default', 300, failed), 2: run('maps', 'default', 309, 0), 3: run('codec', 'strict', 300, failed), 4: run('maps', 'strict', 309, 0),
    } } } });
    const get = vi.spyOn(http, 'get').mockResolvedValue({ data: [with_runs('bbbbbbbbbbbb', '2026-11-02T10:00:00Z', 1), with_runs('aaaaaaaaaaaa', '2026-11-01T10:00:00Z', 0)] });
    const listed = commits.map(c => ({ ...c, batches: { default: { ...c.batches.default, aggregated_metrics: { tests_sum: 1218, passed_sum: 1216, failed_sum: 2 }, valid_outputs: 4 } } }));
    renderWithProviders(<MemoryRouter>
      <BranchTrends project="group/sdk" branch="main" commits={listed} date_range={date_range} available_metrics={TEST_DEFINITIONS} chart={<p>the chart</p>}/>
    </MemoryRouter>);
    expect(await screen.findByText('609 × 2')).toBeInTheDocument();
    expect(screen.getByText('1 in default · 1 in strict')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/api/v1/commits/main', expect.objectContaining({ params: expect.objectContaining({ with_outputs: true }) }));
  });

  it("shows the chart when the runs' metrics say nothing of groups", async () => {
    usePrefsStore.setState({ branchTrendsOpen: true });
    render({ psnr: { label: 'PSNR' } });
    expect(await screen.findByText('the chart')).toBeInTheDocument();
    expect(screen.queryByText(/Tests, benchmarks/)).not.toBeInTheDocument();
  });
});
