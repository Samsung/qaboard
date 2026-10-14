/**
 * Logged-out users: actions are disabled with a "Log in" suggestion, and 401 answers show one clear toast.
 * Run with: cd webapp && npm test -- login
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';

import { LoginHint, LoginMenuItem, handleUnauthorized, registerLoginHandler } from '../login';
import { userQuery, logged_out_user } from '../../../api/queries';
import { request, onUnauthorized } from '../../../api/http';

const makeClient = is_logged => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(userQuery.queryKey, is_logged ? { ...logged_out_user, is_logged: true, user_name: 'alice' } : logged_out_user);
  return queryClient;
};


describe('login suggestions', () => {
  it('open the login dialog', () => {
    const handler = vi.fn();
    const unregister = registerLoginHandler(handler);
    render(<><LoginHint/><LoginMenuItem/></>);
    fireEvent.click(screen.getByText('Log in'));
    fireEvent.click(screen.getByText('Log in to redo, rename or delete'));
    expect(handler).toHaveBeenCalledTimes(2);
    unregister();
  });
});


describe('401 answers', () => {
  it('show one toast with a "Log in" button', () => {
    const toaster = { show: vi.fn() };
    const handle = handleUnauthorized(makeClient(false), toaster);
    handle({ url: '/api/v1/batch/redo/' });
    handle({ url: '/api/v1/output/1/' });
    expect(toaster.show).toHaveBeenCalledTimes(2);
    const [props, key] = toaster.show.mock.calls[0];
    expect(props.message).toBe('Log in to do this.');
    expect(props.action.text).toBe('Log in');
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

  it('reach the handler from the http client, which still throws', async () => {
    const handler = vi.fn();
    onUnauthorized(handler);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'You need to be logged-in to do this.' }), { status: 401 }));
    await expect(request('POST', '/api/v1/batch/redo/', { background: true })).rejects.toMatchObject({ response: { status: 401 } });
    expect(handler).toHaveBeenCalledWith({ url: '/api/v1/batch/redo/', background: true });
    onUnauthorized(null);
    vi.restoreAllMocks();
  });
});
