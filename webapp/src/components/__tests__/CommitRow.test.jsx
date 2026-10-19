/**
 * Tests for the commits in lists of commits.
 * Run with: cd webapp && npm test -- CommitRow
 */
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import CommitRow, { CompactCommitList, commit_status } from '../CommitRow';
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
  { siteConfig: {}, milestones: { 'group/proj': [] } },
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


describe('CommitRow, compact', () => {
  const renderCompact = (props = {}) => renderWithProviders(
    <MemoryRouter><CompactCommitList>
      <CommitRow density="compact" commit={commit} project="group/proj" project_data={project_data} {...props} />
    </CompactCommitList></MemoryRouter>,
    { siteConfig: {}, milestones: { 'group/proj': [] } },
  );

  it('shows the same links on one line', () => {
    renderCompact({ commit: { ...commit, message: 'Faster denoising\n\nThe LUT was indexed twice.' } });
    const row = within(screen.getByRole('listitem'));
    // the whole message on hover
    expect(row.getByText('Faster denoising')).toHaveAttribute('title', 'Faster denoising\n\nThe LUT was indexed twice.');
    expect(row.queryByText('The LUT was indexed twice.')).not.toBeInTheDocument();
    expect(row.getByText('abcdef12')).toHaveAttribute('href', 'https://gitlab.com/group/proj/-/commit/abcdef1234567890');
    expect(row.getByText('feature/denoise').closest('a')).toHaveAttribute('href', '/group/proj/commits/feature/denoise');
    expect(row.getByRole('link', { name: 'alice' })).toHaveAttribute('href', '/group/proj/committer/alice');
    expect(row.getByText('3 runs').closest('a')).toHaveAttribute('href', '/group/proj/commit/abcdef1234567890?batch=nightly&batch_ref=nightly');
    expect(row.getByLabelText('Copy the commit hash')).toBeInTheDocument();
    expect(row.getByTitle('3 runs finished')).toBeInTheDocument();
  });

  it('says how many runs failed', () => {
    renderCompact({ commit: { ...commit, batches: { default: { ...commit.batches.nightly, label: 'default', failed_outputs: 2 } } } });
    expect(screen.getByText('2 failed').closest('a')).toHaveAttribute('href', '/group/proj/commit/abcdef1234567890');
    expect(screen.getByTitle('2 failed, 3 finished')).toBeInTheDocument();
  });

  it("summarizes the other batches and the main metric", () => {
    const metrics = { available_metrics: { psnr: { key: 'psnr', label: 'PSNR', short_label: 'PSNR', scale: 1, suffix: ' dB' } }, default_metric: 'psnr' };
    const data = { ...project_data.data, qatools_metrics: metrics };
    const batches = {
      default: { ...commit.batches.nightly, label: 'default', aggregated_metrics: { psnr_median: 37.6, psnr_average: 37.4 } },
      sweep: { ...commit.batches.nightly, label: 'sweep' },
    };
    renderCompact({ commit: { ...commit, batches }, project_data: { data } });
    expect(screen.getByText('+1 batch')).toBeInTheDocument();
    expect(screen.getByText(/avg PSNR/).closest('.bp6-tag')).toHaveTextContent('37.4 dB avg PSNR');
  });

  it("says when there are no results yet", () => {
    renderCompact({ commit: { ...commit, is_recent: true, batches: {} } });
    expect(screen.getAllByText('Waiting for results').length).toBeGreaterThan(0);
  });

  it('shows placeholders while the commit loads', () => {
    renderCompact({ commit: { id: 'abcdef1234567890', batches: {} } });
    expect(document.querySelectorAll('li .bp6-skeleton').length).toBeGreaterThan(2);
  });
});


describe('commit_status', () => {
  const batch = counts => ({ batches: { default: { valid_outputs: 0, pending_outputs: 0, running_outputs: 0, failed_outputs: 0, ...counts } } });
  it('says how the CI batch went', () => {
    expect(commit_status(batch({ valid_outputs: 1 })).label).toBe('1 run finished');
    expect(commit_status(batch({ valid_outputs: 2, failed_outputs: 1 })).icon).toBe('error');
    expect(commit_status(batch({ valid_outputs: 2, pending_outputs: 3, running_outputs: 1 })).label).toBe('1 running, 2 waiting for a runner, 2 finished');
    expect(commit_status({ batches: {}, is_recent: true }).label).toBe('Waiting for results');
    expect(commit_status({ batches: {} }).label).toBe('No results');
  });
});
