// Finding the regions of interest of image pairs, e.g. where they differ, for one viewer or every run of the page.
//
// Results are queries (TanStack Query), keyed by the provider and the files: a viewer shows what a search for all the
// runs found, and the other way around. Searches can take seconds the first time the server reads an image: a few at
// a time, the ones users asked for in a viewer before the others.

import { useSyncExternalStore } from 'react';

// Searches at the same time, for the whole page. Their server threads finish them about 2x sooner than one by one,
// but at about the same time: users see which are running.
const CONCURRENCY = 3;

export const createLimiter = (concurrency = CONCURRENCY) => {
  const queue = [];
  let running = 0;
  // the tasks running, by id: when they started. A new object when it changes (useSyncExternalStore)
  let started = {};
  const listeners = new Set();
  const setStarted = value => {
    started = value;
    listeners.forEach(listener => listener());
  };
  const next = () => {
    while (running < concurrency && queue.length > 0) {
      const task = queue.shift();
      if (task.signal?.aborted) {
        task.reject(task.signal.reason ?? new DOMException('Aborted', 'AbortError'));
        continue;
      }
      running++;
      if (task.id) setStarted({ ...started, [task.id]: Date.now() });
      Promise.resolve().then(task.fn).then(task.resolve, task.reject).finally(() => {
        running--;
        if (task.id) {
          const { [task.id]: _, ...others } = started;
          setStarted(others);
        }
        next();
      });
    }
  };
  // priority 'high' goes before what's waiting. id: to know when it started
  const run = (fn, { signal, priority = 'low', id } = {}) => new Promise((resolve, reject) => {
    const task = { fn, signal, resolve, reject, id };
    if (priority === 'high') queue.unshift(task);
    else queue.push(task);
    // cancelled while waiting: out of the queue
    signal?.addEventListener('abort', () => {
      const i = queue.indexOf(task);
      if (i === -1) return;
      queue.splice(i, 1);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
    next();
  });
  const subscribe = listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return { run, concurrency, pending: () => queue.length + running, started: () => started, subscribe };
};

export const limiter = createLimiter();

// The searches running (not waiting for their turn): { [JSON of their query key]: when they started }
export const useStartedSearches = () => useSyncExternalStore(limiter.subscribe, limiter.started);

export const regionsKey = (provider_id, { output_new, output_ref, path, path_ref }) =>
  ['image-regions', provider_id, output_new?.output_dir_url ?? output_new?.id, output_ref?.output_dir_url ?? output_ref?.id ?? null, path, path_ref ?? path];

// The query of a provider's regions for an image pair. context: { output_new, output_ref, path, path_ref }
export const regionsQuery = (provider, context, priority = 'low') => ({
  queryKey: regionsKey(provider.id, context),
  queryFn: ({ signal, queryKey }) => limiter.run(() => provider.find(context, { signal }), { signal, priority, id: JSON.stringify(queryKey) }),
  // the server keeps them, until the files change
  staleTime: Infinity,
  gcTime: 60 * 60 * 1000,
  retry: false,
});

// The runs of the page with an image to compare, and their reference: [{ output_new, output_ref }]
// new_batch and ref_batch as in useComparison()
export const runPairs = ({ new_batch, ref_batch }) => (new_batch?.filtered?.outputs ?? [])
  .map(id => new_batch.outputs[id])
  .filter(output => output && output.output_type !== 'optim_iteration' && !output.deleted && !output.is_pending && !output.is_running)
  .map(output => ({ output_new: output, output_ref: ref_batch?.outputs?.[output.reference_id] }))
  .filter(({ output_new, output_ref }) => output_ref && !output_ref.deleted && output_ref.output_dir_url && output_ref.id !== output_new.id);
