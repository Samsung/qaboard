// Storage usage > Exports: the folders "Export" wrote, who they belong to, how much they take, and deleting them.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Callout, Checkbox, Classes, HTMLSelect, HTMLTable, Intent, NonIdealState, Tag, Tooltip } from "@blueprintjs/core";

import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { Link } from "../router";
import { Time } from "../settings/format";
import { Loading, QueryError } from "../settings/states";
import { copyWithToast } from "../utils/clipboard";
import { exportsQuery, deleteExports, measureExport } from "./api";
import { formatBytes, formatNumber, plural, SizeBar, Path } from "./format";


// Exports are hard links by default: the files are the runs' files, under another name
export const LinkedTag = ({ item }) => item.linked_bytes > 0 && <Tooltip
  content={<span style={{ display: 'block', maxWidth: 340 }}>
    {formatBytes(item.linked_bytes)} are links to runs' files, not copies: they take space once, and are only freed when both the export and the runs are deleted.
  </span>}
  hoverOpenDelay={200}
>
  <Tag minimal icon="link">{item.linked_bytes >= item.bytes ? 'Links to the runs' : `${formatBytes(item.linked_bytes)} linked`}</Tag>
</Tooltip>;

const sort_options = [
  { value: 'size', label: 'Biggest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'newest', label: 'Newest first' },
];

export const ExportsView = ({ filters, me }) => {
  const queryClient = useQueryClient();
  const [sort, setSort] = useState('size');
  const [selected, setSelected] = useState(new Map());
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data, isPending, error, refetch, isFetching } = useQuery(exportsQuery(filters, sort));
  if (isPending) return <Loading label="Loading the exports"/>;
  if (error) return <QueryError error={error} refetch={refetch} what="the exports"/>;
  const exports = data.exports;
  const max = Math.max(0, ...exports.map(e => e.bytes ?? 0));
  const mine = item => me.is_admin || item.owner === me.user_name || item.created_by === me.user_name;
  const toggle = item => setSelected(current => {
    const next = new Map(current);
    if (next.has(item.id)) next.delete(item.id);
    else next.set(item.id, item);
    return next;
  });
  const picked = [...selected.values()];
  const picked_bytes = picked.reduce((sum, e) => sum + (e.bytes ?? 0), 0);
  const picked_linked = picked.reduce((sum, e) => sum + (e.linked_bytes ?? 0), 0);
  const remove = () => {
    setBusy(true);
    deleteExports(queryClient, picked.map(e => e.id))
      .then(() => {
        toaster.show({ message: 'Deleting the exports: follow it above', intent: Intent.SUCCESS, icon: 'tick', timeout: 4000 });
        setSelected(new Map());
        setConfirm(false);
      })
      .catch(error => toaster.show({ message: errorMessage(error), intent: Intent.DANGER, timeout: 8000 }))
      .finally(() => setBusy(false));
  };
  const measure = item => measureExport(queryClient, item.id)
    .then(measured => toaster.show({ message: `${formatBytes(measured.bytes)} in ${plural(measured.files, 'file')}`, timeout: 3000 }))
    .catch(error => toaster.show({ message: errorMessage(error), intent: Intent.DANGER }));

  return <>
    <Callout icon="info-sign" style={{ marginBottom: 12 }}>
      "Export" gathers runs' files in a folder to share them. By default the files are <strong>links</strong> to the runs' files:
      they take no extra space, but deleting the runs doesn't free it while the export exists. Copies take space of their own.
      Delete the exports you don't need anymore here, no need for a terminal.
    </Callout>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 10 }}>
      <span><strong>{plural(data.totals.count, 'export')}</strong>, {formatBytes(data.totals.bytes)}{data.totals.linked_bytes > 0 && <span className={Classes.TEXT_MUTED}> ({formatBytes(data.totals.linked_bytes)} linked to runs)</span>}</span>
      <span style={{ marginLeft: 'auto' }}/>
      <HTMLSelect aria-label="Sort exports" options={sort_options} value={sort} onChange={e => setSort(e.target.value)}/>
    </div>
    {exports.length === 0
      ? <NonIdealState icon="export" title="No exports" description={<>QA-Board tracks the exports made from the web app. Older exports show up after an admin scans the storage: see the <Link to="/storage/untracked">Not tracked</Link> tab.</>}/>
      : <div style={{ overflowX: 'auto', opacity: isFetching ? 0.7 : 1 }}>
        <HTMLTable compact style={{ width: '100%' }} aria-label="Exports">
          <thead><tr><th style={{ width: 30 }}><span className={Classes.TEXT_MUTED} aria-label="Select"/></th><th>Size</th><th>Folder</th><th>From</th><th>Owner</th><th>Last export</th><th><span className={Classes.TEXT_MUTED}>Actions</span></th></tr></thead>
          <tbody>
            {exports.map(item => <tr key={item.id} data-testid="export">
              <td>{mine(item) && <Checkbox checked={selected.has(item.id)} onChange={() => toggle(item)} aria-label={`Select ${item.path}`} style={{ margin: 0 }}/>}</td>
              <td>
                <SizeBar bytes={item.bytes ?? 0} max={max}/>
                <div className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>{plural(item.files ?? 0, 'file')}</div>
              </td>
              <td style={{ minWidth: 220 }}>
                <Path path={item.path}/>
                <div style={{ marginTop: 2, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  <LinkedTag item={item}/>
                  {item.exports > 1 && <Tag minimal>{item.exports} exports in this folder</Tag>}
                  {item.source === 'scan' && <Tooltip content="Found on disk by a storage scan" hoverOpenDelay={200}><Tag minimal>Found by a scan</Tag></Tooltip>}
                </div>
              </td>
              <td style={{ fontSize: 12 }}>
                {item.project_id
                  ? <>{item.project_id}{item.hexsha && <> · <Link to={`/${item.project_id}/commit/${item.hexsha}${item.batch_label ? `?batch=${encodeURIComponent(item.batch_label)}` : ''}`}><code>{item.hexsha.slice(0, 8)}</code></Link></>}{item.batch_label && <div className={Classes.TEXT_MUTED}>{item.batch_label}</div>}</>
                  : <span className={Classes.TEXT_MUTED}>—</span>}
              </td>
              <td style={{ fontSize: 12 }}>{item.owner ?? item.created_by ?? '—'}</td>
              <td><Time iso={item.updated_at}/></td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <Tooltip content="Copy the path" hoverOpenDelay={300}><Button variant="minimal" size="small" icon="duplicate" aria-label={`Copy ${item.path}`} onClick={() => copyWithToast(item.path, { what: 'the path' })}/></Tooltip>
                {mine(item) && <Tooltip content={item.measured_at ? <>Measure it again (measured <Time iso={item.measured_at}/>)</> : 'Measure it'} hoverOpenDelay={300}>
                  <Button variant="minimal" size="small" icon="refresh" aria-label={`Measure ${item.path}`} onClick={() => measure(item)}/>
                </Tooltip>}
              </td>
            </tr>)}
          </tbody>
        </HTMLTable>
        {data.totals.count > exports.length && <p className={Classes.TEXT_MUTED}>The first {formatNumber(exports.length)} of {formatNumber(data.totals.count)}.</p>}
      </div>}

    {picked.length > 0 && <section aria-label="Selected exports" className={`${Classes.CARD} ${Classes.ELEVATION_3}`} style={{ position: 'sticky', bottom: 12, zIndex: 10, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginTop: 16, padding: '10px 16px' }}>
      <span><strong>{plural(picked.length, 'export')}</strong> selected · <strong>{formatBytes(picked_bytes)}</strong></span>
      <Button variant="minimal" text="Clear" onClick={() => setSelected(new Map())}/>
      <span style={{ marginLeft: 'auto' }}/>
      <Button intent={Intent.DANGER} icon="trash" text="Delete…" onClick={() => setConfirm(true)}/>
    </section>}
    <Alert
      isOpen={confirm}
      intent={Intent.DANGER}
      icon="trash"
      confirmButtonText={`Delete ${plural(picked.length, 'export')}`}
      cancelButtonText="Cancel"
      loading={busy}
      onConfirm={remove}
      onCancel={() => setConfirm(false)}
    >
      <p>Delete {plural(picked.length, 'export')} ({formatBytes(picked_bytes)})? People you shared them with lose them. The runs are not deleted.</p>
      {picked_linked > 0 && <p className={Classes.TEXT_MUTED}>{formatBytes(picked_linked)} are links to runs' files: that space is freed only once the runs are deleted too.</p>}
    </Alert>
  </>;
};

export default ExportsView;
