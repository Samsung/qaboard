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

export async function request(method, url, { params, data, signal, headers, responseType = 'auto' } = {}) {
  const init = { method, signal, headers: { ...headers }, credentials: 'same-origin' };
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
  if (!response.ok) throw new HttpError(result);
  return result;
}

export const http = {
  get: (url, options) => request('GET', url, options),
  head: (url, options) => request('HEAD', url, options),
  delete: (url, options) => request('DELETE', url, options),
  post: (url, data, options) => request('POST', url, { ...options, data }),
  put: (url, data, options) => request('PUT', url, { ...options, data }),
};

// A readable message for toasts and error states
export const errorMessage = error => {
  if (!error) return '';
  const data = error.response?.data;
  if (data?.error) return String(data.error);
  if (error.response) return `${error.response.status} ${error.response.statusText}${typeof data === 'string' && data ? `: ${data}` : ''}`;
  return error.message ?? String(error);
};
