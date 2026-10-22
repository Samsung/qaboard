// "Your deletions": the deletions users started here, while they run and after, with their errors.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Classes, Collapse, HTMLTable, Intent, ProgressBar, Tag } from "@blueprintjs/core";

import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { Time } from "../settings/format";
import { JobStatus, nbErrors, errorKindLabel, error_kinds } from "../admin/jobs";
import { deletionsQuery, deletionErrorsQuery, cancelDeletion, isActiveDeletion, refreshUsage } from "./api";
import { formatBytes, plural } from "./format";


const Errors = ({ job }) => {
  const { data, isPending, error } = useQuery(deletionErrorsQuery(job.id));
  if (isPending) return <p className={Classes.TEXT_MUTED}>Loading the errors…</p>;
  if (error) return <p className={Classes.INTENT_DANGER}>{errorMessage(error)}</p>;
  return <>
    {data.by_kind.filter(row => error_kinds[row.value]?.hint).map(row => <p key={row.value} className={Classes.TEXT_MUTED} style={{ margin: '4px 0' }}>
      <strong>{errorKindLabel(row.value)}</strong>: {error_kinds[row.value].hint}
    </p>)}
    <div style={{ overflowX: 'auto' }}>
      <HTMLTable compact style={{ width: '100%' }} aria-label="Errors">
        <thead><tr><th>Error</th><th>Path</th><th>Owner</th></tr></thead>
        <tbody>
          {data.errors.map(e => <tr key={e.id}>
            <td><Tag minimal intent={Intent.DANGER}>{errorKindLabel(e.kind)}</Tag> <span style={{ fontSize: 12 }}>{e.message}</span></td>
            <td style={{ overflowWrap: 'anywhere' }}><code style={{ fontSize: 12 }}>{e.path ?? '—'}</code></td>
            <td>{e.owner ?? '—'}</td>
          </tr>)}
        </tbody>
      </HTMLTable>
    </div>
    {data.total > data.errors.length && <p className={Classes.TEXT_MUTED}>The first {data.errors.length} of {data.total} errors.</p>}
  </>;
};

const Deletion = ({ job }) => {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const progress = job.progress ?? {};
  const active = isActiveDeletion(job);
  const errors = nbErrors(job);
  const kept = (progress.runs_kept_milestones ?? 0) + (progress.runs_kept_running ?? 0);
  const cancel = () => cancelDeletion(queryClient, job.id)
    .catch(error => toaster.show({ message: errorMessage(error), intent: Intent.DANGER }));
  return <Card compact style={{ marginBottom: 8 }} data-testid={`deletion-${job.id}`}>
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <JobStatus job={job}/>
      <span style={{ flex: 1, minWidth: 200 }}>{job.params?.description ?? job.description}</span>
      <span className={Classes.TEXT_MUTED}><Time iso={job.created_at}/></span>
      {active && <Button size="small" icon="stop" text="Cancel" onClick={cancel} disabled={job.cancel_requested}/>}
    </div>
    {active && (progress.batches_total ?? progress.paths_total ?? progress.exports_total) > 0 && <ProgressBar
      value={((progress.batches_done ?? 0) || (progress.paths_deleted ?? 0) + (progress.paths_failed ?? 0) || (progress.exports_deleted ?? 0) + (progress.exports_failed ?? 0)) / (progress.batches_total ?? progress.paths_total ?? progress.exports_total)}
      intent={Intent.PRIMARY}
      stripes
      animate
      className={Classes.SMALL}
    />}
    <div className={Classes.TEXT_MUTED} style={{ fontSize: 13, marginTop: 6 }}>
      {job.status === 'queued' ? 'Waiting to start…' : <>
        {job.kind === 'delete_exports'
          ? <>{plural(progress.exports_deleted ?? 0, 'export')} deleted, {formatBytes(Math.max(0, (progress.bytes_deleted ?? 0) - (progress.linked_bytes ?? 0)))} freed{progress.linked_bytes ? `, ${formatBytes(progress.linked_bytes)} more once the runs are deleted` : ''}</>
          : job.kind === 'delete_paths'
            ? <>{formatBytes(progress.bytes_deleted ?? 0)} freed, {plural(progress.paths_deleted ?? 0, 'folder')} deleted</>
            : <>{formatBytes(progress.bytes_deleted ?? 0)} freed, {plural(progress.runs_deleted ?? 0, 'run')} deleted</>}
        {kept > 0 && `, ${plural(kept, 'run')} kept (milestones or running)`}
      </>}
      {errors > 0 && <Button variant="minimal" size="small" intent={Intent.DANGER} text={`${plural(errors, 'error')}`} rightIcon={open ? 'chevron-up' : 'chevron-down'} onClick={() => setOpen(!open)}/>}
    </div>
    <Collapse isOpen={open}>{open && <Errors job={job}/>}</Collapse>
  </Card>;
};

// The latest deletions, while one runs or for a few days after
const RECENT_DAYS = 7;
const isRecent = job => isActiveDeletion(job) || (Date.now() - new Date(job.created_at).getTime()) < RECENT_DAYS * 86400 * 1000;
export const Deletions = () => {
  const queryClient = useQueryClient();
  const { data: jobs = [] } = useQuery(deletionsQuery);
  // when a deletion ends, the numbers change
  const active_ids = jobs.filter(isActiveDeletion).map(job => job.id).join();
  const previous = useRef(active_ids);
  useEffect(() => {
    if (previous.current && previous.current !== active_ids) refreshUsage(queryClient);
    previous.current = active_ids;
  }, [active_ids, queryClient]);
  const recent = jobs.filter(isRecent).slice(0, 5);
  if (recent.length === 0) return null;
  return <section aria-label="Your deletions" style={{ marginBottom: 20 }}>
    <h4 className={Classes.HEADING}>Your deletions</h4>
    {recent.map(job => <Deletion key={job.id} job={job}/>)}
  </section>;
};

export default Deletions;
