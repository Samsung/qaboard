/**
 * Tests for the navbars of the commits we compare.
 * Run with: cd webapp && npm test -- CommitNavbar
 */
import { screen, fireEvent, waitFor } from '@testing-library/react';
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

const renderNavbar = () => {
  window.history.replaceState(null, '', `/p/commit/${commit.id}`);
  const selected = selection_from_url({ path: '/:project_id+/commit/:name+', params: { project_id: 'p', name: commit.id } }, '');
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
});
