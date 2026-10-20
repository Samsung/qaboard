// A small HTTP client on top of fetch.
//
// It replaces axios with the same call shapes, so existing code reads the same:
//   const { data } = await http.get('/api/v1/commits', { params: { project }, signal })
//   await http.post('/api/v1/batch/redo/', { id })
// - responses have { data, status, statusText, headers }
// - non-2xx responses throw an HttpError, with error.response = { status, statusText, data, headers }
// - cancel with an AbortController's signal, then check isAbort(error)

export class HttpError extends Error {
  constructor(response) {
    super(`Request failed with status code ${response.status}`);
    this.name = 'HttpError';
    this.response = response;
  }
}

export const isAbort = error => error?.name === 'AbortError';

// Like axios: skips null/undefined, `key[]=` for arrays, ISO strings for dates, JSON for objects
export const serializeParams = params => {
  const search = new URLSearchParams();
  const value_to_string = value => {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value)
        if (v !== undefined && v !== null) search.append(`${key}[]`, value_to_string(v));
    } else {
      search.append(key, value_to_string(value));
    }
  }
  return search.toString();
};

export const buildUrl = (url, params) => {
  const query = serializeParams(params);
  if (!query) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
};

// responseType: 'auto' (JSON when it parses, else text, like axios), 'json', 'text', 'blob', 'arraybuffer'
const parseBody = async (response, responseType) => {
  if (response.status === 204 || response.status === 205) return null;
  if (responseType === 'blob') return response.blob();
  if (responseType === 'arraybuffer') return response.arrayBuffer();
  const text = await response.text();
  if (responseType === 'text') return text;
  if (responseType === 'json') return text ? JSON.parse(text) : null;
  if (!text) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

// Told about 401 answers, e.g. to ask users to sign in (see components/authentication/login.jsx), with their body:
// {error: "<a sentence for people>", reason: "sign_in_required"...}.
// `background` requests are those users didn't ask for: status polling, pre-flight checks...
let unauthorized_handler = null;
export const onUnauthorized = handler => { unauthorized_handler = handler; };

// When the handler said what 401 answers mean, the toasts of each action don't repeat the server's sentence
// (see toaster.js). We remember the last few.
const handled_messages = new Set();
export const isHandledMessage = message => typeof message === 'string' && [...handled_messages].some(handled => message.includes(handled));
const rememberHandled = data => {
  // what errorMessage() will say
  const message = typeof data?.error === 'string' && data.error ? data.error : reason_messages[data?.reason];
  if (!message) return;
  handled_messages.delete(message);
  handled_messages.add(message);
  if (handled_messages.size > 10) handled_messages.delete(handled_messages.values().next().value);
};

// `keepalive`: the request outlives the page, e.g. to save what changed when users close the tab
export async function request(method, url, { params, data, signal, headers, responseType = 'auto', background = false, keepalive } = {}) {
  const init = { method, signal, headers: { ...headers }, credentials: 'same-origin' };
  if (keepalive) init.keepalive = true;
  if (data !== undefined) {
    if (data instanceof FormData || data instanceof Blob || typeof data === 'string') {
      init.body = data;
    } else {
      init.body = JSON.stringify(data);
      init.headers['Content-Type'] ??= 'application/json';
    }
  }
  const response = await fetch(buildUrl(url, params), init);
  const result = {
    data: await parseBody(response, responseType).catch(error => {
      if (isAbort(error)) throw error;
      return null;
    }),
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  };
  if (!response.ok) {
    // the handler answers whether it told users about it
    if (response.status === 401 && unauthorized_handler?.({ url, background, data: result.data }))
      rememberHandled(result.data);
    throw new HttpError(result);
  }
  return result;
}

export const http = {
  get: (url, options) => request('GET', url, options),
  head: (url, options) => request('HEAD', url, options),
  delete: (url, options) => request('DELETE', url, options),
  post: (url, data, options) => request('POST', url, { ...options, data }),
  put: (url, data, options) => request('PUT', url, { ...options, data }),
};

// Why the server refused, from 401 and 403 answers: {error: "<a sentence>", reason: "<code>"}.
// The server's sentence comes first, those are for servers that only give the code.
export const reason_messages = {
  sign_in_required: "Sign in to do this.",
  token_invalid: "The access token is invalid: create a new one in Settings.",
  token_expired: "The access token expired: create a new one in Settings.",
  token_idle_expired: "The access token expired because it wasn't used for a long time: create a new one in Settings.",
  token_revoked: "The access token was revoked: create a new one in Settings.",
  token_in_url: "Access tokens can't be sent in links: send them in the Authorization header.",
  user_disabled: "Your account is disabled. Ask an admin if you need it.",
  user_pending: "Your account is waiting for an admin's approval.",
  missing_scope: "The access token doesn't allow this.",
  token_project: "The access token can't be used for this project.",
  forbidden_project: "You don't have access to this project.",
  session_required: "Do this from the web app, signed in: access tokens can't.",
  not_admin: "Only admins can do this.",
  cross_site_write: "QA-Board refused a request sent from another site. Reload the page and try again.",
  ingest_token_required: "This server only saves runs sent with an access token: run qa auth login.",
};
export const errorReason = error => error?.response?.data?.reason ?? null;
// Accounts that can't use the server: being signed out isn't the problem
export const is_account_reason = reason => reason === 'user_disabled' || reason === 'user_pending';
export const is_token_reason = reason => typeof reason === 'string' && reason.startsWith('token_');

// A readable message for toasts and error states
// Servers and proxies answer errors with HTML pages: we only keep their status, and keep other texts short
const is_html = text => /<\/?[a-z][^>]*>/i.test(text);
const max_length = 300;
const shorten = text => text.length > max_length ? `${text.slice(0, max_length)}…` : text;

export const errorMessage = error => {
  if (!error) return '';
  const data = error.response?.data;
  if (data?.error) return String(data.error);
  if (data?.reason && reason_messages[data.reason]) return reason_messages[data.reason];
  if (Array.isArray(data?.errors) && data.errors.length > 0) return data.errors.join(' ');
  if (error.response) {
    const status = `${error.response.status} ${error.response.statusText || 'Server error'}`;
    return typeof data === 'string' && data && !is_html(data) ? shorten(`${status}: ${data}`) : status;
  }
  return error.message ?? String(error);
};

// 409: the commit's artifacts are missing. QA-Board may have asked the CI to recreate them.
export const isArtifactsError = error => error?.response?.status === 409 && !!error?.response?.data?.artifacts;
