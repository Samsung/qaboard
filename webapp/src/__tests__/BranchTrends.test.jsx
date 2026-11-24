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
    expect(screen.queryByText('Tests failing')).not.toBeInTheDocument();
    expect(screen.queryByText('the chart')).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Open Trends' })).toHaveAttribute('href', '/group/sdk/trends/main');
  });

  it("shows the tests' numbers once opened, and stays open", async () => {
    render(TEST_DEFINITIONS);
    fireEvent.click(screen.getByText('Trends'));
    expect(await screen.findByText('Tests failing')).toBeInTheDocument();
    expect(usePrefsStore.getState().branchTrendsOpen).toBe(true);
  });

  it("shows the chart when the runs' metrics say nothing of groups", async () => {
    usePrefsStore.setState({ branchTrendsOpen: true });
    render({ psnr: { label: 'PSNR' } });
    expect(await screen.findByText('the chart')).toBeInTheDocument();
  });
});
