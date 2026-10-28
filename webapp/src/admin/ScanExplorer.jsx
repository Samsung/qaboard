// Admin → Storage → a scan: what's on disk, like ncdu. Folders by size, what QA-Board tracks or not, who owns it,
// and acting on what QA-Board doesn't use: delete it, track exports so their owners see them, add runs back.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert, Breadcrumbs, Button, Callout, Card, Checkbox, Classes, Colors, HTMLSelect, HTMLTable, Icon, Intent, NonIdealState,
  SegmentedControl, Tag, Tooltip,
} from "@blueprintjs/core";
import styled from "styled-components";

import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { history, Link } from "../router";
import { Time } from "../settings/format";
import { Loading } from "../settings/states";
import { AdminError } from "./states";
import { scanQuery, scanEntriesQuery, deleteScanPaths, trackScanExports, importScanRuns, deleteScan } from "./api";
import { formatBytes, number, JobStatus } from "./jobs";


// What scans find, in words and colors: tracked things are calm, untracked ones stand out
export const scan_kinds = {
  run: { label: 'Run', color: Colors.BLUE3, tracked: true, hint: "A run QA-Board knows." },
  batch: { label: 'Batch', color: Colors.BLUE5, tracked: true, hint: "A batch's folder, and its files (logs...)." },
  artifacts: { label: 'Artifacts', color: Colors.INDIGO4, tracked: true, hint: "A commit's artifacts." },
  export: { label: 'Export', color: Colors.TURQUOISE3, tracked: true, hint: "An export QA-Board tracks: its owner sees it in Storage usage." },
  deleted_run: { label: 'Deleted run', color: Colors.ORANGE4, hint: "A run deleted in QA-Board: what's left of its files (manifests, files the manifest didn't list)." },
  untracked_run: { label: 'Untracked run', color: Colors.RED3, hint: "A run's folder (it has run.json) that QA-Board doesn't know: its upload failed, or the run was deleted for good. In a batch's folder, you can add it back." },
  deleted_artifacts: { label: 'Deleted artifacts', color: Colors.ORANGE2, hint: "Artifacts QA-Board thinks it deleted, still on disk." },
  untracked_export: { label: 'Untracked export', color: Colors.VIOLET3, hint: "An export QA-Board didn't track (older exports, or copied elsewhere). Track it: its owner sees it, and can delete it." },
  untracked_files: { label: 'Other files', color: Colors.GRAY3, hint: "Files that aren't in runs, exports or artifacts." },
  folder: { label: 'Folder', color: Colors.GRAY4 },
  file: { label: 'File', color: Colors.GRAY3 },
};
const untracked_kinds = ['deleted_run', 'untracked_run', 'deleted_artifacts', 'untracked_export', 'untracked_files'];
export const kindLabel = kind => scan_kinds[kind]?.label ?? kind;

export const KindTag = ({ kind }) => <Tooltip content={scan_kinds[kind]?.hint ?? kind} hoverOpenDelay={300} disabled={!scan_kinds[kind]?.hint}>
  <Tag minimal style={{ borderLeft: `3px solid ${scan_kinds[kind]?.color ?? Colors.GRAY3}`, whiteSpace: 'nowrap' }}>{kindLabel(kind)}</Tag>
</Tooltip>;

const Bar = styled.div`
  display: flex;
  height: 8px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--qa-border, ${Colors.LIGHT_GRAY3});
  min-width: 80px;
`;

// A size, with a bar of what it's made of, relative to the biggest
export const KindsBar = ({ kinds, bytes, max }) => {
  const width = max ? Math.max(1, 100 * bytes / max) : 100;
  const parts = Object.entries(kinds ?? {}).filter(([, size]) => size > 0).sort(([a], [b]) => Object.keys(scan_kinds).indexOf(a) - Object.keys(scan_kinds).indexOf(b));
  const total = parts.reduce((sum, [, size]) => sum + size, 0) || 1;
  return <div style={{ minWidth: 130 }}>
    <div style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{formatBytes(bytes)}</div>
    <Bar aria-hidden="true">
      <div style={{ display: 'flex', width: `${width}%` }}>
        {parts.map(([kind, size]) => <div key={kind} title={`${kindLabel(kind)}: ${formatBytes(size)}`} style={{ width: `${100 * size / total}%`, background: scan_kinds[kind]?.color ?? Colors.GRAY3 }}/>)}
      </div>
    </Bar>
  </div>;
};

const Totals = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 10px;
  margin: 16px 0;
  .value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
`;

const leaf_kinds = ['run', 'deleted_run', 'untracked_run', 'artifacts', 'deleted_artifacts', 'export', 'untracked_export'];

const Owners = ({ owners, owner, setOwner }) => owners.length > 0 && <Card compact style={{ marginBottom: 16 }}>
  <h5 className={Classes.HEADING}>Who owns what QA-Board doesn't track</h5>
  <HTMLTable compact style={{ width: '100%' }} aria-label="Owners">
    <thead><tr><th>Owner</th><th>Not tracked</th><th>Total</th></tr></thead>
    <tbody>
      {owners.slice(0, 10).map(o => <tr key={o.owner}>
        <td><Button variant="minimal" size="small" active={owner === o.owner} text={o.owner} onClick={() => setOwner(owner === o.owner ? '' : o.owner)}/></td>
        <td><KindsBar kinds={Object.fromEntries(Object.entries(o.kinds).filter(([kind]) => untracked_kinds.includes(kind)))} bytes={o.untracked_bytes} max={owners[0].untracked_bytes}/></td>
        <td>{formatBytes(o.bytes)}</td>
      </tr>)}
    </tbody>
  </HTMLTable>
</Card>;


export const ScanExplorer = ({ id }) => {
  const queryClient = useQueryClient();
  const params = new URLSearchParams(window.location.search);
  const [parent, setParentState] = useState(params.get('path') || '');
  const [mode, setMode] = useState(params.get('mode') || 'folders');
  const [owner, setOwner] = useState('');
  const [kind, setKind] = useState('');
  const [sort, setSort] = useState('size');
  const [selected, setSelected] = useState(new Map());
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const setParent = path => {
    setParentState(path);
    setSelected(new Map());
    history.replace(`/admin/storage/scans/${id}${path ? `?path=${encodeURIComponent(path)}` : ''}`);
  };
  const { data: scan, isPending, error, refetch } = useQuery(scanQuery(id));
  const flat = mode === 'untracked';
  const { data: entries, isFetching } = useQuery({
    ...scanEntriesQuery(id, flat ? { flat: true, kind, owner, sort, parent } : { parent, owner, kind, sort }),
    enabled: !!scan,
  });
  if (isPending) return <Loading label="Loading the scan"/>;
  if (error) return error?.response?.status === 404
    ? <NonIdealState icon="search" title="This scan doesn't exist" action={<Link to="/admin/storage">Back to the storage</Link>}/>
    : <AdminError error={error} refetch={refetch} what="the scan"/>;

  const rows = entries?.entries ?? [];
  const max = Math.max(0, ...rows.map(e => e.bytes));
  const crumbs = [];
  if (parent) {
    const root = (scan.roots ?? []).find(r => parent === r || parent.startsWith(`${r.replace(/\/$/, '')}/`)) ?? '/';
    crumbs.push({ text: 'Scanned folders', onClick: () => setParent('') });
    crumbs.push({ text: root, onClick: () => setParent(root) });
    const rest = parent.slice(root.length).split('/').filter(Boolean);
    rest.forEach((part, i) => crumbs.push({ text: part, onClick: () => setParent(`${root.replace(/\/$/, '')}/${rest.slice(0, i + 1).join('/')}`) }));
  }
  const toggle = entry => setSelected(current => {
    const next = new Map(current);
    if (next.has(entry.path)) next.delete(entry.path);
    else next.set(entry.path, entry);
    return next;
  });
  const picked = [...selected.values()];
  const picked_bytes = picked.reduce((sum, e) => sum + e.bytes, 0);
  const can_track = picked.filter(e => e.kind === 'untracked_export');
  const can_import = picked.filter(e => e.kind === 'untracked_run' && e.ref?.batch_id);
  const act = (promise, message) => {
    setBusy(true);
    return promise
      .then(answer => {
        toaster.show({ message: message(answer), intent: Intent.SUCCESS, icon: 'tick', timeout: 4000 });
        setSelected(new Map());
        setConfirm(null);
        if (answer?.job) history.push(`/admin/storage/jobs/${answer.job.id}`);
      })
      .catch(error => toaster.show({ message: errorMessage(error), intent: Intent.DANGER, timeout: 8000 }))
      .finally(() => setBusy(false));
  };
  const open = entry => {
    if (entry.is_dir && !leaf_kinds.includes(entry.kind)) {
      setMode('folders');
      setParent(entry.path);
    }
  };

  return <>
    <div style={{ marginBottom: 12 }}><Link to="/admin/storage">← Storage</Link></div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <h3 className={Classes.HEADING} style={{ margin: 0 }}>Scan #{scan.id}</h3>
      {scan.job ? <JobStatus job={scan.job}/> : <Tag minimal>{scan.status}</Tag>}
      <span className={Classes.TEXT_MUTED}>{scan.finished_at ? <>finished <Time iso={scan.finished_at}/></> : <>started <Time iso={scan.created_at}/></>}</span>
      {scan.job && <Link to={`/admin/storage/jobs/${scan.job.id}`}>Its job and log</Link>}
      {scan.status !== 'running' && <Button style={{ marginLeft: 'auto' }} variant="minimal" icon="trash" text="Delete this scan" onClick={() => setDeleting(true)}/>}
    </div>
    <Alert
      isOpen={deleting}
      intent={Intent.DANGER}
      icon="trash"
      confirmButtonText="Delete the scan"
      cancelButtonText="Cancel"
      loading={busy}
      onConfirm={() => {
        setBusy(true);
        deleteScan(queryClient, scan.id)
          .then(() => {
            toaster.show({ message: `Deleted scan #${scan.id}`, intent: Intent.SUCCESS, icon: 'tick', timeout: 4000 });
            history.push('/admin/storage');
          })
          .catch(error => toaster.show({ message: errorMessage(error), intent: Intent.DANGER, timeout: 8000 }))
          .finally(() => { setBusy(false); setDeleting(false); });
      }}
      onCancel={() => setDeleting(false)}
    >
      <p>Delete what scan #{scan.id} found? The files stay on disk: only the scan's results are deleted.</p>
    </Alert>
    <p className={Classes.TEXT_MUTED} style={{ marginTop: 6 }}>{(scan.roots ?? []).length} folders: {(scan.roots ?? []).slice(0, 4).join(', ')}{scan.roots?.length > 4 ? '…' : ''}</p>
    {scan.status === 'running' && <Callout icon="time" intent={Intent.PRIMARY}>The scan is still running: what you see grows as it goes.</Callout>}

    <Totals>
      <Card compact><div className="value">{formatBytes(scan.bytes)}</div><div className={Classes.TEXT_MUTED}>on disk, {number(scan.files)} files</div></Card>
      <Card compact><div className="value" style={{ color: Colors.RED3 }}>{formatBytes(scan.untracked_bytes)}</div><div className={Classes.TEXT_MUTED}>QA-Board doesn't track</div></Card>
      {Object.entries(scan.by_kind ?? {}).sort(([, a], [, b]) => b - a).map(([k, size]) => <Card key={k} compact interactive onClick={() => { setMode('untracked'); setKind(k); }}>
        <div className="value" style={{ fontSize: 18 }}>{formatBytes(size)}</div>
        <div><KindTag kind={k}/></div>
      </Card>)}
    </Totals>
    <Owners owners={scan.owners ?? []} owner={owner} setOwner={setOwner}/>

    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 10 }}>
      <SegmentedControl
        aria-label="Show"
        options={[{ label: 'Folders', value: 'folders' }, { label: 'Biggest untracked', value: 'untracked' }]}
        value={mode}
        onValueChange={value => { setMode(value); setSelected(new Map()); if (value === 'folders') setKind(''); }}
      />
      <HTMLSelect aria-label="Kind" value={kind} onChange={e => setKind(e.target.value)}
        options={[{ value: '', label: flat ? 'Everything untracked' : 'All kinds' }, ...Object.keys(scan_kinds).map(k => ({ value: k, label: kindLabel(k) }))]}/>
      <HTMLSelect aria-label="Sort" value={sort} onChange={e => setSort(e.target.value)}
        options={[{ value: 'size', label: 'Biggest first' }, { value: 'oldest', label: 'Untouched for the longest' }, { value: 'newest', label: 'Changed recently' }, { value: 'name', label: 'By name' }]}/>
      {owner && <Tag large minimal icon="person" onRemove={() => setOwner('')}>Owned by {owner}</Tag>}
    </div>
    {mode === 'folders' && parent && <Breadcrumbs items={crumbs}/>}
    {entries?.current?.small?.entries > 0 && <p className={Classes.TEXT_MUTED}>And {number(entries.current.small.entries)} smaller items ({formatBytes(entries.current.small.bytes)}), not detailed.</p>}

    {rows.length === 0
      ? <NonIdealState icon="folder-close" title="Nothing here" description={flat ? "Nothing QA-Board doesn't track, with these filters." : undefined}/>
      : <div style={{ overflowX: 'auto', opacity: isFetching ? 0.7 : 1 }}>
        <HTMLTable compact interactive style={{ width: '100%' }} aria-label="Scan entries">
          <thead><tr><th style={{ width: 30 }}><span className={Classes.TEXT_MUTED} aria-label="Select"/></th><th>Name</th><th>What</th><th>Size</th><th>Files</th><th>Changed</th><th>Owners</th></tr></thead>
          <tbody>
            {rows.map(entry => <tr key={entry.path} style={entry.action ? { opacity: 0.5 } : undefined} data-testid="scan-entry">
              <td>
                {entry.action
                  ? <Tag minimal intent={entry.action === 'deleted' ? Intent.DANGER : Intent.SUCCESS}>{entry.action}</Tag>
                  : entry.deletable || entry.kind === 'untracked_export' || entry.kind === 'untracked_run'
                    ? <Checkbox checked={selected.has(entry.path)} onChange={() => toggle(entry)} aria-label={`Select ${entry.path}`} style={{ margin: 0 }}/>
                    : <Tooltip content="QA-Board uses files in it: delete them from QA-Board" hoverOpenDelay={200}><Icon icon="lock" className={Classes.TEXT_MUTED}/></Tooltip>}
              </td>
              <td style={{ minWidth: 240, overflowWrap: 'anywhere' }}>
                <Icon icon={entry.is_dir ? 'folder-close' : 'document'} className={Classes.TEXT_MUTED} style={{ marginRight: 6 }}/>
                {entry.is_dir && !leaf_kinds.includes(entry.kind)
                  ? <a href={`/admin/storage/scans/${id}?path=${encodeURIComponent(entry.path)}`} onClick={event => { event.preventDefault(); open(entry); }}>{flat ? entry.path : entry.name}</a>
                  : <span>{flat ? entry.path : entry.name}</span>}
                {entry.ref?.project_id && <div className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>{entry.ref.project_id}</div>}
                {entry.small?.entries > 0 && <div className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>{number(entry.small.entries)} small items not detailed</div>}
              </td>
              <td><KindTag kind={entry.kind}/></td>
              <td><KindsBar kinds={entry.kinds} bytes={entry.bytes} max={max}/></td>
              <td>{number(entry.files)}</td>
              <td><Time iso={entry.newest_mtime} never="—"/></td>
              <td style={{ fontSize: 12 }}>{Object.keys(entry.owners ?? {}).slice(0, 3).join(', ')}{Object.keys(entry.owners ?? {}).length > 3 ? '…' : ''}</td>
            </tr>)}
          </tbody>
        </HTMLTable>
        {entries.total > rows.length && <p className={Classes.TEXT_MUTED}>The first {rows.length} of {number(entries.total)}.</p>}
      </div>}

    {picked.length > 0 && <Card elevation={3} style={{ position: 'sticky', bottom: 12, marginTop: 16, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', zIndex: 10 }}>
      <strong>{picked.length} selected · {formatBytes(picked_bytes)}</strong>
      <Button variant="minimal" text="Clear" onClick={() => setSelected(new Map())}/>
      <span style={{ marginLeft: 'auto' }}/>
      {can_track.length > 0 && <Button icon="eye-open" text={`Track ${can_track.length} export${can_track.length > 1 ? 's' : ''}`} loading={busy}
        onClick={() => act(trackScanExports(queryClient, id, can_track.map(e => e.path)), answer => `Tracked ${answer.exports.length} exports: their owners see them in Storage usage`)}/>}
      {can_import.length > 0 && <Button icon="import" text={`Add ${can_import.length} run${can_import.length > 1 ? 's' : ''} to QA-Board`} loading={busy}
        onClick={() => act(importScanRuns(queryClient, id, can_import.map(e => e.path)), () => 'Adding the runs')}/>}
      {picked.every(e => e.deletable) && <Button icon="trash" intent={Intent.DANGER} text="Delete…" onClick={() => setConfirm(picked)}/>}
    </Card>}

    <Alert
      isOpen={!!confirm}
      intent={Intent.DANGER}
      icon="trash"
      confirmButtonText={`Delete ${formatBytes(picked_bytes)}`}
      cancelButtonText="Cancel"
      loading={busy}
      onConfirm={() => act(deleteScanPaths(queryClient, id, picked.map(e => e.path)), () => 'Deleting: follow it on its page')}
      onCancel={() => setConfirm(null)}
    >
      <p>Delete {picked.length} folder{picked.length > 1 ? 's' : ''} and files ({formatBytes(picked_bytes)}) for good? QA-Board doesn't use them: {[...new Set(picked.map(e => kindLabel(e.kind)))].join(', ')}.</p>
      <p className={Classes.TEXT_MUTED}>It can't be undone. Errors (e.g. permissions) are listed on the job's page.</p>
    </Alert>
  </>;
};

export default ScanExplorer;
