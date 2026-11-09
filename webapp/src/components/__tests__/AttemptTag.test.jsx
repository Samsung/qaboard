/**
 * Runs that were done again say so, with how their earlier attempts ended.
 * Run with: cd webapp && npm test -- AttemptTag
 */
import { screen, fireEvent } from '@testing-library/react';

import { AttemptTag, previousAttemptText, previousMetricsText } from '../AttemptTag';
import { attemptLogs, doneAgainInPlace } from '../../utils/attempts';
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

test('earlier attempts show what they measured, and where their logs are', async () => {
  const previous_attempts = [{ attempt: 1, status: 'failed', metrics: { is_failed: true, compute_time: 12.3, psnr: 30.123456, passed: false, notes: 'text' } }];
  renderWithProviders(<AttemptTag data={{ attempt: 2, previous_attempts, attempt_logs: [1] }}/>);
  fireEvent.mouseEnter(screen.getByTestId('attempt-tag'));
  expect(await screen.findByText('psnr 30.12 · passed false')).toBeInTheDocument();
  expect(screen.getByText('The logs of earlier attempts are in the Logs view.')).toBeInTheDocument();
});

test('runs done again in the same folder have no attempt number', async () => {
  renderWithProviders(<AttemptTag data={{ previous_attempts: [{ attempt: 1, status: 'success', in_place: true, user: 'alice' }] }}/>);
  expect(screen.getByText('done again')).toBeInTheDocument();
  fireEvent.mouseEnter(screen.getByTestId('attempt-tag'));
  expect(await screen.findByText('An earlier run in the same folder succeeded, by alice')).toBeInTheDocument();
});

test('helpers', () => {
  expect(previousMetricsText({ a: 1, b: 2, c: 3 }, 2)).toBe('a 1 · b 2 (+1 more)');
  expect(previousMetricsText({ is_failed: false })).toBe(null);
  expect(previousMetricsText(undefined)).toBe(null);
  expect(attemptLogs({ data: { attempt_logs: [1, 3, 3, 'x', 0] } })).toEqual([{ attempt: 3, name: 'log.attempt3.txt' }, { attempt: 1, name: 'log.attempt1.txt' }]);
  expect(attemptLogs({})).toEqual([]);
  expect(doneAgainInPlace({ data: { previous_attempts: [{ attempt: 1 }, null, { in_place: true }] } })).toBe(true);
  expect(doneAgainInPlace({ data: { attempt: 2, previous_attempts: [{ attempt: 1 }] } })).toBe(false);
  expect(doneAgainInPlace(undefined)).toBe(false);
});

test('sentences', () => {
  expect(previousAttemptText({ attempt: 2, status: 'success', user: 'alice' })).toBe('Attempt 2 succeeded, by alice');
  expect(previousAttemptText({ attempt: 1, status: 'failed', started_at: 'not a date' })).toBe('Attempt 1 failed');
  expect(previousAttemptText({})).toBe('Attempt ? ended');
});
