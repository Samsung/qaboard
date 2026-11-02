// Admin → Storage: how we show server jobs (api/admin_jobs.py): their status, what they did, their errors.
import { Classes, Intent, Spinner, Tag, Tooltip } from "@blueprintjs/core";

import { parseDate } from "../settings/format";


// Decimal units, like IT's quotas
export const formatBytes = bytes => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = Number(bytes ?? 0);
  let unit = 0;
  while (size >= 1000 && unit < units.length - 1) {
    size /= 1000;
    unit += 1;
  }
  return unit === 0 ? `${size} B` : `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
};


export const kind_labels = {
  hard_delete: 'Hard-delete runs',
  garbage_collect: 'Delete old results',
  delete_artifacts: 'Delete artifacts',
  scan_storage: 'Scan the storage',
  measure_deleted: 'Measure what deleted runs left',
  fail_stuck_runs: 'Fail stuck runs',
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
  } else if (job.kind === 'delete_artifacts') {
    parts.push(`artifacts of ${plural(progress.commits_deleted ?? 0, 'commit')} ${job.dry_run ? 'to delete' : 'deleted'}`);
    if (progress.artifacts_files) parts.push(`${plural(progress.artifacts_files, 'file')}`);
  } else if (job.kind === 'garbage_collect') {
    parts.push(`${plural(progress.outputs ?? 0, 'run')} ${job.dry_run ? 'to clean' : 'cleaned'}`);
    if (progress.artifacts) parts.push(`artifacts of ${plural(progress.artifacts, 'commit')}`);
  } else if (job.kind === 'scan_storage') {
    parts.push(`${formatBytes(progress.bytes ?? 0)} in ${plural(progress.files ?? 0, 'file')}`);
    if (progress.folders_total) parts.push(`${number(progress.folders_done ?? 0)}/${plural(progress.folders_total, 'folder')}`);
    if (progress.dirs_explored) parts.push(`${plural(progress.dirs_explored, 'folder')} read`);
  } else if (job.kind === 'measure_deleted') {
    parts.push(`${plural(progress.runs_checked ?? 0, 'run')} measured, ${formatBytes(progress.bytes_left ?? 0)} left`);
  } else if (job.kind === 'fail_stuck_runs') {
    parts.push(`${plural(progress.runs_failed ?? 0, 'run')} ${job.dry_run ? 'to mark as failed' : 'marked as failed'}`);
  } else if (['delete_runs', 'delete_exports', 'delete_paths'].includes(job.kind)) {
    parts.push(`${formatBytes(progress.bytes_deleted ?? 0)} freed`);
  } else if (job.kind === 'import_runs') {
    parts.push(`${plural(progress.runs_imported ?? 0, 'run')} added`);
  } else if (job.kind === 'sync_groups' && progress.users !== undefined) {
    parts.push(`${plural(progress.users_changed ?? 0, 'user')} changed groups`);
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
    { key: 'live_runs_without_files', label: "weren't deleted, but had no files", hint: "Their folders were deleted outside QA-Board, e.g. by a quota script." },
    { key: 'runs_protected', label: 'Runs kept in milestones', hint: "In batches saved as milestones, or commits that qaboard.yaml protects." },
    { key: 'runs_failed', label: 'Runs kept because of errors', intent: Intent.DANGER, hint: "They'll be tried again by the next job: see the errors." },
    { key: 'batches_deleted', label: 'Empty batches deleted', dry: 'Batches checked', dry_key: 'batches_checked' },
    { key: 'batches_checked', label: 'Batches checked' },
  ],
  delete_artifacts: [
    { key: 'commits_deleted', label: 'Commits without artifacts', dry: 'Commits whose artifacts would be deleted', main: true },
    { key: 'commits_without_files', label: 'were already gone', hint: "Their artifacts folder was already deleted: they're only marked as such (the fast path)." },
    { key: 'artifacts_files', label: 'Files deleted', dry: 'Files to delete' },
    { key: 'artifacts_files_kept', label: 'Files kept', hint: "Listed in `keep`, or used by other subprojects of the same commit." },
    { key: 'commits_protected', label: 'Commits kept for milestones', hint: "Their artifacts are needed to redo or compare milestones." },
    { key: 'commits_busy', label: 'Commits with runs in progress' },
    { key: 'commits_failed', label: 'Commits with errors', intent: Intent.DANGER, hint: "The next job tries them again: see the errors." },
    { key: 'commits_checked', label: 'Commits checked' },
  ],
  scan_storage: [
    { key: 'bytes', label: 'Scanned', main: true, format: 'bytes' },
    { key: 'files', label: 'Files' },
    { key: 'folders_done', label: 'Folders done' },
    { key: 'folders_total', label: 'Folders to scan' },
    { key: 'dirs_explored', label: 'Folders read', hint: "Inside them too: big folders take a while to be done, this shows the scan is moving." },
  ],
  measure_deleted: [
    { key: 'runs_checked', label: 'Deleted runs checked', main: true },
    { key: 'runs_measured', label: 'had files left' },
    { key: 'bytes_left', label: 'Left on disk', format: 'bytes' },
    { key: 'runs_without_files', label: 'had no files left', hint: "Their folders were gone." },
  ],
  fail_stuck_runs: [
    { key: 'runs_failed', label: 'Runs marked as failed', dry: 'Runs to mark as failed', main: true },
    { key: 'batches', label: 'Batches' },
    { key: 'projects', label: 'Projects' },
  ],
  delete_paths: [
    { key: 'bytes_deleted', label: 'Freed', main: true, format: 'bytes' },
    { key: 'paths_deleted', label: 'Folders and files deleted' },
    { key: 'paths_failed', label: 'Not deleted, because of errors', intent: Intent.DANGER },
  ],
  delete_exports: [
    { key: 'bytes_deleted', label: 'Freed', main: true, format: 'bytes', hint: "At most: hard links free their space only when the runs are deleted too." },
    { key: 'exports_deleted', label: 'Exports deleted' },
    { key: 'exports_failed', label: 'Not deleted, because of errors', intent: Intent.DANGER },
  ],
  import_runs: [
    { key: 'runs_imported', label: 'Runs added to QA-Board', main: true },
    { key: 'bytes', label: 'Their size', format: 'bytes' },
  ],
  sync_groups: [
    { key: 'users_changed', label: 'Users who changed groups', main: true },
    { key: 'users', label: 'Users checked' },
    { key: 'ldap_accounts', label: 'LDAP accounts updated' },
    { key: 'ldap_unknown', label: "LDAP accounts the directory doesn't know", hint: "They lost their directory groups." },
    { key: 'sso_refreshed', label: 'Single sign-on accounts refreshed' },
    { key: 'sso_refused', label: 'Refresh tokens refused', hint: "Their groups from that provider ended, and their sessions from it: signing in again gives them back." },
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
  storage: { label: 'Storage not mounted?', hint: "A folder is missing right under a storage root, or outside the storage: the storage may not be mounted, so QA-Board kept the runs. Check the mounts of the backend's container." },
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
