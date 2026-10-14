import { http, serializeParams, buildUrl, isAbort, errorMessage } from '../http';

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
