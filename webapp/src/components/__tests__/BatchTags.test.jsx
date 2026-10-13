/**
 * The counters under the commit bars' filter boxes.
 * Run with: cd webapp && npm test -- BatchTags
 */
import { render, screen } from '@testing-library/react';

import { BatchTags } from '../CommitNavbar';

const counts = (valid_outputs, failed_outputs = 0) => ({ valid_outputs, running_outputs: 0, pending_outputs: 0, failed_outputs });


describe('BatchTags', () => {
  it('counts the runs left by the filter', () => {
    render(<BatchTags batch={counts(8, 2)} />);
    expect(screen.getByText('8 outputs')).toBeInTheDocument();
    expect(screen.getByText('2 crashed')).toBeInTheDocument();
  });

  it('says "1 output"', () => {
    render(<BatchTags batch={counts(1)} />);
    expect(screen.getByText('1 output')).toBeInTheDocument();
  });
});
