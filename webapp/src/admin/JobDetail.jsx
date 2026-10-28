// Admin → Storage → a job: what it does, its progress, its log, and its errors grouped by kind, owner and project,
// to fix them (e.g. permissions) and run it again.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AnchorButton, Button, Callout, Card, Classes, Colors, HTMLTable, Intent, NonIdealState, ProgressBar, Tag, Tooltip,
} from "@blueprintjs/core";
import styled from "styled-components";

import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { history, Link } from "../router";
import { Time, parseDate } from "../settings/format";
import { Loading } from "../settings/states";
import { AdminError } from "./states";
import { jobQuery, jobErrorsQuery, job_errors_page_size, cancelJob, retryJob, isActiveJob } from "./api";
import { Pager } from "./Users";
import {
  JobStatus, counters, error_kinds, errorKindLabel, nbErrors, number, formatBytes, formatDuration, jobDuration, isStale, kind_labels,
} from "./jobs";
import { Workers } from "./Storage";


const Counters = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 12px;
  margin: 16px 0 20px;
  .count {
    font-size: 24px;
    font-weight: 600;
    line-height: 1.2;
  }
`;

const Log = styled.pre`
  max-height: 320px;
  overflow: auto;
  font-size: 12px;
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`;
const level_classes = { error: Classes.INTENT_DANGER, warning: Classes.INTENT_WARNING, success: Classes.INTENT_SUCCESS, debug: Classes.TEXT_MUTED };


// Counts of errors by kind, owner or project: clicking one shows only its errors
const ErrorGroup = ({ title, rows, field, label = value => value ?? 'Unknown', filters, filter }) => rows.length > 0 && <Card compact style={{ minWidth: 0 }}>
  <h6 className={Classes.HEADING}>{title}</h6>
  <HTMLTable compact style={{ width: '100%' }}>
    <tbody>
      {rows.map(row => <tr key={row.value ?? ''}>
        <td style={{ overflowWrap: 'anywhere' }}>
          <Button
            variant="minimal"
            size="small"
            active={filters[field] === row.value}
            text={label(row.value)}
            onClick={() => filter({ [field]: filters[field] === row.value ? '' : row.value ?? '' })}
            style={{ textAlign: 'left' }}
          />
        </td>
        <td style={{ textAlign: 'right' }}>{number(row.count)}</td>
      </tr>)}
    </tbody>
  </HTMLTable>
</Card>;


const Errors = ({ job }) => {
  const [filters, setFilters] = useState({ kind: '', owner: '', project: '', offset: 0 });
  const { data, isPending, error, refetch, isFetching } = useQuery(jobErrorsQuery(job.id, filters, { active: isActiveJob(job) }));
  const filter = changes => setFilters(current => ({ ...current, offset: 0, ...changes }));
  if (isPending) return <Loading label="Loading the errors"/>;
  if (error) return <AdminError error={error} refetch={refetch} what="the errors"/>;
  const filtered = !!(filters.kind || filters.owner || filters.project);
  return <section aria-label="Errors" style={{ marginBottom: 24 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
      <h4 className={Classes.HEADING} style={{ margin: 0 }}>Errors <Tag minimal intent={Intent.DANGER} round>{number(nbErrors(job))}</Tag></h4>
      <AnchorButton icon="download" variant="minimal" text="Download all (CSV)" href={`/api/v1/admin/jobs/${job.id}/errors.csv`}/>
      {filtered && <Button variant="minimal" icon="cross" text="Clear the filters" onClick={() => filter({ kind: '', owner: '', project: '' })}/>}
    </div>
    {data.not_saved > 0 && <Callout intent={Intent.WARNING} style={{ marginBottom: 12 }}>
      Only the first errors were saved: {number(data.not_saved)} more were counted. Fix these, and run the job again.
    </Callout>}
    {!filtered && data.by_kind.filter(row => error_kinds[row.value]?.hint).map(row => <p key={row.value} className={Classes.TEXT_MUTED} style={{ margin: '0 0 6px' }}>
      <strong>{errorKindLabel(row.value)}</strong> ({number(row.count)}): {error_kinds[row.value].hint}
    </p>)}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, margin: '12px 0' }}>
      <ErrorGroup title="By kind" rows={data.by_kind} field="kind" label={errorKindLabel} filters={filters} filter={filter}/>
      <ErrorGroup title="By owner of the files" rows={data.by_owner} field="owner" filters={filters} filter={filter}/>
      <ErrorGroup title="By project" rows={data.by_project} field="project" filters={filters} filter={filter}/>
    </div>
    {data.errors.length === 0
      ? <NonIdealState icon="tick" title="No errors"/>
      : <div style={{ overflowX: 'auto', opacity: isFetching ? 0.7 : 1 }}>
        <HTMLTable compact style={{ width: '100%' }} aria-label="Errors list">
          <thead><tr><th>Kind</th><th>Path</th><th>Owner</th><th>Error</th><th>Run</th></tr></thead>
          <tbody>
            {data.errors.map(e => <tr key={e.id}>
              <td><Tag minimal intent={Intent.DANGER}>{errorKindLabel(e.kind)}</Tag></td>
              <td style={{ overflowWrap: 'anywhere', minWidth: 200 }}><code>{e.path ?? '—'}</code></td>
              <td>{e.owner ?? '—'}</td>
              <td style={{ overflowWrap: 'anywhere', minWidth: 240, fontSize: 12 }}>{e.message}</td>
              <td className={Classes.TEXT_MUTED} style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                {e.project_id && <div>{e.project_id}</div>}
                {e.output_id && <div>run {e.output_id}</div>}
              </td>
            </tr>)}
          </tbody>
        </HTMLTable>
        <Pager offset={filters.offset} page_size={job_errors_page_size} shown={data.errors.length} total={data.total} onChange={offset => setFilters({ ...filters, offset })}/>
      </div>}
  </section>;
};


export const JobDetail = ({ id }) => {
  const queryClient = useQueryClient();
  const { data: job, isPending, error, refetch } = useQuery(jobQuery(id));
  const [busy, setBusy] = useState(false);
  if (isPending) return <Loading label="Loading the job"/>;
  if (error) return error?.response?.status === 404
    ? <NonIdealState icon="search" title="This job doesn't exist" action={<Link to="/admin/storage">Back to the storage</Link>}/>
    : <AdminError error={error} refetch={refetch} what="the job"/>;

  const act = promise => {
    setBusy(true);
    return promise
      .catch(error => {
        toaster.show({ message: errorMessage(error), intent: Intent.DANGER, timeout: 8000 });
        return null;
      })
      .finally(() => setBusy(false));
  };
  const again = changes => act(retryJob(queryClient, job.id, changes)).then(new_job => new_job && history.push(`/admin/storage/jobs/${new_job.id}`));
  const cancel = () => act(cancelJob(queryClient, job.id)).then(job => job && toaster.show({ message: job.status === 'cancelled' ? 'Cancelled' : 'It stops in a few seconds', intent: Intent.SUCCESS, timeout: 3000 }));
  const forceCancel = () => act(cancelJob(queryClient, job.id, { force: true })).then(job => job && toaster.show({ message: 'Cancelled', intent: Intent.SUCCESS, timeout: 3000 }));

  const progress = job.progress ?? {};
  const active = isActiveJob(job);
  const fraction = progress.projects_total ? (progress.projects_done ?? 0) / progress.projects_total : null;
  const errors = nbErrors(job);
  const shown_counters = (counters[job.kind] ?? []).filter(counter => counter.main || progress[counter.key]);

  return <>
    <div style={{ marginBottom: 12 }}><Link to="/admin/storage">← Storage</Link></div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <h3 className={Classes.HEADING} style={{ margin: 0 }}>#{job.id} {job.kind_label ?? kind_labels[job.kind]}</h3>
      <JobStatus job={job}/>
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
        {active && !job.cancel_requested && <Button icon="stop" text="Cancel" intent={Intent.DANGER} variant="outlined" onClick={cancel} loading={busy}/>}
        {active && job.cancel_requested && <Tooltip content="Don't wait for its worker: another job of this kind can start. The worker may still be busy with it for a while, restart the jobs service to stop it at once." hoverOpenDelay={300}>
          <Button icon="disable" text="Stop without waiting" intent={Intent.DANGER} onClick={forceCancel} loading={busy}/>
        </Tooltip>}
        {!active && job.dry_run && <Button icon="trash" text="Run it for real" intent={Intent.DANGER} onClick={() => again({ dry_run: false })} loading={busy}/>}
        {!active && <Button icon="refresh" text="Run again" onClick={() => again()} loading={busy}/>}
      </span>
    </div>
    <p style={{ marginTop: 8 }}>{job.description}{job.dry_run ? ' — dry run: nothing is deleted' : ''}</p>
    <p className={Classes.TEXT_MUTED} style={{ fontSize: 13 }}>
      Started by {job.created_by ?? 'unknown'}{job.schedule_id ? ' (a schedule)' : ''}, <Time iso={job.created_at}/>
      {job.started_at && <> · {active ? 'running for' : 'took'} {formatDuration(jobDuration(job))}</>}
      {job.worker && active && <> · on {job.worker}</>}
      {job.attempts > 1 && <> · resumed {job.attempts - 1} time{job.attempts > 2 ? 's' : ''}</>}
    </p>

    {(progress.scan_id || job.params?.scan_id) && <Callout icon="search" style={{ marginBottom: 12 }}>
      <Link to={`/admin/storage/scans/${progress.scan_id ?? job.params.scan_id}`}>
        {job.kind === 'scan_storage' ? (active ? 'Explore what the scan found so far' : 'Explore what the scan found') : `Back to scan #${job.params.scan_id}`}
      </Link>
      {job.kind === 'scan_storage' && progress.roots_total ? <span className={Classes.TEXT_MUTED}> · {number(progress.roots_done ?? 0)} of {number(progress.roots_total)} storage roots, {number(progress.folders_done ?? 0)} of {number(progress.folders_total ?? 0)} of their folders{progress.dirs_explored ? `, ${number(progress.dirs_explored)} folders read` : ''}{progress.current && active ? <> · now in <code>{progress.current}</code></> : null}</span> : null}
    </Callout>}
    {active && job.cancel_requested && <Callout intent={Intent.WARNING} icon="stop" title="Cancelling" style={{ marginBottom: 12 }}>
      The job stops at its next check, usually in seconds. If it doesn't, its worker is stuck (e.g. on a storage that doesn't answer): stop it without waiting.
    </Callout>}
    {job.status === 'queued' && <Workers workers={job.workers} queued/>}
    {isStale(job) && <Callout intent={Intent.WARNING} title="No news from its worker">
      Its last heartbeat was <Time iso={job.heartbeat_at}/>. If the worker was stopped, the job is queued again after 10 minutes, and resumes where it was.
    </Callout>}
    {job.status === 'failed' && job.error && <Callout intent={Intent.DANGER} title="The job crashed" style={{ marginTop: 12 }}>
      <Log>{job.error}</Log>
    </Callout>}

    {fraction !== null && <div style={{ marginTop: 16 }}>
      <ProgressBar value={fraction} intent={errors ? Intent.WARNING : Intent.PRIMARY} stripes={active} animate={active}/>
      <div className={Classes.TEXT_MUTED} style={{ fontSize: 12, marginTop: 4 }}>
        {number(progress.projects_done ?? 0)} of {number(progress.projects_total)} projects
        {progress.projects_skipped ? `, ${number(progress.projects_skipped)} skipped` : ''}
        {progress.current_project && active && <> · now in <code>{progress.current_project}</code></>}
      </div>
    </div>}

    <Counters>
      {shown_counters.map(counter => {
        const key = job.dry_run && counter.dry_key ? counter.dry_key : counter.key;
        const content = <Card compact>
          <div className="count" style={counter.intent === Intent.DANGER && progress[key] ? { color: Colors.RED3 } : undefined}>{counter.format === 'bytes' ? formatBytes(progress[key]) : number(progress[key])}</div>
          <div className={Classes.TEXT_MUTED}>{job.dry_run && counter.dry ? counter.dry : counter.label}</div>
        </Card>;
        return counter.hint ? <Tooltip key={counter.key} content={counter.hint} hoverOpenDelay={300} targetTagName="div">{content}</Tooltip> : <div key={counter.key}>{content}</div>;
      })}
    </Counters>

    {errors > 0 && <Errors job={job}/>}

    <section aria-label="Log">
      <h4 className={Classes.HEADING}>Log</h4>
      <Card compact>
        <Log>
          {(job.log ?? []).length === 0
            ? <span className={Classes.TEXT_MUTED}>{job.status === 'queued' ? 'Waiting for a worker…' : 'Nothing yet'}</span>
            : job.log.map((line, i) => <div key={i} className={level_classes[line.level]}>
              <span className={Classes.TEXT_MUTED}>{parseDate(line.at)?.toFormat('LLL dd HH:mm:ss')}</span> {line.message}
            </div>)}
        </Log>
      </Card>
      <p className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>The latest lines. The worker's logs have everything (the backend's container).</p>
    </section>
  </>;
};

export default JobDetail;
