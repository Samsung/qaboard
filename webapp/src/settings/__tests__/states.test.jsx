/**
 * The settings, admin and storage pages' error state.
 * Run with: cd webapp && npm test -- settings/__tests__/states
 */
import { fireEvent, render, screen } from '@testing-library/react';

import { QueryError } from '../states';


const failed = (status, data = {}) => ({ response: { status, statusText: '', data } });

describe('QueryError', () => {
  it('offers to retry server errors', () => {
    const refetch = vi.fn();
    render(<QueryError error={failed(502, { error: 'Bad gateway' })} refetch={refetch} what="your tokens"/>);
    expect(screen.getByText('Could not load your tokens')).toBeInTheDocument();
    expect(screen.getByText('Bad gateway')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    expect(refetch).toHaveBeenCalled();
  });

  it("doesn't offer to retry what won't change, and says what happened", () => {
    const { rerender } = render(<QueryError error={failed(404, { error: 'No such project' })} refetch={() => {}} what="the gate's rules"/>);
    expect(screen.getByText("Could not find the gate's rules")).toBeInTheDocument();
    expect(screen.queryByText('Retry')).not.toBeInTheDocument();
    rerender(<QueryError error={failed(403, { reason: 'forbidden_project' })} refetch={() => {}} what="the project's audit log"/>);
    expect(screen.getByText("You don't have access to the project's audit log")).toBeInTheDocument();
    expect(screen.getByText("You don't have access to this project.")).toBeInTheDocument();
    expect(screen.queryByText('Retry')).not.toBeInTheDocument();
  });

  it('offers to retry rate limits and network failures', () => {
    const { rerender } = render(<QueryError error={failed(429)} refetch={() => {}} what="the exports"/>);
    expect(screen.getByText('Retry')).toBeInTheDocument();
    rerender(<QueryError error={new TypeError('Failed to fetch')} refetch={() => {}} what="the exports"/>);
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });
});
