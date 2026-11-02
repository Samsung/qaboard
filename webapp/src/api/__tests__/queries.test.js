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
