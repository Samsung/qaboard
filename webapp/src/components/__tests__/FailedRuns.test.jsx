/**
 * Tests for the callout about the runs that failed, and the filters it sets.
 * Run with: cd webapp && npm test -- FailedRuns
 */
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test-utils';
import { BatchStatusMessages } from '../messages';
import { match_query, shows_only_failed, only_failed_filter, without_failed_filter, only_run_filter } from '../../utils';

const run = (id, path, more = {}) => ({ id, test_input_path: path, test_input_database: 'db', configurations: [], is_failed: true, output_dir_url: `/s/${id}`, ...more });
const batch_of = runs => ({
  id: 1,
  batch_dir_url: '/s/batch',
  data: {},
  outputs: Object.fromEntries(runs.map(r => [r.id, r])),
  filtered: { outputs: runs.map(r => `${r.id}`), running_outputs: 0, pending_outputs: 0, deleted_outputs: 0 },
});
const render = (runs, filter = '') => renderWithProviders(
  <BatchStatusMessages project="p" commit={{ id: 'abc' }} batch={batch_of(runs)} filter={filter}/>,
  { user: { is_logged: true, user_name: 'alice' } },
);
const url_filter = () => new URLSearchParams(window.location.search).get('filter');

beforeEach(() => window.history.replaceState(null, '', '/p/commit/abc'));


describe('the failed runs', () => {
  it('lists a few failed runs, with links to their logs', () => {
    render([run(1, 'a.raw'), run(2, 'b.raw'), run(3, 'ok.raw', { is_failed: false })]);
    expect(screen.getByText('2 failed')).toBeInTheDocument();
    expect(screen.getByText('a.raw').closest('a')).toHaveAttribute('href', '/s/1/log.txt');
    expect(screen.getAllByLabelText('Show only this run')).toHaveLength(2);
    expect(screen.queryByText(/List the/)).not.toBeInTheDocument();
  });

  it('filters the page to show one run', async () => {
    render([run(1, 'a.raw'), run(2, 'b.raw')], 'night');
    fireEvent.click(screen.getAllByLabelText('Show only this run')[1]);
    await waitFor(() => expect(url_filter()).toBe('night id:2'));
  });

  it('collapses a long list, and filters the page to show only the failed runs', async () => {
    const runs = Array.from({ length: 40 }, (_, i) => run(i + 1, `input-${i + 1}.raw`));
    render(runs, 'night');
    expect(screen.getByText('40 failed')).toBeInTheDocument();
    expect(screen.queryByText('input-1.raw')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('List the 40 runs'));
    expect(screen.getByText('input-40.raw')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Hide the list'));
    expect(screen.queryByText('input-40.raw')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Show only the failed runs'));
    await waitFor(() => expect(url_filter()).toBe('night status:failed'));
  });

  it('shows all the runs again', async () => {
    render(Array.from({ length: 10 }, (_, i) => run(i + 1, `input-${i + 1}.raw`)), 'night status:failed');
    expect(screen.queryByText('Show only the failed runs')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Show all the runs'));
    await waitFor(() => expect(url_filter()).toBe('night'));
  });

  it("doesn't count the failed evaluations of automated tunings", () => {
    render([run(1, 'a.raw', { output_type: 'optim_iteration' })]);
    expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
  });
});


describe('the failed runs filters', () => {
  it('adds and removes status:failed', () => {
    expect(only_failed_filter('')).toBe('status:failed');
    expect(only_failed_filter(' night  -windows ')).toBe('night -windows status:failed');
    expect(only_failed_filter('night status:failed')).toBe('night status:failed');
    expect(shows_only_failed('night Status:Failed')).toBe(true);
    expect(shows_only_failed('-status:failed')).toBe(false);
    expect(without_failed_filter('night status:failed -windows')).toBe('night -windows');
  });

  it('keeps one run', () => {
    expect(only_run_filter('night id:4', 12)).toBe('night id:12');
  });

  it('matches run ids exactly', () => {
    expect(match_query('id:12')('a.raw id:12')).toBe(true);
    expect(match_query('id:12')('a.raw id:123')).toBe(false);
    expect(match_query('-id:12')('a.raw id:123')).toBe(true);
    expect(match_query('-id:12')('a.raw id:12')).toBe(false);
    // other tokens are still substrings
    expect(match_query('id:1')('a.raw id:123')).toBe(false);
    expect(match_query('raw')('a.raw id:123')).toBe(true);
  });
});
