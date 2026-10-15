/**
 * Tests for the commits in lists of commits.
 * Run with: cd webapp && npm test -- CommitRow
 */
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import CommitRow from '../CommitRow';
import { renderWithProviders } from '../../test-utils';


const commit = {
  id: 'abcdef1234567890',
  message: 'Faster denoising',
  branch: 'feature/denoise',
  committer_name: 'alice',
  authored_datetime: '2026-10-01T10:00:00Z',
  artifacts_url: '/s/artifacts/abcdef',
  batches: {
    nightly: { label: 'nightly', valid_outputs: 3, pending_outputs: 0, running_outputs: 0, failed_outputs: 0, aggregated_metrics: {} },
  },
};

const project_data = Object.freeze({
  data: Object.freeze({ git: Object.freeze({ path_with_namespace: 'group/proj' }), qatools_config: {}, qatools_metrics: {} }),
});

const renderRow = (props = {}) => renderWithProviders(
  <MemoryRouter><CommitRow commit={commit} project="group/proj" project_data={project_data} {...props} /></MemoryRouter>,
  { siteConfig: {} },
);


describe('CommitRow', () => {
  it('links to the commit, its branch and its committer', () => {
    renderRow();
    expect(screen.getByText('Faster denoising')).toBeInTheDocument();
    expect(screen.getByText('feature/denoise').closest('a')).toHaveAttribute('href', '/group/proj/commits/feature/denoise');
    expect(screen.getByText('by alice').closest('a')).toHaveAttribute('href', '/group/proj/committer/alice');
    // we compare with the same batch in the reference
    expect(screen.getByText('3 runs').closest('a')).toHaveAttribute('href', '/group/proj/commit/abcdef1234567890?batch=nightly&batch_ref=nightly');
  });

  it("doesn't change the project's data", () => {
    renderRow();
    expect(project_data.data.git.web_url).toBeUndefined();
    expect(screen.getByText('abcdef12')).toHaveAttribute('href', 'https://gitlab.com/group/proj/-/commit/abcdef1234567890');
  });

  it("shows the first line of the message as its title", () => {
    renderRow({ commit: { ...commit, message: 'Faster denoising\n\nThe LUT was indexed twice.' } });
    expect(screen.getByText('Faster denoising')).toBeInTheDocument();
    expect(screen.getByText('The LUT was indexed twice.')).toHaveAttribute('title', 'The LUT was indexed twice.');
  });

  it('says how many runs failed', () => {
    renderRow({ commit: { ...commit, batches: { default: { ...commit.batches.nightly, label: 'default', failed_outputs: 2 } } } });
    expect(screen.getByText('2 failed').closest('a')).toHaveAttribute('href', '/group/proj/commit/abcdef1234567890');
  });

  it('asks before deleting all the runs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    renderRow();
    fireEvent.click(screen.getByLabelText('Commit actions'));
    fireEvent.click(await screen.findByText('Delete all runs…'));
    const alert = within(await screen.findByRole('alertdialog'));
    expect(alert.getByText('Delete all the runs of abcdef12?')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(alert.getByText('Delete runs'));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/v1/commit/group/proj/abcdef1234567890/batches/', expect.objectContaining({ method: 'DELETE' })));
    vi.unstubAllGlobals();
  });
});
