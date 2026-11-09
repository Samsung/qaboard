/**
 * Runs that were done again say so, with how their earlier attempts ended.
 * Run with: cd webapp && npm test -- AttemptTag
 */
import { screen, fireEvent } from '@testing-library/react';

import { AttemptTag, previousAttemptText } from '../AttemptTag';
import { renderWithProviders } from '../../test-utils';


test('runs done once show nothing', () => {
  const { container } = renderWithProviders(<AttemptTag data={{ user: 'alice' }}/>);
  expect(container).toBeEmptyDOMElement();
});

test('the attempt, and the earlier attempts on hover', async () => {
  const previous_attempts = [
    { attempt: 1, status: 'failed', started_at: '2026-11-03T10:12:00Z', user: 'ci' },
    { attempt: 2, status: 'unfinished' },
  ];
  renderWithProviders(<AttemptTag data={{ attempt: 3, previous_attempts }}/>);
  expect(screen.getByText('attempt 3')).toBeInTheDocument();
  fireEvent.mouseEnter(screen.getByTestId('attempt-tag'));
  expect(await screen.findByText(/Attempt 1 failed, by ci, /)).toBeInTheDocument();
  expect(screen.getByText("Attempt 2 didn't finish")).toBeInTheDocument();
});

test('runs done again in another directory by an older qa have no attempt number', () => {
  renderWithProviders(<AttemptTag data={{ previous_attempts: [{ attempt: 1, status: 'success' }] }}/>);
  expect(screen.getByText('done again')).toBeInTheDocument();
});

test('sentences', () => {
  expect(previousAttemptText({ attempt: 2, status: 'success', user: 'alice' })).toBe('Attempt 2 succeeded, by alice');
  expect(previousAttemptText({ attempt: 1, status: 'failed', started_at: 'not a date' })).toBe('Attempt 1 failed');
  expect(previousAttemptText({})).toBe('Attempt ? ended');
});
