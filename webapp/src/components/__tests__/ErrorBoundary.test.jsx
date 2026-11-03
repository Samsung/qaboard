import { vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

const analytics = vi.hoisted(() => ({ captureException: vi.fn(() => 'abc123') }));
vi.mock('../../analytics', () => analytics);
const errors = vi.hoisted(() => ({ reloadForNewVersion: vi.fn(() => true) }));
vi.mock('../../errors', async importOriginal => ({ ...await importOriginal(), ...errors }));

import { ErrorBoundary } from '../ErrorBoundary';

let fail = true;
const Broken = ({ error = new Error('boom') }) => {
  if (fail) throw error;
  return <p>fine</p>;
};
const fallback = ({ error, componentStack, eventId, retry, retries }) => <div>
  <p>{error.message} {componentStack ? 'with stack' : ''} {eventId} retries={retries}</p>
  <button onClick={retry}>retry</button>
</div>;

beforeEach(() => {
  fail = true;
  analytics.captureException.mockClear();
  errors.reloadForNewVersion.mockClear();
  // React logs the errors that boundaries catch
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => console.error.mockRestore());

it('shows the fallback and reports the error, with which boundary caught it', () => {
  render(<ErrorBoundary name="viewer" fallback={fallback}><Broken/></ErrorBoundary>);
  expect(screen.getByText('boom with stack abc123 retries=0')).toBeInTheDocument();
  expect(analytics.captureException).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'boom' }),
    expect.objectContaining({ tags: { error_boundary: 'viewer' }, contexts: { react: { componentStack: expect.any(String) } } }),
  );
});

it('renders its children', () => {
  fail = false;
  render(<ErrorBoundary fallback={() => 'error'}><Broken/></ErrorBoundary>);
  expect(screen.getByText('fine')).toBeInTheDocument();
});

it('renders the children again when users retry, and counts the retries', () => {
  render(<ErrorBoundary fallback={fallback}><Broken/></ErrorBoundary>);
  fireEvent.click(screen.getByText('retry'));
  expect(screen.getByText(/retries=1/)).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByText('retry'));
  expect(screen.getByText('fine')).toBeInTheDocument();
});

it('renders the children again when its keys change, e.g. users go to another page', () => {
  const Page = () => {
    const [page, setPage] = useState('a');
    return <>
      <button onClick={() => { fail = false; setPage('b'); }}>navigate</button>
      <ErrorBoundary resetKeys={[page]} fallback={() => 'crashed'}><Broken/></ErrorBoundary>
    </>;
  };
  render(<Page/>);
  expect(screen.getByText('crashed')).toBeInTheDocument();
  fireEvent.click(screen.getByText('navigate'));
  expect(screen.getByText('fine')).toBeInTheDocument();
});

it('reloads once, without reporting, when a chunk of a previous version is gone', () => {
  const error = new TypeError('Failed to fetch dynamically imported module: /assets/plotly-abc.js');
  const { container } = render(<ErrorBoundary fallback={() => 'crashed'}><Broken error={error}/></ErrorBoundary>);
  expect(errors.reloadForNewVersion).toHaveBeenCalled();
  expect(analytics.captureException).not.toHaveBeenCalled();
  expect(container).toBeEmptyDOMElement();
});

it('reports missing chunks when reloading did not help', () => {
  errors.reloadForNewVersion.mockReturnValueOnce(false);
  const error = new TypeError('Importing a module script failed.');
  render(<ErrorBoundary fallback={() => 'crashed'}><Broken error={error}/></ErrorBoundary>);
  expect(screen.getByText('crashed')).toBeInTheDocument();
  expect(analytics.captureException).toHaveBeenCalled();
});
