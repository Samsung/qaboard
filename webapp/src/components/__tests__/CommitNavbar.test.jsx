/**
 * Tests for the navbars of the commits we compare.
 * Run with: cd webapp && npm test -- CommitNavbar
 */
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import { CommitNavbar } from '../CommitNavbar';
import { commitQuery } from '../../api/queries';
import { selection_from_url } from '../../selection';
import { renderWithProviders } from '../../test-utils';


const commit = {
  id: 'abcdef1234567890',
  message: 'Faster denoising',
  branch: 'feature/denoise',
  committer_name: 'alice',
  authored_datetime: '2026-10-01T10:00:00Z',
  batches: {},
  is_loaded: true,
};
const latest = { id: '9999999999999999', branch: 'feature/denoise', batches: {}, data: {} };

const renderNavbar = (props = {}, search = '') => {
  window.history.replaceState(null, '', `/p/commit/${commit.id}${search}`);
  const selected = selection_from_url({ path: '/:project_id+/commit/:name+', params: { project_id: 'p', name: commit.id } }, search);
  return renderWithProviders(<MemoryRouter>
    <CommitNavbar
      type="new"
      project="p"
      project_data={{ data: { qatools_config: {} }, milestones: {} }}
      commit={commit}
      batch={{ label: 'default', filtered: {} }}
      filter=""
      selected={selected}
      update={() => () => {}}
      {...props}
    />
  </MemoryRouter>, { siteConfig: {} });
};


describe('CommitNavbar', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('selects the latest commit on the branch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(latest), { status: 200 })));
    const { queryClient } = renderNavbar();
    expect(screen.getByDisplayValue('abcdef12')).toBeInTheDocument();
    fireEvent.click(screen.getAllByText('feature/denoise')[0]);
    await waitFor(() => expect(window.location.pathname).toBe(`/p/commit/${latest.id}`));
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/commit/?project=p&branch=feature%2Fdenoise');
    // the page won't fetch it again
    expect(queryClient.getQueryData(commitQuery({ project: 'p', id: latest.id }).queryKey)).toMatchObject({ id: latest.id });
  });

  it('selects commits by id', () => {
    renderNavbar();
    fireEvent.change(screen.getByDisplayValue('abcdef12'), { target: { value: '1234abcd' } });
    expect(window.location.pathname).toBe('/p/commit/1234abcd');
  });

  it('asks before deleting a batch, and says the filter does not apply', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const batch = { id: 3, label: 'nightly', outputs: { 1: {}, 2: {}, 3: {} }, valid_outputs: 3, failed_outputs: 0, filtered: { outputs: [1] } };
    renderNavbar({ commit: { ...commit, batches: { nightly: batch } }, batch, filter: 'indoor' }, '?batch=nightly&filter=indoor');
    fireEvent.click(screen.getByLabelText('Commit and batch actions'));
    fireEvent.click(await screen.findByText('Delete all runs…'));
    const alert = within(await screen.findByRole('alertdialog'));
    expect(alert.getByText('Delete all the 3 runs of nightly?')).toBeInTheDocument();
    expect(alert.getByText("The filter doesn't apply: the whole batch is deleted.")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(alert.getByText('Delete runs'));
    await waitFor(() => expect(fetch.mock.calls.some(([url, init]) => url.startsWith('/api/v1/batch/3/') && init.method === 'DELETE')).toBe(true));
  });

  it("doesn't show placeholders for a commit that failed to load", () => {
    const { container } = renderNavbar({ commit: { id: commit.id, batches: {}, is_loaded: true, error: '500 Internal Server Error' } });
    expect(screen.getByText('Could not load this commit')).toBeInTheDocument();
    expect(screen.getByText('Error')).toBeInTheDocument();
    expect(container.querySelector('.bp6-skeleton')).toBeNull();
  });

  it('says when the reference is the same as the new commit', () => {
    renderNavbar({ type: 'ref', same_as_new: true });
    expect(screen.getByText('Same as new')).toBeInTheDocument();
  });
});
