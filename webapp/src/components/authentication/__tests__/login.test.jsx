/**
 * Signed-out users: actions are disabled with a "Sign in" suggestion, and 401 answers show one clear toast.
 * Run with: cd webapp && npm test -- login
 */
import { act, render, screen, fireEvent } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';

import { LoginHint, LoginMenuItem, handleUnauthorized } from '../login';
import { history } from '../../../router';
import { userQuery, logged_out_user } from '../../../api/queries';
import { request, onUnauthorized } from '../../../api/http';

const makeClient = is_logged => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(userQuery.queryKey, is_logged ? { ...logged_out_user, is_logged: true, user_name: 'alice' } : logged_out_user);
  return queryClient;
};


describe('login suggestions', () => {
  it('go to the sign-in page, which comes back here', () => {
    act(() => history.replace('/group/project/commit/abc?batch=default'));
    render(<><LoginHint/><LoginMenuItem/></>);
    fireEvent.click(screen.getByText('Sign in'));
    expect(history.location.pathname).toBe('/login');
    expect(new URLSearchParams(history.location.search).get('next')).toBe('/group/project/commit/abc?batch=default');
    // not again from the sign-in page
    fireEvent.click(screen.getByText('Sign in to redo, rename or delete'));
    expect(history.location.pathname).toBe('/login');
    expect(new URLSearchParams(history.location.search).get('next')).toBe('/group/project/commit/abc?batch=default');
  });
});


describe('401 answers', () => {
  it('show one toast with a "Sign in" button', () => {
    const toaster = { show: vi.fn() };
    const handle = handleUnauthorized(makeClient(false), toaster);
    handle({ url: '/api/v1/batch/redo/' });
    handle({ url: '/api/v1/output/1/' });
    expect(toaster.show).toHaveBeenCalledTimes(2);
    const [props, key] = toaster.show.mock.calls[0];
    expect(props.message).toBe('Sign in to do this.');
    expect(props.action.text).toBe('Sign in');
    // the same key: the second toast replaces the first
    expect(key).toBe('login-required');
    expect(toaster.show.mock.calls[1][1]).toBe('login-required');
  });

  it('log out when the session expired', () => {
    const toaster = { show: vi.fn() };
    const queryClient = makeClient(true);
    handleUnauthorized(queryClient, toaster)({ url: '/api/v1/batch/redo/' });
    expect(queryClient.getQueryData(userQuery.queryKey).is_logged).toBe(false);
    expect(toaster.show.mock.calls[0][0].message).toMatch(/session expired/);
  });

  it('are silent for background requests and when logging in', () => {
    const toaster = { show: vi.fn() };
    const queryClient = makeClient(true);
    handleUnauthorized(queryClient, toaster)({ url: '/api/v1/commit/abc/batch/check', background: true });
    expect(toaster.show).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(userQuery.queryKey).is_logged).toBe(false);
    handleUnauthorized(queryClient, toaster)({ url: '/api/v1/user/auth/' });
    expect(toaster.show).not.toHaveBeenCalled();
  });

  it('show the reason of disabled and pending accounts, without "Sign in"', () => {
    const toaster = { show: vi.fn() };
    const queryClient = makeClient(true);
    handleUnauthorized(queryClient, toaster)({ url: '/api/v1/user/tokens', data: { error: 'Your account was disabled by an admin.', reason: 'user_disabled' } });
    expect(queryClient.getQueryData(userQuery.queryKey)).toMatchObject({ is_logged: false, reason: 'user_disabled' });
    const [props, key] = toaster.show.mock.calls[0];
    expect(props.message).toBe('Your account was disabled by an admin.');
    expect(props.action).toBeUndefined();
    expect(key).toBe('login-required');
  });

  it("don't log out for a broken token: the session may be fine", () => {
    const toaster = { show: vi.fn() };
    const queryClient = makeClient(true);
    handleUnauthorized(queryClient, toaster)({ url: '/api/v1/commit/abc', data: { error: 'Your token expired on 2026-09-01.', reason: 'token_expired' } });
    expect(queryClient.getQueryData(userQuery.queryKey).is_logged).toBe(true);
    expect(toaster.show.mock.calls[0][0].message).toBe('Your token expired on 2026-09-01.');
  });

  it('log out on the new endpoints under /api/v1/user/', () => {
    const toaster = { show: vi.fn() };
    const queryClient = makeClient(true);
    handleUnauthorized(queryClient, toaster)({ url: '/api/v1/user/tokens', data: { error: 'Sign in to do this.', reason: 'sign_in_required' } });
    expect(queryClient.getQueryData(userQuery.queryKey).is_logged).toBe(false);
    expect(toaster.show.mock.calls[0][0].message).toMatch(/session expired/);
  });

  it('reach the handler from the http client, which still throws', async () => {
    const handler = vi.fn();
    onUnauthorized(handler);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'You need to be logged-in to do this.' }), { status: 401 }));
    await expect(request('POST', '/api/v1/batch/redo/', { background: true })).rejects.toMatchObject({ response: { status: 401 } });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ url: '/api/v1/batch/redo/', background: true }));
    onUnauthorized(null);
    vi.restoreAllMocks();
  });
});
