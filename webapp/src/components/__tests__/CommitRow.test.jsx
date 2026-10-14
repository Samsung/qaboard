/**
 * Tests for the commits in lists of commits.
 * Run with: cd webapp && npm test -- CommitRow
 */
import { screen } from '@testing-library/react';
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

const renderRow = () => renderWithProviders(
  <MemoryRouter><CommitRow commit={commit} project="group/proj" project_data={project_data} /></MemoryRouter>,
  { siteConfig: {} },
);


describe('CommitRow', () => {
  it('links to the commit, its branch and its committer', () => {
    renderRow();
    expect(screen.getByText('Faster denoising')).toBeInTheDocument();
    expect(screen.getByText('feature/denoise').closest('a')).toHaveAttribute('href', '/group/proj/commits/feature/denoise');
    expect(screen.getByText('by alice').closest('a')).toHaveAttribute('href', '/group/proj/committer/alice');
    // we compare with the same batch in the reference
    expect(screen.getByText('3 nightly results').closest('a')).toHaveAttribute('href', '/group/proj/commit/abcdef1234567890?batch=nightly&batch_ref=nightly');
  });

  it("doesn't change the project's data", () => {
    renderRow();
    expect(project_data.data.git.web_url).toBeUndefined();
    expect(screen.getByText('abcdef12')).toHaveAttribute('href', 'https://gitlab.com/group/proj/commit/abcdef1234567890');
  });
});
