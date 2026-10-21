// Admin → Storage: how we show server jobs (api/admin_jobs.py): their status, what they did, their errors.
import { Classes, Intent, Spinner, Tag, Tooltip } from "@blueprintjs/core";

import { parseDate } from "../settings/format";


export const kind_labels = {
  hard_delete: 'Hard-delete deleted runs',
  garbage_collect: 'Delete old results',
};

const statuses = {
  queued: { label: 'Queued', icon: 'time' },
  running: { label: 'Running', intent: Intent.PRIMARY },
  done: { label: 'Done', intent: Intent.SUCCESS, icon: 'tick' },
  done_with_errors: { label: 'Done with errors', intent: Intent.WARNING, icon: 'warning-sign' },
  failed: { label: 'Failed', intent: Intent.DANGER, icon: 'error' },
  cancelled: { label: 'Cancelled', icon: 'disable' },
};

export const nbErrors = job => Object.values(job?.progress?.errors ?? {}).reduce((total, count) => total + count, 0);

export const JobStatus = ({ job }) => {
  const status = statuses[job.status] ?? { label: job.status };
  const label = job.status === 'running' && job.cancel_requested ? 'Cancelling' : status.label;
  return <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', whiteSpace: 'nowrap' }}>
    <Tag minimal intent={status.intent} icon={job.status === 'running' ? <Spinner size={12}/> : status.icon}>{label}</Tag>
    {job.dry_run && <Tooltip content="Nothing was deleted: it says what would be" hoverOpenDelay={300}><Tag minimal round>dry run</Tag></Tooltip>}
  </span>;
};

export const number = value => (value ?? 0).toLocaleString('en-US');
const plural = (count, word) => `${number(count)} ${word}${count === 1 ? '' : 's'}`;

// One line: what the job did so far
export const progressSummary = job => {
  const progress = job.progress ?? {};
  const parts = [];
  if (job.kind === 'hard_delete') {
    parts.push(`${plural(progress.runs_deleted ?? 0, 'run')} ${job.dry_run ? 'to delete' : 'deleted'}`);
    if (progress.runs_protected) parts.push(`${number(progress.runs_protected)} kept in milestones`);
  } else if (job.kind === 'garbage_collect') {
    parts.push(`${plural(progress.outputs ?? 0, 'run')} ${job.dry_run ? 'to clean' : 'cleaned'}`);
    if (progress.artifacts) parts.push(`artifacts of ${plural(progress.artifacts, 'commit')}`);
  }
  if (progress.projects_total) parts.push(`${number(progress.projects_done ?? 0)}/${plural(progress.projects_total, 'project')}`);
  return parts.join(', ');
};

// The counters of the job page, in order. `dry`: the label of dry runs.
export const counters = {
  hard_delete: [
    { key: 'runs_deleted', label: 'Runs deleted', dry: 'Runs to delete', main: true },
    { key: 'runs_without_files', label: 'had no files left', hint: "Their folders were already gone: only their metadata was deleted (the fast path)." },
    { key: 'runs_with_files', label: 'had files', hint: "What soft deletes left, e.g. their manifest." },
    { key: 'runs_protected', label: 'Runs kept in milestones', hint: "In batches saved as milestones, or commits that qaboard.yaml protects." },
    { key: 'runs_failed', label: 'Runs kept because of errors', intent: Intent.DANGER, hint: "They'll be tried again by the next job: see the errors." },
    { key: 'batches_deleted', label: 'Empty batches deleted', dry: 'Batches checked', dry_key: 'batches_checked' },
    { key: 'batches_checked', label: 'Batches checked' },
  ],
  garbage_collect: [
    { key: 'outputs', label: 'Runs cleaned', dry: 'Runs to clean', main: true, hint: "Their files are deleted, their metadata stays: a hard delete removes it later." },
    { key: 'commits', label: 'Commits' },
    { key: 'artifacts', label: 'Commits without artifacts', dry: 'Commits whose artifacts would be deleted' },
    { key: 'artifacts_files', label: 'Artifact files deleted', dry: 'Artifact files to delete' },
  ],
};

export const error_kinds = {
  permission: { label: 'Permissions', hint: "The server could not delete files: fix who owns them or their permissions, then run the job again." },
  unsafe_path: { label: 'Outside the storage', hint: "The folder is outside $QABOARD_STORAGE_ROOTS: QA-Board never deletes there. Add the storage, or delete it yourself." },
  git: { label: 'Git', hint: "The project's git repository can't be read: the server can't know which commits qaboard.yaml protects, so the project was skipped." },
  config: { label: 'qaboard.yaml', hint: "The project's storage settings are invalid." },
  database: { label: 'Database' },
  other: { label: 'Other' },
};
export const errorKindLabel = kind => error_kinds[kind]?.label ?? kind;

// "2h 5min", "45s"
export const formatDuration = seconds => {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '';
  const s = Math.max(0, Math.round(seconds));
  const days = Math.floor(s / 86400), hours = Math.floor(s % 86400 / 3600), minutes = Math.floor(s % 3600 / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}min`;
  if (minutes) return `${minutes}min ${s % 60}s`;
  return `${s}s`;
};

export const jobDuration = job => {
  const start = parseDate(job.started_at);
  if (!start?.isValid) return null;
  const end = parseDate(job.finished_at);
  return ((end?.isValid ? end : null) ?? parseDate(new Date().toISOString())).diff(start, 'seconds').seconds;
};

// Running jobs whose worker stopped saying it's alive
export const isStale = job => {
  if (job.status !== 'running') return false;
  const heartbeat = parseDate(job.heartbeat_at);
  return !!heartbeat?.isValid && -heartbeat.diffNow('minutes').minutes > 3;
};

export const Muted = ({ children }) => <span className={Classes.TEXT_MUTED}>{children}</span>;
