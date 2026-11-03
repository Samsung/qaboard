import { vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';

const analytics = vi.hoisted(() => ({ captureFeedback: vi.fn(() => true), reportsErrors: vi.fn(() => false) }));
vi.mock('../../analytics', () => analytics);

import { renderWithProviders } from '../../test-utils';
import { PageErrorFallback, ViewerErrorFallback } from '../ErrorFallback';

const error = new TypeError("Cannot read properties of undefined (reading 'width')");
const props = { error, componentStack: '\n    at ImageViewer', eventId: '0123456789abcdef0123456789abcdef' };

beforeEach(() => {
  analytics.captureFeedback.mockClear();
  analytics.reportsErrors.mockReturnValue(false);
});
afterEach(() => vi.unstubAllGlobals());

it('says what happened, and lets users try again', () => {
  const retry = vi.fn();
  renderWithProviders(<PageErrorFallback {...props} retry={retry}/>);
  expect(screen.getByRole('heading', { name: 'This page crashed' })).toHaveFocus();
  expect(document.title).toBe('Something went wrong · QA-Board');
  expect(screen.getByText(/not something you did/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(retry).toHaveBeenCalled();
  // the error is in the details, collapsed
  fireEvent.click(screen.getByRole('button', { name: 'Technical details' }));
  expect(screen.getByText(/Error: TypeError: Cannot read properties/)).toBeInTheDocument();
});

it('reloads when trying again did not help', () => {
  renderWithProviders(<PageErrorFallback {...props} retry={vi.fn()} retries={1}/>);
  expect(screen.getByRole('button', { name: 'Reload the page' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
});

it('asks users to report errors that were not sent to Sentry, with the details', () => {
  renderWithProviders(<PageErrorFallback {...props} retry={vi.fn()}/>, { siteConfig: { support_url: 'mailto:qa@example.com' } });
  const report = screen.getByRole('button', { name: 'Report the problem' });
  expect(report.getAttribute('href')).toMatch(/^mailto:qa@example\.com\?subject=%5BQA-Board%5D%20TypeError/);
  expect(decodeURIComponent(report.getAttribute('href'))).toContain('Error: TypeError');
  // no reference: there is nowhere to look it up
  expect(decodeURIComponent(report.getAttribute('href'))).not.toContain('Reference');
  expect(screen.queryByText(/were notified/)).not.toBeInTheDocument();
});

it('says that the maintainers were notified, and adds what users were doing to the report', () => {
  analytics.reportsErrors.mockReturnValue(true);
  renderWithProviders(<PageErrorFallback {...props} retry={vi.fn()}/>);
  expect(screen.getByText('The QA-Board maintainers were notified.')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/What were you doing/), { target: { value: 'Opened two batches' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(analytics.captureFeedback).toHaveBeenCalledWith('Opened two batches', props.eventId);
  expect(screen.getByText(/Your note was added/)).toBeInTheDocument();
});

it('says that a new version needs a reload', () => {
  const stale = new TypeError('Failed to fetch dynamically imported module: /assets/a.js');
  renderWithProviders(<PageErrorFallback {...props} error={stale} retry={vi.fn()}/>);
  expect(screen.getByRole('heading', { name: 'QA-Board was updated' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Reload the page' })).toBeInTheDocument();
});

it('says when users are offline', () => {
  vi.stubGlobal('navigator', { ...navigator, onLine: false, userAgent: navigator.userAgent });
  renderWithProviders(<PageErrorFallback {...props} retry={vi.fn()}/>);
  expect(screen.getByText(/You seem to be offline/)).toBeInTheDocument();
});

it('shows which file a viewer could not show, in the run\'s card', () => {
  const retry = vi.fn();
  renderWithProviders(<ViewerErrorFallback {...props} retry={retry} path="output/debug.png"/>);
  expect(screen.getByText('output/debug.png')).toBeInTheDocument();
  expect(screen.getByText(/other files and runs still show/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(retry).toHaveBeenCalled();
});
