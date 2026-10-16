import { QueryClient } from "@tanstack/react-query";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { get, set, del } from "idb-keyval";

import { applySiteConfig } from "./queries";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Failing requests are mostly 404s for commits/batches that don't exist: retrying won't help
      retry: (count, error) => count < 2 && !(error?.response?.status >= 400 && error?.response?.status < 500),
      refetchOnWindowFocus: false,
      // Keep data around while users go back and forth between pages
      gcTime: 10 * 60 * 1000,
    },
  },
});

// To show the projects list, the user and the site configuration right away when the app starts,
// we keep them in IndexedDB. They are refreshed in the background.
// We also keep the projects used recently: lists of commits need their metrics before they can be fetched.
const persisted_queries = new Set(['config', 'me', 'projects']);
const recent_project = query => query.queryKey[0] === 'project' && query.state.dataUpdatedAt > Date.now() - 3 * 24 * 3600 * 1000;

const storage_persister = createAsyncStoragePersister({
  storage: { getItem: get, setItem: set, removeItem: del },
  key: 'qaboard-query-cache',
});
// The cache is saved after any query changes: we don't serialize and write it again when what we keep didn't change
let persisted_signature = null;
const persister = {
  ...storage_persister,
  persistClient: client => {
    const signature = client.buster + client.clientState.queries.map(q => `${q.queryHash}@${q.state.dataUpdatedAt}`).join();
    if (signature === persisted_signature) return;
    persisted_signature = signature;
    return storage_persister.persistClient(client);
  },
  removeClient: () => {
    persisted_signature = null;
    return storage_persister.removeClient();
  },
};

export const persistOptions = {
  persister,
  maxAge: 7 * 24 * 3600 * 1000,
  // bump to discard what's persisted when the shape of the data changes
  buster: '2',
  dehydrateOptions: {
    shouldDehydrateQuery: query => (persisted_queries.has(query.queryKey[0]) || recent_project(query)) && query.state.status === 'success',
  },
};

// Once the cache is restored, we use it right away, and check the site config and the user again:
// the session may have expired, or users logged out in another tab.
export const onCacheRestored = () => {
  applySiteConfig(queryClient.getQueryData(['config']));
  return queryClient.invalidateQueries({ predicate: query => ['config', 'me'].includes(query.queryKey[0]) });
};
