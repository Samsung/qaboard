import { vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const analytics = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../../analytics', () => analytics);

import { ErrorBoundary } from '../ErrorBoundary';

const Broken = () => { throw new Error('boom') };

it('shows the fallback and reports the error', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const fallback = ({ error, componentStack }) => <p>{error.message} {componentStack ? 'with stack' : ''}</p>;
  render(<ErrorBoundary fallback={fallback}><Broken/></ErrorBoundary>);
  expect(screen.getByText('boom with stack')).toBeInTheDocument();
  expect(analytics.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }), expect.anything());
  console.error.mockRestore();
});

it('renders its children', () => {
  render(<ErrorBoundary fallback={() => 'error'}><p>fine</p></ErrorBoundary>);
  expect(screen.getByText('fine')).toBeInTheDocument();
});
