// Signing in (design/user-management.md, Appendix C): the sign-in page's options, the password form, pending users'
// access requests, and what users see of their sessions and sign-in methods.
import { queryOptions } from "@tanstack/react-query";

import { http } from "../api/http";
import { userQuery, logged_out_user, setUser } from "../api/queries";


// Where to go after signing in: only our own pages, like the server's safe_redirect_url. Never back to /login.
export const safeNext = next => {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return null;
  if (/^\/login(?:[/?#]|$)/.test(next)) return null;
  return next;
};

// /login?next=<the current page>
export const loginUrl = (next = `${window.location.pathname}${window.location.search}${window.location.hash}`, extra = {}) => {
  const params = new URLSearchParams();
  const safe = safeNext(next);
  if (safe && safe !== '/') params.set('next', safe);
  for (const [key, value] of Object.entries(extra))
    if (value !== undefined && value !== null) params.set(key, value);
  const query = params.toString();
  return `/login${query ? `?${query}` : ''}`;
};


// {providers: [{id, type, kind: "password"|"redirect", name, recommended, start_url}], password_form, local_signup, auto_redirect, setup_required}
// `start_url` comes back to `next` once signed in. `local`: also the password form, for break-glass admins.
export const providersQuery = ({ next = null, local = false } = {}) => queryOptions({
  queryKey: ['auth', 'providers', { next, local }],
  queryFn: async ({ signal }) => {
    let data;
    try {
      data = (await http.get('/api/v1/auth/providers', { params: { next: next ?? undefined, local: local ? 1 : undefined }, signal })).data;
    } catch (error) {
      // servers that predate single sign-on only have the password form
      if (error?.response?.status === 404) return { providers: [], password_form: true, local_signup: false, auto_redirect: false };
      throw error;
    }
    return {
      providers: Array.isArray(data?.providers) ? data.providers : [],
      password_form: data?.password_form ?? true,
      local_signup: !!data?.local_signup,
      auto_redirect: !!data?.auto_redirect,
      // a new server: its first account is the admin's, on /setup
      setup_required: !!data?.setup_required,
    };
  },
  staleTime: 60 * 1000,
});

// The buttons, in the server's order: admins choose it (Admin → Sign-in)
export const redirectProviders = providers => providers
  .filter(provider => provider.kind === 'redirect' && provider.start_url);


// Full-page navigations (to the identity provider), in one place so that tests can follow them.
// `replace`: the back button doesn't come back to a page that redirects again.
export const goTo = (url, { replace = false } = {}) => replace ? window.location.replace(url) : window.location.assign(url);


// The password form. Resolves to the server's answer: {user_id, user_name, full_name, email, login_type, is_admin, status}.
// Pending users get a session too: they see the pending page, and can say why they need access.
export const signIn = async (queryClient, { username, password }) => {
  const form = new FormData();
  form.set('username', username ?? '');
  form.set('password', password ?? '');
  const { data } = await http.post('/api/v1/user/auth/', form);
  if (data?.status !== 'pending') {
    const { user_id, user_name, full_name, email, login_type, is_admin } = data ?? {};
    setUser(queryClient, { ...logged_out_user, is_logged: true, user_name, email, login_type, full_name, user_id, is_admin: !!is_admin });
  }
  // the server knows more about us: whether we are an admin, the pending account's request...
  await queryClient.invalidateQueries({ queryKey: userQuery.queryKey });
  return data;
};

export const signUp = async ({ user_name, full_name, email, password }) => {
  const form = new FormData();
  form.set('user_name', user_name ?? '');
  form.set('full_name', full_name ?? '');
  form.set('email', email ?? '');
  form.set('password', password ?? '');
  return (await http.post('/api/v1/user/signup/', form)).data;
};

export const signOut = async queryClient => {
  await http.post('/api/v1/user/logout/');
  setUser(queryClient, logged_out_user);
};


// Pending users: their request to the admins, created when they first signed in. => the request
export const sendAccessRequest = async (queryClient, message) => {
  const { data } = await http.post('/api/v1/user/access-request', { message });
  const user = queryClient.getQueryData(userQuery.queryKey);
  if (user?.pending) queryClient.setQueryData(userQuery.queryKey, { ...user, pending: { ...user.pending, request: data } });
  return data;
};


// Settings → Sessions: the browsers where users are signed in
export const sessionsQuery = queryOptions({
  queryKey: ['sessions', 'mine'],
  queryFn: async ({ signal }) => (await http.get('/api/v1/user/sessions', { signal })).data?.sessions ?? [],
  staleTime: 30 * 1000,
});

export const revokeSession = async (queryClient, session) => {
  const { data } = await http.delete(`/api/v1/user/sessions/${session.id}`);
  if (session.current) setUser(queryClient, logged_out_user);
  else queryClient.invalidateQueries({ queryKey: ['sessions'] });
  queryClient.invalidateQueries({ queryKey: ['audit'] });
  return data;
};


// Signs out every other browser
export const revokeOtherSessions = async queryClient => {
  const { data } = await http.delete('/api/v1/user/sessions');
  queryClient.invalidateQueries({ queryKey: ['sessions'] });
  queryClient.invalidateQueries({ queryKey: ['audit'] });
  return data;
};


// Settings → Sign-in methods: {identities, linkable: providers users can add}
export const identitiesQuery = queryOptions({
  queryKey: ['identities', 'mine'],
  queryFn: async ({ signal }) => {
    const { data } = await http.get('/api/v1/user/identities', { signal });
    return { identities: data?.identities ?? [], linkable: data?.linkable ?? [] };
  },
  staleTime: 30 * 1000,
});

export const unlinkIdentity = async (queryClient, id) => {
  const { data } = await http.delete(`/api/v1/user/identities/${id}`);
  queryClient.invalidateQueries({ queryKey: ['identities'] });
  queryClient.invalidateQueries({ queryKey: ['audit'] });
  return data;
};

// Linking goes through the provider, then comes back to /settings/sign-in
export const linkUrl = provider => {
  const start = provider.start_url || `/api/v1/auth/oidc/${encodeURIComponent(provider.id)}/start`;
  return `${start}${start.includes('?') ? '&' : '?'}link=1`;
};


// A new server, without accounts: the setup page creates its first admin (backend/first_admin.py).
// => {open, default_user_name, min_password_length}
export const setupQuery = queryOptions({
  queryKey: ['setup'],
  queryFn: async ({ signal }) => (await http.get('/api/v1/setup', { signal })).data,
  staleTime: 0,
});

// {token, user_name, password, full_name, email} => the new admin, signed in
export const setUp = async (queryClient, body) => {
  const { data } = await http.post('/api/v1/setup', body);
  const { user_id, user_name, full_name, email } = data ?? {};
  setUser(queryClient, { ...logged_out_user, is_logged: true, user_name, email, login_type: 'LOCAL', full_name, user_id, is_admin: true });
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: userQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: ['config'] }),
    queryClient.invalidateQueries({ queryKey: ['setup'] }),
    queryClient.invalidateQueries({ queryKey: ['auth', 'providers'] }),
  ]);
  return data;
};

// Local accounts: {current_password, new_password} => {signed_out: the other browsers}
export const changePassword = async (queryClient, body) => {
  const { data } = await http.post('/api/v1/user/password', body);
  queryClient.invalidateQueries({ queryKey: ['sessions'] });
  queryClient.invalidateQueries({ queryKey: ['audit'] });
  return data;
};
