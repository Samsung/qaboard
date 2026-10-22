// Admin → Storage: clean the storage with server jobs, now or on a schedule, and follow them.
// Jobs run in the background (`qaboard-admin jobs worker`, next to the backend): their page shows their progress and errors.
import { useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, ButtonGroup, Callout, Card, Classes, HTMLTable, Intent, NonIdealState, Switch, Tag, Tooltip } from "@blueprintjs/core";

import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { history, Link } from "../router";
import { Time } from "../settings/format";
import { Loading } from "../settings/states";
import { AdminError } from "./states";
import { jobsQuery, schedulesQuery, saveSchedule, deleteSchedule, runSchedule, scansQuery } from "./api";
import { JobStatus, kind_labels, progressSummary, nbErrors, number, formatDuration, jobDuration, isStale, formatBytes } from "./jobs";
import { KindsBar } from "./ScanExplorer";
import { JobDialog, ScheduleDialog, kind_icons } from "./JobForm";


// Jobs only run if a worker does: admins must know when none does
export const Workers = ({ workers, queued }) => {
  const online = workers?.online ?? [];
  if (online.length > 0)
    return <span className={Classes.TEXT_MUTED} data-testid="workers">
      <Tag minimal intent={Intent.SUCCESS} round icon="pulse">{online.length} worker{online.length === 1 ? '' : 's'}</Tag>
      {' '}ready to run jobs
    </span>;
  return <Callout intent={queued ? Intent.DANGER : Intent.WARNING} title="No worker is running jobs" data-testid="workers">
    {queued ? 'Queued jobs will wait until one starts. ' : ''}
    The backend starts one next to the server, unless <code>QABOARD_JOBS_WORKER=0</code>: check the backend's logs,
    or run <code>qaboard-admin jobs worker</code>.
    {workers?.last_seen_at && <> The last one was seen <Time iso={workers.last_seen_at}/>.</>}
  </Callout>;
};


const JobsTable = ({ jobs }) => <div style={{ overflowX: 'auto' }}>
  <HTMLTable compact interactive style={{ width: '100%' }} aria-label="Jobs">
    <thead>
      <tr>
        <th>Job</th>
        <th>Status</th>
        <th>Progress</th>
        <th>Errors</th>
        <th>Started by</th>
        <th>Created</th>
        <th>Duration</th>
      </tr>
    </thead>
    <tbody>
      {jobs.map(job => {
        const errors = nbErrors(job);
        return <tr key={job.id} onClick={event => { if (!event.target.closest('a')) history.push(`/admin/storage/jobs/${job.id}`); }} style={{ cursor: 'pointer' }}>
          <td style={{ minWidth: 220 }}>
            <Link to={`/admin/storage/jobs/${job.id}`}><strong>#{job.id} {job.kind_label ?? kind_labels[job.kind] ?? job.kind}</strong></Link>
            <div className={Classes.TEXT_MUTED} style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{job.description}</div>
          </td>
          <td>
            <JobStatus job={job}/>
            {isStale(job) && <div><Tag minimal intent={Intent.WARNING}>No news from its worker</Tag></div>}
          </td>
          <td style={{ minWidth: 180 }}>{progressSummary(job)}</td>
          <td>{errors ? <Tag minimal intent={Intent.DANGER} round>{number(errors)}</Tag> : <span className={Classes.TEXT_MUTED}>—</span>}</td>
          <td style={{ overflowWrap: 'anywhere' }}>{job.created_by ?? '—'}</td>
          <td><Time iso={job.created_at}/></td>
          <td style={{ whiteSpace: 'nowrap' }}>{formatDuration(jobDuration(job)) || <span className={Classes.TEXT_MUTED}>—</span>}</td>
        </tr>;
      })}
    </tbody>
  </HTMLTable>
</div>;


const Jobs = () => {
  const { data, isPending, error, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery(jobsQuery());
  const jobs = data?.pages.flatMap(page => page.jobs) ?? [];
  const workers = data?.pages[0]?.workers;
  return <section aria-label="Jobs" style={{ marginBottom: 32 }}>
    <h4 className={Classes.HEADING}>Jobs</h4>
    {isPending && <Loading label="Loading the jobs"/>}
    {error && <AdminError error={error} refetch={refetch} what="the jobs"/>}
    {!isPending && !error && <>
      <div style={{ marginBottom: 12 }}><Workers workers={workers} queued={jobs.some(job => job.status === 'queued')}/></div>
      {jobs.length === 0
        ? <NonIdealState icon="history" title="No jobs yet" description="Jobs you start, and those of the schedules, show up here, with their progress and errors."/>
        : <>
          <JobsTable jobs={jobs}/>
          {hasNextPage && <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
            <Button variant="minimal" icon="chevron-down" text="Older jobs" loading={isFetchingNextPage} onClick={() => fetchNextPage()}/>
          </div>}
        </>}
    </>}
  </section>;
};


const Schedules = () => {
  const queryClient = useQueryClient();
  const { data: schedules = [], isPending, error, refetch } = useQuery(schedulesQuery);
  const [editing, setEditing] = useState(null);  // {} for a new one
  const [deleting, setDeleting] = useState(null);
  const fail = error => toaster.show({ message: errorMessage(error), intent: Intent.DANGER, timeout: 8000 });

  const toggle = schedule => saveSchedule(queryClient, schedule.id, { enabled: !schedule.enabled })
    .then(saved => toaster.show({ message: `"${saved.name}" is ${saved.enabled ? 'enabled' : 'disabled'}`, intent: Intent.SUCCESS, timeout: 3000 }))
    .catch(fail);
  const run = schedule => runSchedule(queryClient, schedule.id)
    .then(job => history.push(`/admin/storage/jobs/${job.id}`))
    .catch(fail);
  const remove = schedule => deleteSchedule(queryClient, schedule.id)
    .then(() => toaster.show({ message: `Deleted "${schedule.name}"`, intent: Intent.SUCCESS, timeout: 3000 }))
    .catch(fail)
    .finally(() => setDeleting(null));

  return <section aria-label="Schedules" style={{ marginBottom: 32 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
      <h4 className={Classes.HEADING} style={{ margin: 0 }}>Schedules</h4>
      <Button icon="add" text="New schedule" onClick={() => setEditing({})}/>
    </div>
    {isPending && <Loading label="Loading the schedules"/>}
    {error && <AdminError error={error} refetch={refetch} what="the schedules"/>}
    {!isPending && !error && (schedules.length === 0
      ? <p className={Classes.TEXT_MUTED}>
        No schedules. Replace the server's cron jobs (e.g. <code>qaboard_clean</code>) with schedules: their runs are listed here, with their errors.
      </p>
      : <div style={{ overflowX: 'auto' }}>
        <HTMLTable compact style={{ width: '100%' }} aria-label="Schedules">
          <thead>
            <tr>
              <th>Schedule</th>
              <th>When</th>
              <th>Next run</th>
              <th>Last run</th>
              <th>Enabled</th>
              <th><span className={Classes.TEXT_MUTED}>Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {schedules.map(schedule => <tr key={schedule.id}>
              <td style={{ minWidth: 220 }}>
                <strong>{schedule.name}</strong>
                <div className={Classes.TEXT_MUTED} style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{schedule.description}{schedule.params?.dry_run ? ' (dry run)' : ''}</div>
              </td>
              <td><code>{schedule.cron}</code> <span className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>{schedule.timezone}</span></td>
              <td>{schedule.enabled ? <Time iso={schedule.next_run_at} never="—"/> : <span className={Classes.TEXT_MUTED}>Disabled</span>}</td>
              <td>
                {schedule.last_job
                  ? <Link to={`/admin/storage/jobs/${schedule.last_job.id}`} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <JobStatus job={schedule.last_job}/> <Time iso={schedule.last_job.created_at}/>
                  </Link>
                  : <span className={Classes.TEXT_MUTED}>Never</span>}
                {schedule.last_message && <div style={{ fontSize: 12 }} className={Classes.INTENT_WARNING}>{schedule.last_message}</div>}
              </td>
              <td><Switch checked={schedule.enabled} onChange={() => toggle(schedule)} aria-label={`Enable ${schedule.name}`} style={{ marginBottom: 0 }}/></td>
              {/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- its buttons have their labels */}
              <td style={{ whiteSpace: 'nowrap' }}>
                <ButtonGroup variant="minimal">
                  <Tooltip content="Run it now" hoverOpenDelay={300}><Button icon="play" aria-label={`Run ${schedule.name} now`} onClick={() => run(schedule)}/></Tooltip>
                  <Tooltip content="Edit" hoverOpenDelay={300}><Button icon="edit" aria-label={`Edit ${schedule.name}`} onClick={() => setEditing(schedule)}/></Tooltip>
                  <Tooltip content="Delete" hoverOpenDelay={300}><Button icon="trash" aria-label={`Delete ${schedule.name}`} onClick={() => setDeleting(schedule)}/></Tooltip>
                </ButtonGroup>
              </td>
            </tr>)}
          </tbody>
        </HTMLTable>
      </div>)}
    {editing && <ScheduleDialog isOpen schedule={editing} onClose={() => setEditing(null)}/>}
    <Alert
      isOpen={!!deleting}
      intent={Intent.DANGER}
      icon="trash"
      confirmButtonText="Delete"
      cancelButtonText="Cancel"
      onConfirm={() => remove(deleting)}
      onCancel={() => setDeleting(null)}
    >
      <p>Delete the schedule "{deleting?.name}"? Its past jobs stay listed.</p>
    </Alert>
  </section>;
};


const actions = [
  {
    kind: 'hard_delete',
    initial: { runs: 'deleted' },
    title: 'Hard-delete deleted runs',
    description: "When users delete runs, QA-Board deletes their files but keeps their metadata. Delete them for good: their rows, and what's left of their files. Milestones are kept.",
  },
  {
    kind: 'hard_delete',
    initial: { runs: 'missing_files' },
    title: 'Purge runs whose files are gone',
    description: "Runs whose folder was deleted outside QA-Board (quota scripts, users...) stay listed, without files. Delete their metadata. No file is deleted, milestones are kept.",
  },
  {
    kind: 'delete_artifacts',
    title: 'Delete artifacts',
    description: "Delete what qa save-artifacts saved for commits without recent runs (builds, configurations...). Milestones' artifacts are kept, and QA-Board can recreate them.",
  },
  {
    kind: 'garbage_collect',
    title: 'Delete old results',
    description: "Delete the files of old runs, as each project's qaboard.yaml says (storage.garbage), like qaboard_clean. Set a default for the projects that say nothing.",
  },
  {
    kind: 'scan_storage',
    title: 'Scan the storage',
    description: "Walk the projects' folders and find what QA-Board doesn't track: exports, runs it doesn't know, leftovers of deleted runs, other files. Then explore them by size and owner, and delete them.",
  },
  {
    kind: 'measure_deleted',
    title: "Measure what deleted runs left",
    description: "Deleting runs keeps their manifests, and files the manifests didn't list. QA-Board now measures them when it deletes runs: measure those deleted before, so users see them in Storage usage.",
  },
  {
    kind: 'fail_stuck_runs',
    title: 'Fail stuck runs',
    description: "Runs still waiting or running after a week: their job died without telling QA-Board. Mark them as failed, so they're out of the way in Runs activity, and users can redo them. Nothing is deleted.",
  },
];

const Scans = () => {
  const { data: scans = [], isPending, error, refetch } = useQuery(scansQuery);
  if (isPending) return null;
  if (error) return <AdminError error={error} refetch={refetch} what="the scans"/>;
  if (scans.length === 0) return null;
  const max = Math.max(0, ...scans.map(scan => scan.bytes));
  return <section aria-label="Scans" style={{ marginBottom: 32 }}>
    <h4 className={Classes.HEADING}>Scans</h4>
    <div style={{ overflowX: 'auto' }}>
      <HTMLTable compact interactive style={{ width: '100%' }} aria-label="Scans">
        <thead><tr><th>Scan</th><th>Status</th><th>On disk</th><th>Not tracked</th><th>Files</th><th>Errors</th><th>Finished</th></tr></thead>
        <tbody>
          {scans.map(scan => <tr key={scan.id} onClick={event => { if (!event.target.closest('a')) history.push(`/admin/storage/scans/${scan.id}`); }} style={{ cursor: 'pointer' }}>
            <td style={{ minWidth: 200 }}>
              <Link to={`/admin/storage/scans/${scan.id}`}><strong>Scan #{scan.id}</strong></Link>
              <div className={Classes.TEXT_MUTED} style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{scan.roots.length} folders{scan.roots.length ? `: ${scan.roots.slice(0, 2).join(', ')}${scan.roots.length > 2 ? '…' : ''}` : ''}</div>
            </td>
            <td>{scan.job ? <JobStatus job={scan.job}/> : <Tag minimal>{scan.status}</Tag>}</td>
            <td><KindsBar kinds={scan.by_kind} bytes={scan.bytes} max={max}/></td>
            <td><strong>{formatBytes(scan.untracked_bytes)}</strong></td>
            <td>{number(scan.files)}</td>
            <td>{scan.errors ? <Tag minimal intent={Intent.DANGER} round>{number(scan.errors)}</Tag> : <span className={Classes.TEXT_MUTED}>—</span>}</td>
            <td><Time iso={scan.finished_at} never="—"/></td>
          </tr>)}
        </tbody>
      </HTMLTable>
    </div>
  </section>;
};

export const Storage = () => {
  const [starting, setStarting] = useState(null);
  return <>
    <section aria-label="Clean the storage" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12, marginBottom: 28 }}>
      {actions.map(action => <Card key={action.title} compact style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h5 className={Classes.HEADING} style={{ margin: 0 }}>{action.title}</h5>
        <p className={Classes.TEXT_MUTED} style={{ margin: 0, flex: 1 }}>{action.description}</p>
        <div><Button icon={kind_icons[action.kind]} text="Start…" aria-label={`Start: ${action.title}`} onClick={() => setStarting(action)}/></div>
      </Card>)}
    </section>
    {starting && <JobDialog kind={starting.kind} initial={starting.initial} title={starting.title} isOpen onClose={() => setStarting(null)}/>}
    <Scans/>
    <Schedules/>
    <Jobs/>
  </>;
};

export default Storage;
