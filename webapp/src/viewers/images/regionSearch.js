// Finding the regions of interest of image pairs, e.g. where they differ, for one viewer or every run of the page.
//
// Results are queries (TanStack Query), keyed by the provider and the files: a viewer shows what a search for all the
// runs found, and the other way around. Searches can take seconds the first time the server reads an image: a few at
// a time, the ones users asked for in a viewer before the others.

// Searches at the same time, for the whole page
const CONCURRENCY = 3;

export const createLimiter = (concurrency = CONCURRENCY) => {
  const queue = [];
  let running = 0;
  const next = () => {
    while (running < concurrency && queue.length > 0) {
      const task = queue.shift();
      if (task.signal?.aborted) {
        task.reject(task.signal.reason ?? new DOMException('Aborted', 'AbortError'));
        continue;
      }
      running++;
      Promise.resolve().then(task.fn).then(task.resolve, task.reject).finally(() => {
        running--;
        next();
      });
    }
  };
  // priority 'high' goes before what's waiting
  const run = (fn, { signal, priority = 'low' } = {}) => new Promise((resolve, reject) => {
    const task = { fn, signal, resolve, reject };
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
  return { run, pending: () => queue.length + running };
};

export const limiter = createLimiter();

export const regionsKey = (provider_id, { output_new, output_ref, path, path_ref }) =>
  ['image-regions', provider_id, output_new?.output_dir_url ?? output_new?.id, output_ref?.output_dir_url ?? output_ref?.id ?? null, path, path_ref ?? path];

// The query of a provider's regions for an image pair. context: { output_new, output_ref, path, path_ref }
export const regionsQuery = (provider, context, priority = 'low') => ({
  queryKey: regionsKey(provider.id, context),
  queryFn: ({ signal }) => limiter.run(() => provider.find(context, { signal }), { signal, priority }),
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
