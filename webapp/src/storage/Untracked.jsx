// Storage usage > Not tracked: what the latest storage scan found on disk that you own and QA-Board doesn't track
// (old exports, runs it doesn't know, what deleted runs left...), and deleting it.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Callout, Checkbox, Classes, HTMLTable, Icon, Intent, NonIdealState, Tooltip } from "@blueprintjs/core";

import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { Time } from "../settings/format";
import { Loading, QueryError } from "../settings/states";
import { KindTag, KindsBar, kindLabel } from "../admin/ScanExplorer";
import { untrackedQuery, deleteUntracked } from "./api";
import { formatBytes, plural, Path } from "./format";


export const UntrackedView = ({ me }) => {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(new Map());
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data, isPending, error, refetch } = useQuery(untrackedQuery);
  if (isPending) return <Loading label="Loading what QA-Board doesn't track"/>;
  if (error) return <QueryError error={error} refetch={refetch} what="the files QA-Board doesn't track"/>;
  if (!data.scan) return <NonIdealState
    icon="search"
    title="The storage wasn't scanned yet"
    description={<>QA-Board only knows the files of its runs. To find the rest (old exports, leftovers, runs QA-Board doesn't know), an admin scans the storage{me.is_admin ? <> from Admin → Storage</> : ''}.</>}
  />;
  const entries = data.entries;
  const max = Math.max(0, ...entries.map(e => e.bytes));
  const can_delete = entry => entry.deletable && (entry.only_yours || me.is_admin) && !entry.action;
  const toggle = entry => setSelected(current => {
    const next = new Map(current);
    if (next.has(entry.path)) next.delete(entry.path);
    else next.set(entry.path, entry);
    return next;
  });
  const picked = [...selected.values()];
  const picked_bytes = picked.reduce((sum, e) => sum + e.bytes, 0);
  const remove = () => {
    setBusy(true);
    deleteUntracked(queryClient, picked.map(e => e.path))
      .then(() => {
        toaster.show({ message: 'Deleting: follow it above', intent: Intent.SUCCESS, icon: 'tick', timeout: 4000 });
        setSelected(new Map());
        setConfirm(false);
      })
      .catch(error => toaster.show({ message: errorMessage(error), intent: Intent.DANGER, timeout: 8000 }))
      .finally(() => setBusy(false));
  };
  const by_kind = Object.entries(data.totals.by_kind ?? {}).filter(([, size]) => size > 0).sort(([, a], [, b]) => b - a);

  return <>
    <Callout icon="search" style={{ marginBottom: 12 }}>
      What a scan of the storage found on disk, that you own and QA-Board doesn't track: <strong>{formatBytes(data.totals.bytes)}</strong>
      {by_kind.length > 0 && <> ({by_kind.map(([kind, size]) => `${formatBytes(size)} ${kindLabel(kind).toLowerCase()}`).join(', ')})</>}.
      {' '}Scanned <Time iso={data.scan.finished_at}/>: what changed since isn't shown.
    </Callout>
    {entries.length === 0
      ? <NonIdealState icon="tick-circle" title="Nothing big" description="The scan found nothing big of yours that QA-Board doesn't track."/>
      : <div style={{ overflowX: 'auto' }}>
        <HTMLTable compact style={{ width: '100%' }} aria-label="Not tracked">
          <thead><tr><th style={{ width: 30 }}><span className={Classes.TEXT_MUTED} aria-label="Select"/></th><th>Size</th><th>Folder</th><th>What</th><th>Files</th><th>Changed</th></tr></thead>
          <tbody>
            {entries.map(entry => <tr key={entry.path} data-testid="untracked" style={entry.action ? { opacity: 0.5 } : undefined}>
              <td>
                {can_delete(entry)
                  ? <Checkbox checked={selected.has(entry.path)} onChange={() => toggle(entry)} aria-label={`Select ${entry.path}`} style={{ margin: 0 }}/>
                  : <Tooltip content={!entry.deletable ? "QA-Board uses files in it" : "Other people own files in it: ask them, or an admin"} hoverOpenDelay={200}>
                    <Icon icon="lock" className={Classes.TEXT_MUTED}/>
                  </Tooltip>}
              </td>
              <td><KindsBar kinds={entry.kinds} bytes={entry.bytes} max={max}/></td>
              <td style={{ minWidth: 240 }}><Path path={entry.path} style={{ maxWidth: 480 }}/>{entry.ref?.project_id && <div className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>{entry.ref.project_id}</div>}</td>
              <td><KindTag kind={entry.kind}/></td>
              <td>{plural(entry.files, 'file')}</td>
              <td><Time iso={entry.newest_mtime} never="—"/></td>
            </tr>)}
          </tbody>
        </HTMLTable>
      </div>}

    {picked.length > 0 && <section aria-label="Selected folders" className={`${Classes.CARD} ${Classes.ELEVATION_3}`} style={{ position: 'sticky', bottom: 12, zIndex: 10, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginTop: 16, padding: '10px 16px' }}>
      <span><strong>{plural(picked.length, 'folder')}</strong> selected · <strong>{formatBytes(picked_bytes)}</strong></span>
      <Button variant="minimal" text="Clear" onClick={() => setSelected(new Map())}/>
      <span style={{ marginLeft: 'auto' }}/>
      <Button intent={Intent.DANGER} icon="trash" text="Delete…" onClick={() => setConfirm(true)}/>
    </section>}
    <Alert
      isOpen={confirm}
      intent={Intent.DANGER}
      icon="trash"
      confirmButtonText={`Delete ${formatBytes(picked_bytes)}`}
      cancelButtonText="Cancel"
      loading={busy}
      onConfirm={remove}
      onCancel={() => setConfirm(false)}
    >
      <p>Delete {plural(picked.length, 'folder')} and their files ({formatBytes(picked_bytes)}) for good? It can't be undone.</p>
      <p className={Classes.TEXT_MUTED}>QA-Board doesn't use them: {[...new Set(picked.map(e => kindLabel(e.kind).toLowerCase()))].join(', ')}.</p>
    </Alert>
  </>;
};

export default UntrackedView;
