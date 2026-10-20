/**
 * Runs and batches say who sent them: verified when the server authenticated the sender.
 * Run with: cd webapp && npm test -- SubmittedBy
 */
import { screen, fireEvent } from '@testing-library/react';

import { SubmittedBy, submittedByText } from '../SubmittedBy';
import { renderWithProviders } from '../../test-utils';


test('verified runs say who sent them, and with which token', async () => {
  renderWithProviders(<SubmittedBy data={{ user: 'alice', submitted_by: { user_name: 'alice', token_name: 'ci-bot', via: 'token' } }}/>, { siteConfig: { ingest_auth: 'warn' } });
  expect(screen.getByText('alice')).toBeInTheDocument();
  expect(screen.getByLabelText('verified')).toBeInTheDocument();
  expect(screen.queryByText('unverified')).not.toBeInTheDocument();
  fireEvent.mouseEnter(screen.getByTestId('submitted-by'));
  expect(await screen.findByText('Sent by alice with token ci-bot')).toBeInTheDocument();
});

test('when the claimed user is someone else, we say who really sent it', () => {
  renderWithProviders(<SubmittedBy data={{ user: 'alice', submitted_by: { user_name: 'ci-bot', via: 'token' } }}/>);
  expect(screen.getByText('via ci-bot')).toBeInTheDocument();
});

test('runs without a verified sender are unverified, unless the server accepts anonymous runs', () => {
  const { unmount } = renderWithProviders(<SubmittedBy data={{ user: 'alice' }}/>, { siteConfig: { ingest_auth: 'warn' } });
  expect(screen.getByText('unverified')).toBeInTheDocument();
  unmount();
  renderWithProviders(<SubmittedBy data={{ user: 'alice' }}/>, { siteConfig: { ingest_auth: 'off' } });
  expect(screen.getByText('alice')).toBeInTheDocument();
  expect(screen.queryByText('unverified')).not.toBeInTheDocument();
});

test('sentences', () => {
  expect(submittedByText({ user_name: 'alice', via: 'session' })).toBe('Sent by alice, logged in');
  expect(submittedByText({ user_name: 'alice' })).toBe('Sent by alice');
});
