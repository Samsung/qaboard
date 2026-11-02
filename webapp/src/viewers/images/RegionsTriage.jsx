// Where the images of a visualization differ, in every run of the page: the server compares each with its reference,
// a few at a time, and the runs are ranked by their largest difference. Each viewer shows the regions found for its
// run (the results are shared, regionSearch.js).
import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Button, Dialog, DialogBody, DialogFooter, HTMLSelect, Icon, ProgressBar, Spinner } from '@blueprintjs/core';

import { errorMessage, isAbort } from '../../api/http';
import { useComparison } from '../../hooks';
import { formatDifference, regionProviders } from './regionProviders';
import { limiter, regionsKey, regionsQuery, runPairs, useStartedSearches } from './regionSearch';

// The providers that compare images, e.g. auto-yiq
export const differenceProviders = () => regionProviders().filter(provider => provider.find && provider.diff_type);

const runName = output => [output.test_input_path, ...(output.configurations ?? []).filter(c => typeof c === 'string')].join(' ');

// The runs of the page to compare, for a visualization's file
export const usePagePairs = () => {
  const comparison = useComparison();
  const new_batch = comparison?.new_batch;
  const ref_batch = comparison?.ref_batch;
  return useMemo(() => runPairs({ new_batch, ref_batch }), [new_batch, ref_batch]);
};

// The time, every second while `active`
const useNow = active => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
};

export const RegionsTriage = ({ path, path_ref, provider: provider_id, onProviderChange, onShow, onClose }) => {
  const pairs = usePagePairs();
  const providers = differenceProviders();
  const provider = providers.find(p => p.id === provider_id) ?? providers[0];
  const contexts = useMemo(() => pairs.map(pair => ({ ...pair, path, path_ref })), [pairs, path, path_ref]);
  const queryClient = useQueryClient();
  const results = useQueries({ queries: contexts.map(context => ({ ...regionsQuery(provider, context), enabled: false })) });

  const start = () => {
    for (const context of contexts)
      queryClient.fetchQuery(regionsQuery(provider, context)).catch(() => {});
  };
  const stop = () => queryClient.cancelQueries({ queryKey: ['image-regions', provider.id] });
  // compared as soon as it opens, or another way to compare is picked
  // oxlint-disable-next-line react/exhaustive-deps
  useEffect(start, [provider.id, contexts]);

  // the searches that started, and how long ago: the others wait for their turn
  const started = useStartedSearches();
  const rows = contexts.map((context, i) => {
    const { data, error, fetchStatus } = results[i];
    const since = started[JSON.stringify(regionsKey(provider.id, context))];
    const status = data ? 'done'
      : fetchStatus === 'fetching' ? (since ? 'running' : 'waiting')
      : error && !isAbort(error) ? 'error' : 'idle';
    return { ...context, status, since, regions: data, top: data?.[0]?.value ?? 0, error: status === 'error' ? errorMessage(error) : null };
  });
  const order = { done: 0, running: 1, waiting: 2, idle: 3, error: 4 };
  rows.sort((a, b) => order[a.status] - order[b.status] || b.top - a.top);
  const done = rows.filter(row => row.status === 'done' || row.status === 'error').length;
  const comparing = rows.filter(row => row.status === 'running').length;
  const running = rows.some(row => row.status === 'running' || row.status === 'waiting');
  const now = useNow(comparing > 0);
  const largest = Math.max(...rows.map(row => row.top), 0);
  const identical = rows.filter(row => row.status === 'done' && row.regions.length === 0).length;

  return <Dialog isOpen title={`Where the images differ, in ${contexts.length} runs`} icon="search" onClose={onClose} style={{ width: 760, maxWidth: '95vw' }}>
    <DialogBody>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <HTMLSelect
          aria-label="How to compare"
          value={provider.id}
          options={providers.map(p => ({ value: p.id, label: p.label.replace(/^Where they differ: /, '') }))}
          onChange={event => onProviderChange(event.target.value)}
        />
        <code style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{path}</code>
        <span>{done} / {contexts.length}{comparing > 0 ? ` · comparing ${comparing}` : ''}{identical > 0 ? ` · ${identical} identical` : ''}</span>
      </div>
      <ProgressBar value={contexts.length ? done / contexts.length : 1} animate={running} stripes={running} intent={running ? 'primary' : 'success'} />
      <p className="bp6-text-muted" style={{ margin: '10px 0' }}>
        The runs whose images differ most first. The server compares the full images, {limiter.concurrency} runs at a
        time: the first time it reads an image takes a few seconds, then it's quick. Each viewer of <code>{path}</code>{' '}
        shows the regions found for its run, also after you close this.
      </p>
      <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
        <table className="bp6-html-table bp6-compact bp6-interactive" style={{ width: '100%' }}>
          <thead><tr><th>Run</th><th>Largest difference</th><th>Regions</th><th aria-label="Go to the run" /></tr></thead>
          <tbody>
            {rows.map(row => <tr key={row.output_new.id} onClick={row.status === 'done' && row.regions.length ? () => onShow(row.output_new.id) : undefined}>
              <td style={{ wordBreak: 'break-all' }}>{runName(row.output_new)}</td>
              <td style={{ minWidth: 180 }}>
                {row.status === 'done' && (row.regions.length === 0 ? <span className="bp6-text-muted">identical</span> : <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: '0 0 70px', height: 6, background: 'var(--qa-border)', borderRadius: 3 }}>
                    <span style={{ display: 'block', height: 6, borderRadius: 3, width: `${largest ? 100 * row.top / largest : 0}%`, background: 'var(--qa-intent-primary)' }} />
                  </span>
                  {formatDifference(provider.diff_type, row.top)}
                </span>)}
                {row.status === 'running' && <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Spinner size={14} /> comparing… {Math.max(0, Math.round((now - row.since) / 1000))} s
                </span>}
                {row.status === 'waiting' && <span className="bp6-text-muted">waiting</span>}
                {row.status === 'idle' && <span className="bp6-text-muted">not compared</span>}
                {row.status === 'error' && <span className="bp6-text-danger" title={row.error}><Icon icon="warning-sign" size={12} /> {row.error}</span>}
              </td>
              <td>{row.status === 'done' ? row.regions.length : ''}</td>
              <td>{row.status === 'done' && row.regions.length > 0 && <Button size="small" variant="minimal" icon="arrow-right" text="Show" />}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </DialogBody>
    <DialogFooter actions={<>
      {running ? <Button icon="stop" text="Stop" onClick={stop} /> : done < contexts.length && <Button icon="play" text="Compare the others" onClick={start} />}
      <Button text="Close" onClick={onClose} />
    </>} />
  </Dialog>;
};
