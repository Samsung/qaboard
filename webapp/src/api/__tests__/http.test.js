import { http, serializeParams, buildUrl, isAbort, errorMessage, errorReason, reason_messages, onUnauthorized, isHandledMessage, is_account_reason, is_token_reason } from '../http';

const respond = (body, { status = 200, headers = {} } = {}) =>
  vi.fn().mockResolvedValue(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }));

afterEach(() => vi.unstubAllGlobals());


test('serializes params like axios did', () => {
  const date = new Date(Date.UTC(2026, 0, 2));
  expect(serializeParams({ a: 1, b: 'x y', c: null, d: undefined, e: true })).toBe('a=1&b=x+y&e=true');
  expect(serializeParams({ from: date })).toBe('from=2026-01-02T00%3A00%3A00.000Z');
  expect(serializeParams({ ids: [1, 2] })).toBe('ids%5B%5D=1&ids%5B%5D=2');
  expect(serializeParams({ o: { k: 1 } })).toBe('o=%7B%22k%22%3A1%7D');
  expect(buildUrl('/api?x=1', { y: 2 })).toBe('/api?x=1&y=2');
  expect(buildUrl('/api', {})).toBe('/api');
});

test('parses JSON, and falls back to text', async () => {
  vi.stubGlobal('fetch', respond({ a: 1 }));
  expect((await http.get('/api')).data).toEqual({ a: 1 });
  vi.stubGlobal('fetch', respond('plain text'));
  expect((await http.get('/file.txt')).data).toBe('plain text');
  vi.stubGlobal('fetch', respond('{"a": 1}'));
  expect((await http.get('/file.json', { responseType: 'text' })).data).toBe('{"a": 1}');
});

test('sends JSON bodies and FormData as is', async () => {
  const fetch = respond({});
  vi.stubGlobal('fetch', fetch);
  await http.post('/api', { id: 1 }, { params: { project: 'p' } });
  expect(fetch).toHaveBeenCalledWith('/api?project=p', expect.objectContaining({ method: 'POST', body: '{"id":1}' }));
  expect(fetch.mock.calls[0][1].headers['Content-Type']).toBe('application/json');
  const form = new FormData();
  await http.post('/login', form);
  expect(fetch.mock.calls[1][1].body).toBe(form);
  expect(fetch.mock.calls[1][1].headers['Content-Type']).toBeUndefined();
});

test('errors carry the response, like axios', async () => {
  vi.stubGlobal('fetch', respond({ error: 'Not your milestone' }, { status: 403 }));
  const error = await http.post('/api', {}).catch(e => e);
  expect(error.response.status).toBe(403);
  expect(error.response.data.error).toBe('Not your milestone');
  expect(errorMessage(error)).toBe('Not your milestone');
});

test('requests can be aborted', async () => {
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn((url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))));
  const request = http.get('/slow', { signal: controller.signal });
  controller.abort();
  expect(isAbort(await request.catch(e => e))).toBe(true);
});


describe('401 and 403 reasons', () => {
  afterEach(() => onUnauthorized(null));

  test("messages are the server's sentence, else they say what the reason means", async () => {
    vi.stubGlobal('fetch', respond({ error: 'Your token expired on 2026-09-01: run qa auth login.', reason: 'token_expired' }, { status: 401 }));
    const error = await http.get('/api/v1/commit/').catch(e => e);
    expect(errorMessage(error)).toBe('Your token expired on 2026-09-01: run qa auth login.');
    expect(errorReason(error)).toBe('token_expired');
    vi.stubGlobal('fetch', respond({ reason: 'not_admin' }, { status: 403 }));
    expect(errorMessage(await http.get('/api/v1/admin/users').catch(e => e))).toBe(reason_messages.not_admin);
    // unknown reasons fall back to the status
    vi.stubGlobal('fetch', respond({ reason: 'something_new' }, { status: 403, headers: {} }));
    expect(errorMessage(await http.get('/api').catch(e => e))).toMatch(/^403/);
  });

  test('401 answers reach the handler with their body, and their sentence is said once', async () => {
    // it showed a toast
    const handler = vi.fn(() => true);
    onUnauthorized(handler);
    const body = { error: 'Log in to redo runs.', reason: 'sign_in_required' };
    vi.stubGlobal('fetch', respond(body, { status: 401 }));
    await http.post('/api/v1/batch/redo/', {}).catch(e => e);
    expect(handler).toHaveBeenCalledWith({ url: '/api/v1/batch/redo/', background: false, data: body });
    // the toasts of each action are skipped (see toaster.js)
    expect(isHandledMessage('Could not redo: Log in to redo runs.')).toBe(true);
    expect(isHandledMessage('Something else')).toBe(false);
    // when it says nothing (e.g. logging in), the actions say it
    onUnauthorized(() => false);
    vi.stubGlobal('fetch', respond({ error: 'Wrong user name or password.', reason: 'invalid_credentials' }, { status: 401 }));
    await http.post('/api/v1/user/auth/', {}).catch(e => e);
    expect(isHandledMessage('Wrong user name or password.')).toBe(false);
  });

  test("403 answers don't log users out", async () => {
    const handler = vi.fn();
    onUnauthorized(handler);
    vi.stubGlobal('fetch', respond({ error: "You can't access this project.", reason: 'forbidden_project' }, { status: 403 }));
    const error = await http.get('/api/v1/project').catch(e => e);
    expect(handler).not.toHaveBeenCalled();
    expect(errorMessage(error)).toBe("You can't access this project.");
    expect(isHandledMessage("You can't access this project.")).toBe(false);
  });

  test('account and token reasons', () => {
    expect(is_account_reason('user_disabled')).toBe(true);
    expect(is_account_reason('user_pending')).toBe(true);
    expect(is_account_reason('sign_in_required')).toBe(false);
    expect(is_token_reason('token_revoked')).toBe(true);
    expect(is_token_reason('token_in_url')).toBe(true);
    expect(is_token_reason('forbidden_project')).toBe(false);
  });
});
