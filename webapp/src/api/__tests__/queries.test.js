// How often what shows runs waiting or running is refreshed
import { QueryClient } from '@tanstack/react-query';

import { batchesPagesQuery, commitQuery, commitCountsQuery, commitsQuery, findCachedCommit } from '../queries';

const minutes = 60 * 1000;
const commit = ({ pending = 1, valid = 9 } = {}) => ({
  id: 'abc', data: {}, batches: { default: { valid_outputs: valid, pending_outputs: pending, outputs: {} } },
});

let queryClient;
beforeEach(() => {
  queryClient = new QueryClient();
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  queryClient.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// The server answers `body` at `time`: when would the query be refreshed next?
const refreshAt = async (options, time, body) => {
  vi.setSystemTime(time);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
  await queryClient['initialPageParam' in options ? 'fetchInfiniteQuery' : 'fetchQuery']({ ...options, staleTime: 0 });
  return options.refetchInterval(queryClient.getQueryCache().find({ queryKey: options.queryKey }));
};

test('commits with runs waiting are refreshed every 15s, less often while nothing changes', async () => {
  const options = commitQuery({ project: 'p', id: 'abc' });
  expect(await refreshAt(options, 0, commit())).toBe(15 * 1000);
  expect(await refreshAt(options, 15 * 1000, commit())).toBe(15 * 1000);
  expect(await refreshAt(options, 1 * minutes, commit())).toBe(1 * minutes);
  expect(await refreshAt(options, 20 * minutes, commit())).toBe(5 * minutes);
  // a run ended
  expect(await refreshAt(options, 25 * minutes, commit({ valid: 10 }))).toBe(15 * 1000);
  expect(await refreshAt(options, 26 * minutes, commit({ valid: 11, pending: 0 }))).toBe(false);
});

test('big commits are refreshed less often: each refresh downloads all their outputs', async () => {
  const options = commitQuery({ project: 'p', id: 'abc' });
  expect(await refreshAt(options, 0, commit({ valid: 4000, pending: 1000 }))).toBe(75 * 1000);
  expect(await refreshAt(options, 10 * minutes, commit({ valid: 4000, pending: 1000 }))).toBe(5 * minutes);
});

test('so are lists of batches with runs waiting', async () => {
  const options = batchesPagesQuery({ project: 'p' });
  const batches = [{ id: 1, pending_outputs: 3 }];
  expect(await refreshAt(options, 0, batches)).toBe(15 * 1000);
  expect(await refreshAt(options, 3 * minutes, batches)).toBe(3 * minutes);
  expect(await refreshAt(options, 4 * minutes, [{ id: 1, pending_outputs: 0 }])).toBe(false);
});

// Lists of commits share ['commits', project] with the counts, which are no list
test('commits are found in the lists of the cache, next to the counts', () => {
  queryClient.setQueryData(commitCountsQuery({ project: 'p' }).queryKey, { all: 3, mine: 1, without_ci: 0 });
  expect(findCachedCommit(queryClient, 'p', 'abc')).toBeUndefined();
  queryClient.setQueryData(commitsQuery({ project: 'p' }).queryKey, [commit()]);
  expect(findCachedCommit(queryClient, 'p', 'abc')?.id).toBe('abc');
});

// The server tags commits with an ETag: refreshes send it back, and keep what they have when it answers 304
describe('commits refreshed with their ETag', () => {
  const options = commitQuery({ project: 'p', id: 'abc' });
  const fetch_answers = (...responses) => {
    const fetch = vi.fn();
    for (const response of responses) fetch.mockResolvedValueOnce(response);
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };
  const sent_etag = (fetch, call) => fetch.mock.calls[call][1].headers['If-None-Match'];
  const refresh = () => queryClient.fetchQuery({ ...options, staleTime: 0 });

  test('keep what they have when nothing changed', async () => {
    const fetch = fetch_answers(
      new Response(JSON.stringify(commit()), { headers: { ETag: 'W/"v1"' } }),
      new Response(null, { status: 304 }),
    );
    const first = await refresh();
    expect(sent_etag(fetch, 0)).toBeUndefined();
    const second = await refresh();
    expect(sent_etag(fetch, 1)).toBe('W/"v1"');
    expect(second).toBe(first);
    expect(queryClient.getQueryData(options.queryKey)).toBe(first);
  });

  test('send the latest ETag, also when structural sharing keeps the cached data', async () => {
    const fetch = fetch_answers(
      new Response(JSON.stringify(commit()), { headers: { ETag: 'W/"v1"' } }),
      // the same content, with another ETag
      new Response(JSON.stringify(commit()), { headers: { ETag: 'W/"v2"' } }),
      new Response(JSON.stringify(commit({ valid: 10 })), { headers: { ETag: 'W/"v3"' } }),
      new Response(null, { status: 304 }),
    );
    const cached = () => queryClient.getQueryData(options.queryKey);
    await refresh();
    const first = cached();
    await refresh();
    expect(sent_etag(fetch, 1)).toBe('W/"v1"');
    expect(cached()).toBe(first);
    await refresh();
    expect(sent_etag(fetch, 2)).toBe('W/"v2"');
    const changed = cached();
    expect(changed.batches.default.valid_outputs).toBe(10);
    await refresh();
    expect(sent_etag(fetch, 3)).toBe('W/"v3"');
    expect(cached()).toBe(changed);
  });

  test('download everything when the cache has other data, or no ETag', async () => {
    const fetch = fetch_answers(
      new Response(JSON.stringify(commit())),
      new Response(JSON.stringify(commit()), { headers: { ETag: 'W/"v1"' } }),
      new Response(JSON.stringify(commit({ valid: 10 }))),
    );
    await refresh();
    expect(sent_etag(fetch, 0)).toBeUndefined();
    await refresh();
    expect(sent_etag(fetch, 1)).toBeUndefined();
    // e.g. the same commit, fetched for a branch
    queryClient.setQueryData(options.queryKey, commit({ valid: 10 }));
    await refresh();
    expect(sent_etag(fetch, 2)).toBeUndefined();
  });

  test('a 304 without a cached ETag is an error', async () => {
    fetch_answers(new Response(null, { status: 304 }));
    await expect(refresh()).rejects.toThrow('304');
  });
});
