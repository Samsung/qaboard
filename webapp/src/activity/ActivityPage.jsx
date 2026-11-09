// /activity: what waits and runs now, what ended recently, and the batches that start soon, grouped as users like.
// Everything the page shows is in its URL (?scope=&project=&group=...), so it can be shared and bookmarked.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert, Button, Callout, Card, Classes, Dialog, DialogBody, DialogFooter, HTMLSelect, HTMLTable, Icon, InputGroup, Intent,
  Menu, MenuDivider, MenuItem, NonIdealState, Popover, Spinner, Switch, Tag, Tooltip,
} from "@blueprintjs/core";
import { useLocation } from "react-router";
import styled from "styled-components";

import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { history, Link } from "../router";
import { PageShell, RequireLogin } from "../components/PageShell";
import { Time } from "../settings/format";
import { Loading, QueryError } from "../settings/states";
import { useSubmissionStatus, whereItRuns } from "../components/logs/submissions";
import { JobDialog, ScheduleDialog } from "../admin/JobForm";
import { overviewQuery, itemsQuery, runsQuery, failRuns, stopBatch, items_page_size, runs_page_size, match_keys } from "./api";
import { WhoseRuns } from "../components/WhoseRuns";
import { statuses, RunStatus, StatusBar, StatusText, Timeline, formatDuration, formatNumber, plural, secondsSince } from "./format";


export const groups = [
  { id: 'batch', label: 'Batch' },
  { id: 'commit', label: 'Commit' },
  { id: 'branch', label: 'Branch' },
  { id: 'project', label: 'Project' },
  { id: 'user', label: 'User' },
  { id: 'command', label: 'qa batch command' },
  { id: 'runner', label: 'Runner' },
  { id: 'queue', label: 'Queue' },
  { id: 'platform', label: 'Platform' },
  { id: 'option', label: 'Job option…' },
  { id: 'status', label: 'Status' },
  { id: 'runs', label: "Nothing: the runs" },
];
const windows = [
  { value: '1h', label: 'Last hour' },
  { value: '6h', label: 'Last 6 hours' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '3d', label: 'Last 3 days' },
  { value: '7d', label: 'Last 7 days' },
];
const status_options = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Waiting or running' },
  { value: 'long', label: 'Pending for over a day' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'running', label: 'Running' },
  { value: 'ended', label: 'Ended' },
  { value: 'failed', label: 'Failed' },
];
// the runs themselves
const run_sort_options = [
  { value: '', label: 'Pending first, then the latest' },
  { value: 'oldest', label: 'Pending the longest first' },
];
const sort_options = [
  { value: 'active', label: 'Most active first' },
  { value: 'oldest', label: 'Pending the longest first' },
  { value: 'latest', label: 'Latest news first' },
  { value: 'runs', label: 'Most runs first' },
  { value: 'failed', label: 'Most failures first' },
];
// job options people often group by
const common_options = ['project', 'queue', 'memory', 'threads', 'host', 'resources'];
// pending for longer: maybe stuck
const LONG_SECONDS = 24 * 3600;

const filter_keys = ['scope', 'user', 'project', 'window', 'status', 'group', 'option', 'search', 'sort', 'page', ...match_keys];
export const readFilters = search => {
  const params = new URLSearchParams(search);
  return Object.fromEntries(filter_keys.map(key => [key, params.get(key) ?? '']));
};
export const activityUrl = filters => {
  const params = new URLSearchParams(Object.entries(filters).filter(([key, value]) => value && filter_keys.includes(key) && !(key === 'scope' && value === 'me')));
  const query = params.toString();
  return `/activity${query ? `?${query}` : ''}`;
};

const Summary = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
  .value { font-size: 26px; font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums; }
`;

const Toolbar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
`;

const Meta = styled.div.attrs({ className: Classes.TEXT_MUTED })`
  font-size: 12px;
  overflow-wrap: anywhere;
`;

// Inline text, e.g. a project or a queue: clicking shows only its runs
const FilterText = styled.button`
  all: unset;
  cursor: pointer;
  border-radius: 2px;
  overflow-wrap: anywhere;
  &:hover { text-decoration: underline; color: var(--qa-text, inherit); }
  &:focus-visible { outline: 2px solid #4c90f0; }
`;
const FilterOn = ({ value, current, onFilter, title, children }) => !value || value === current
  ? <span>{children ?? value}</span>
  : <FilterText type="button" title={title} onClick={onFilter}>{children ?? value}</FilterText>;

// A small button after a group's name: only its runs
// Faint until users point at its row: tables would be full of them
const OnlyButton = ({ label, onClick }) => <Tooltip content={label} hoverOpenDelay={300}>
  <Button size="small" variant="minimal" icon="filter" aria-label={label} onClick={onClick} className="only-button"/>
</Tooltip>;
const Rows = styled.div`
  .only-button { opacity: 0.25; transition: opacity 0.1s; }
  tr:hover .only-button, .only-button:focus-visible { opacity: 1; }
`;

// The URL parameter that keeps only a group's runs, e.g. ?queue=gpu
const group_filter = { batch: 'batch', commit: 'commit', command: 'command', branch: 'branch', runner: 'runner', queue: 'queue', platform: 'platform', option: 'option_value' };
const filterOnGroup = (group, item, filters) => {
  const param = group_filter[group];
  if (!param || item.key === '' || item.key === null || item.key === undefined || String(filters[param]) === String(item.key)) return null;
  return { [param]: String(item.key), page: '' };
};

// The filters on groups of runs, as removable tags. `matched` names the batch or commit (overview.matched).
const match_tags = {
  batch: (value, matched) => ({ icon: 'layers', text: matched.batch ? <>Batch {matched.batch.batch_label} <span className={Classes.TEXT_MUTED}>· {matched.batch.project_id} · {matched.batch.hexsha?.slice(0, 8)}</span></> : <>Batch #{value}</> }),
  commit: (value, matched) => ({ icon: 'git-commit', text: matched.commit ? <>Commit <code>{matched.commit.hexsha?.slice(0, 8)}</code> <span className={Classes.TEXT_MUTED}>· {matched.commit.project_id}</span></> : <>Commit #{value}</> }),
  command: value => ({ icon: 'console', text: <>qa batch <code>{value.slice(0, 8)}</code></> }),
  branch: value => ({ icon: 'git-branch', text: <>Branch {value}</> }),
  runner: value => ({ icon: 'build', text: <>Runner {value}</> }),
  queue: value => ({ icon: 'inbox', text: <>Queue {value}</> }),
  platform: value => ({ icon: 'desktop', text: <>Platform {value}</> }),
  option_value: (value, matched, filters) => ({ icon: 'properties', text: <>{filters.option || 'Job option'}: {value}</> }),
};
const MatchTags = ({ filters, setFilters, matched = {} }) => match_keys.filter(key => filters[key]).map(key => {
  const tag = match_tags[key](filters[key], matched, filters);
  return <Tag key={key} large minimal icon={tag.icon} onRemove={() => setFilters({ [key]: '', page: '' })} style={{ maxWidth: 420 }}>{tag.text}</Tag>;
});

// Text filters apply a moment after users stop typing
const useDebounced = (value, onChange, delay = 400) => {
  const [text, setText] = useState(value);
  const [previous, setPrevious] = useState(value);
  if (value !== previous) {
    setPrevious(value);
    setText(value);
  }
  useEffect(() => {
    if (text === value) return;
    const timer = setTimeout(() => onChange(text), delay);
    return () => clearTimeout(timer);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  return [text, setText];
};

const path_segment = project => (project ?? '').split('/').map(encodeURIComponent).join('/');
export const commitUrl = ({ project_id, hexsha, batch_label }, extra = {}) => {
  const params = new URLSearchParams({ ...(batch_label ? { batch: batch_label } : {}), ...extra });
  const query = params.toString();
  return `/${path_segment(project_id)}/commit/${hexsha}${query ? `?${query}` : ''}`;
};
const logsUrl = item => commitUrl(item, { selected_views: 'logs' });

// "for 3h 5min", in orange when it's long
// `icon`: a warning sign before it when it's long
const Since = ({ iso, now, prefix = 'for', icon = false }) => {
  const seconds = secondsSince(iso, now);
  if (seconds === null) return <span className={Classes.TEXT_MUTED}>—</span>;
  const long = seconds > LONG_SECONDS;
  return <Tooltip content={long ? <>Since <Time iso={iso}/>: pending for over a day, its job may have died without telling QA-Board.</> : <Time iso={iso}/>} hoverOpenDelay={200}>
    <span style={{ whiteSpace: 'nowrap', fontWeight: long ? 600 : undefined }}>
      {icon && long && <Icon icon="warning-sign" size={12} intent={Intent.WARNING} style={{ marginRight: 4 }}/>}
      {long ? <StatusText $status="waiting">{prefix} {formatDuration(seconds)}</StatusText> : <>{prefix} {formatDuration(seconds)}</>}
    </span>
  </Tooltip>;
};


// Marks the pending runs of a group (or the runs listed) as failed, after saying how many
const FailDialog = ({ target, filters, is_admin, onClose }) => {
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    failRuns(queryClient, { ...target, filters, dry_run: true }).then(setPreview).catch(e => setError(errorMessage(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = () => {
    setBusy(true);
    failRuns(queryClient, { ...target, filters })
      .then(answer => {
        toaster.show({ message: `${plural(answer.runs, 'run')} marked as failed`, intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 });
        onClose();
      })
      .catch(e => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  const mine = filters.scope === 'me' || !filters.scope;
  return <Dialog isOpen onClose={onClose} title="Mark as failed" icon="cross-circle" style={{ width: 560, maxWidth: 'calc(100vw - 32px)' }}>
    <DialogBody>
      {error && <Callout intent={Intent.DANGER} style={{ marginBottom: 12 }} role="alert">{error}</Callout>}
      <p><strong>{target.label}</strong></p>
      {!preview && !error && <Spinner size={20}/>}
      {preview && (preview.runs === 0
        ? <Callout icon="info-sign">No {mine ? 'run of yours' : 'run'} is waiting or running here.</Callout>
        : <p data-testid="fail-preview">
          <strong>{plural(preview.runs, 'run')}</strong> waiting or running, in {plural(preview.batches, 'batch', 'batches')}
          {Object.keys(preview.projects).length > 1 ? ` of ${plural(Object.keys(preview.projects).length, 'project')}` : ''}, will be marked as failed.
        </p>)}
      <p className={Classes.TEXT_MUTED}>
        Use it for runs whose job died without telling QA-Board, e.g. killed by LSF, or on a machine that rebooted.
        Their jobs aren't stopped: if one still runs, it saves its results when it ends.
        {target.batch_id ? ' To kill the jobs too, stop the batch.' : ''} You can redo them later.
        {!mine && !is_admin ? ' Only your runs change.' : ''}
      </p>
    </DialogBody>
    <DialogFooter actions={<>
      <Button text="Cancel" onClick={onClose}/>
      <Button intent={Intent.DANGER} text={preview?.runs ? `Mark ${plural(preview.runs, 'run')} as failed` : 'Mark as failed'} disabled={!preview?.runs} loading={busy} onClick={submit}/>
    </>}/>
  </Dialog>;
};


const StopBatchAlert = ({ item, onClose }) => {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const stop = () => {
    setBusy(true);
    stopBatch(queryClient, item.batch_id)
      .then(() => {
        toaster.show({ message: `Stopped ${item.batch_label}`, intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 });
        onClose();
      })
      .catch(e => toaster.show({ message: `Could not stop ${item.batch_label}: ${errorMessage(e)}`, intent: Intent.DANGER, icon: 'error' }))
      .finally(() => setBusy(false));
  };
  return <Alert isOpen icon="stop" intent={Intent.DANGER} confirmButtonText="Stop the batch" cancelButtonText="Cancel" loading={busy} onConfirm={stop} onCancel={onClose}>
    <p>Stop <strong>{item.batch_label}</strong> ({item.project_id}, <code>{item.hexsha?.slice(0, 8)}</code>)?</p>
    <p className={Classes.TEXT_MUTED}>Its jobs are killed (LSF, Dask…), and its waiting and running runs fail. Everyone's runs in the batch stop.</p>
  </Alert>;
};


// What a group of runs is, with links to it, and buttons to see only its runs
const GroupTitle = ({ group, item, filters, setFilters }) => {
  const only = filterOnGroup(group, item, filters);
  const extras = <>
    {(item.queues ?? []).map(q => <Tag key={q} minimal round interactive={filters.queue !== q} style={{ marginLeft: 6 }} title={filters.queue !== q ? `Queue ${q}: only its runs` : `Queue ${q}`}
      onClick={filters.queue !== q ? () => setFilters({ queue: q, page: '' }) : undefined}>{q}</Tag>)}
  </>;
  const only_button = only && <OnlyButton label={`Only the runs of ${group_label(group, item)}`} onClick={() => setFilters(only)}/>;
  const project = <FilterOn value={item.project_id} current={filters.project} title={`Only ${item.project_id}`} onFilter={() => setFilters({ project: item.project_id, page: '' })}/>;
  const branch = item.branch
    ? <FilterOn value={item.branch} current={filters.branch} title={`Only the branch ${item.branch}`} onFilter={() => setFilters({ branch: item.branch, page: '' })}/>
    : 'no branch';
  switch (group) {
    case 'batch':
      return <>
        <Link to={commitUrl(item)}><strong>{item.batch_label}</strong></Link>{only_button}{extras}
        <Meta>{project} · {branch} · <Link to={commitUrl({ ...item, batch_label: null })}><code>{item.hexsha?.slice(0, 8)}</code></Link></Meta>
      </>;
    case 'commit':
      return <>
        <Link to={commitUrl({ ...item, batch_label: null })}><code><strong>{item.hexsha?.slice(0, 8)}</strong></code></Link>{only_button}{extras}
        <Meta>{project} · {branch} · {(item.labels ?? []).join(', ')}{item.batches > (item.labels ?? []).length ? '…' : ''}</Meta>
      </>;
    case 'branch':
      return <>
        {item.key ? <strong>{item.key}</strong> : <span className={Classes.TEXT_MUTED}>(no branch)</span>}{only_button}{extras}
        <Meta>{item.nb_projects === 1 ? project : plural(item.nb_projects, 'project')} · {plural(item.commits, 'commit')} · {plural(item.batches, 'batch', 'batches')}</Meta>
      </>;
    case 'project':
      return <>
        <Link to={`/${path_segment(item.key)}`}><strong>{item.key}</strong></Link>
        {filters.project !== item.key && <OnlyButton label={`Only ${item.key}`} onClick={() => setFilters({ project: item.key, page: '' })}/>}
        <Meta>{plural(item.batches, 'batch', 'batches')} of {plural(item.commits, 'commit')}</Meta>
      </>;
    case 'user':
      return <>
        <strong>{item.key || 'unknown'}</strong>
        {filters.user !== item.key && <OnlyButton label={`Only the runs of ${item.key || 'unknown'}`} onClick={() => setFilters({ scope: 'user', user: item.key, page: '' })}/>}
        <Meta>{item.nb_projects === 1 ? project : plural(item.nb_projects, 'project')} · {plural(item.batches, 'batch', 'batches')}</Meta>
      </>;
    case 'command':
      return <>
        {item.key
          ? <Link to={logsUrl(item)}><code className={Classes.MONOSPACE_TEXT} style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{item.command?.argv ?? `qa batch ${item.key.slice(0, 8)}`}</code></Link>
          : <span className={Classes.TEXT_MUTED}>Runs without a qa batch command</span>}
        {only_button}
        <Meta>
          {project} · {item.batch_label}
          {item.command?.user && <> · by {item.command.user}</>}
          {item.command?.created_at && <> · started <Time iso={item.command.created_at}/></>}
          {item.command?.job_url && <> · <a href={item.command.job_url} target="_blank" rel="noopener noreferrer">CI job</a></>}
        </Meta>
      </>;
    case 'status':
      return <span>
        <RunStatus status={item.key}/>
        {filters.status !== item.key && <OnlyButton label={`Only the ${statuses[item.key]?.label.toLowerCase() ?? item.key} runs`} onClick={() => setFilters({ status: item.key, page: '' })}/>}
      </span>;
    default:
      return <>
        {item.key ? <strong>{item.key}</strong> : <span className={Classes.TEXT_MUTED}>(none)</span>}{only_button}
        <Meta>{item.nb_projects === 1 ? project : plural(item.nb_projects, 'project')} · {plural(item.batches, 'batch', 'batches')}</Meta>
      </>;
  }
};

const group_labels = {
  batch: item => `Batch ${item.batch_label}`,
  commit: item => `Commit ${item.hexsha?.slice(0, 8)}`,
  project: item => `Project ${item.key}`,
  user: item => `Runs of ${item.key || 'unknown'}`,
  command: item => `qa batch ${item.command?.argv ?? String(item.key ?? '').slice(0, 8)}`,
};
const group_label = (group, item) => group_labels[group]?.(item) ?? `${groups.find(g => g.id === group)?.label ?? group}: ${item.key || '(none)'}`;


const GroupMenu = ({ group, item, onShowRuns, onFilter, onFail, onStop }) => {
  const active = item.waiting + item.running;
  return <Popover placement="bottom-end" content={<Menu>
    <MenuItem icon="th-list" text="Show the runs" onClick={onShowRuns}/>
    {onFilter && <MenuItem icon="filter" text="Only these runs" title="Filter the whole page on them: the totals, the timeline and the list" onClick={onFilter}/>}
    {(group === 'batch' || group === 'command') && <MenuItem icon="console" text="Open the logs" href={logsUrl(item)} onClick={event => { event.preventDefault(); history.push(logsUrl(item)); }}/>}
    {(group === 'batch' || group === 'commit') && <MenuItem icon="share" text="Open the results" href={commitUrl(group === 'commit' ? { ...item, batch_label: null } : item)}
      onClick={event => { event.preventDefault(); history.push(commitUrl(group === 'commit' ? { ...item, batch_label: null } : item)); }}/>}
    {active > 0 && <>
      <MenuDivider/>
      <MenuItem icon="cross-circle" intent={Intent.DANGER} text="Mark waiting and running runs as failed…" onClick={onFail}/>
      {group === 'batch' && <MenuItem icon="stop" intent={Intent.DANGER} text="Stop the batch…" onClick={onStop}/>}
    </>}
  </Menu>}>
    <Button size="small" variant="minimal" icon="more" aria-label={`Actions: ${group_label(group, item)}`}/>
  </Popover>;
};


const RunWhen = ({ run, now }) => {
  const long = run => (secondsSince(run.started_at ?? run.queued_at ?? run.created_date, now) ?? 0) > LONG_SECONDS;
  const warning = (run.status === 'waiting' || run.status === 'running') && long(run)
    && <Icon icon="warning-sign" size={12} intent={Intent.WARNING} style={{ marginRight: 4 }}/>;
  if (run.status === 'waiting')
    return <span>{warning}Queued <Since iso={run.queued_at ?? run.created_date} now={now} prefix=""/> ago</span>;
  if (run.status === 'running') {
    const waited = run.queued_at && run.started_at ? secondsSince(run.queued_at, now) - secondsSince(run.started_at, now) : null;
    return <span>
      {warning}Running <Since iso={run.started_at ?? run.queued_at ?? run.created_date} now={now}/>
      {waited !== null && waited >= 60 && <Meta>waited {formatDuration(waited)}</Meta>}
    </span>;
  }
  const ran = run.started_at && run.finished_at ? secondsSince(run.started_at, now) - secondsSince(run.finished_at, now) : null;
  if (run.estimated)
    return <Tooltip hoverOpenDelay={200} content={ran !== null
      ? "QA-Board didn't record when this run ended (older runs, or older qa versions): it's when it was created, plus how long it computed."
      : "QA-Board didn't record when this run ended (older runs, or older qa versions), nor how long it computed: this is when it was created."}>
      <span>
        {ran !== null ? <>Ended ~<Time iso={run.finished_at}/></> : <>Created <Time iso={run.created_date}/></>}
        {ran !== null && <Meta>ran {formatDuration(ran)}</Meta>}
      </span>
    </Tooltip>;
  return <span>
    Ended <Time iso={run.finished_at}/>
    {ran !== null && <Meta>ran {formatDuration(ran)}</Meta>}
  </span>;
};

const settings = run => [run.platform, ...(run.configurations ?? []).map(c => typeof c === 'string' ? c : JSON.stringify(c)),
  ...(Object.keys(run.extra_parameters ?? {}).length ? [JSON.stringify(run.extra_parameters)] : [])].filter(Boolean).join(' · ');

// How it was started: its runner and queue (click: only their runs), then its other job options
const JobSummary = ({ run, filters, setFilters }) => {
  const options = run.job_options ?? {};
  const others = Object.entries(options).filter(([k]) => !['type', 'queue'].includes(k)).slice(0, 3).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  const parts = [
    options.type && <FilterOn key="runner" value={String(options.type)} current={filters.runner} title={`Only the runs started with ${options.type}`} onFilter={() => setFilters({ runner: String(options.type), page: '' })}/>,
    options.queue && <span key="queue">queue <FilterOn value={String(options.queue)} current={filters.queue} title={`Only the runs of the queue ${options.queue}`} onFilter={() => setFilters({ queue: String(options.queue), page: '' })}/></span>,
    ...others.map(text => <span key={text}>{text}</span>),
  ].filter(Boolean);
  if (!parts.length) return <span className={Classes.TEXT_MUTED}>—</span>;
  return parts.map((part, i) => <span key={i}>{i > 0 && ' · '}{part}</span>);
};


// The runs of a group, or all of them
// Nothing to show: maybe other people's runs
const Empty = ({ title, description, filters, setFilters }) => {
  const narrowed = setFilters && narrowing_keys.some(key => filters[key]);
  const mine = setFilters && (!filters.scope || filters.scope === 'me');
  return <NonIdealState icon="search" title={title} description={description}
    action={narrowed || mine ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
      {narrowed && <Button icon="filter-remove" text="Clear the filters" onClick={() => setFilters(clearedFilters)}/>}
      {mine && <Button icon="people" text="See everyone's runs" onClick={() => setFilters({ scope: 'all', page: '' })}/>}
    </div> : undefined}/>;
};

// `setFilters`: clicking a project, a user, a queue... filters the page on it
const RunsTable = ({ filters, setFilters, group, item_key, now, live, show_batch = true, show_users: users_column = true, onFail }) => {
  const [page, setPage] = useState(1);
  const offset = (page - 1) * runs_page_size;
  const { data, isPending, error, refetch, isPlaceholderData } = useQuery(runsQuery(filters, { group, key: item_key, offset, live }));
  if (isPending) return <Loading label="Loading the runs"/>;
  if (error) return <QueryError error={error} refetch={refetch} what="the runs"/>;
  if (!data.runs.length) return <Empty title="No runs" description="No run matches the filters." filters={filters} setFilters={group ? null : setFilters}/>;
  const show_users = filters.scope === 'all' && users_column;
  const only = (title, changes) => ({ title, onFilter: () => setFilters({ ...changes, page: '' }) });
  const pages = Math.max(1, Math.ceil(data.total / runs_page_size));
  // dimmed while the runs of other filters load, not when they refresh
  return <Rows style={{ opacity: isPlaceholderData ? 0.6 : 1 }}>
    <div style={{ overflowX: 'auto' }}>
      <HTMLTable compact style={{ width: '100%' }} aria-label="Runs">
        <thead><tr><th>Status</th><th>Input</th>{show_batch && <th>Batch</th>}{show_users && <th>By</th>}<th>Job</th><th>When</th><th aria-label="Actions"/></tr></thead>
        <tbody>
          {data.runs.map(run => {
            const results = commitUrl(run, { filter: run.input_path ?? '' });
            return <tr key={run.id} data-testid="run">
              <td>
                <RunStatus status={run.status}/>
                {run.failed_reason && <Tooltip content={run.failed_reason}><Icon icon="info-sign" size={12} className={Classes.TEXT_MUTED} style={{ marginLeft: 4 }} aria-label={run.failed_reason}/></Tooltip>}
              </td>
              <td style={{ minWidth: 200 }}>
                <Link to={results} title={`${run.input_database ?? ''}/${run.input_path ?? ''}`}><code style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{run.input_path}</code></Link>
                <Meta>{settings(run)}</Meta>
              </td>
              {show_batch && <td style={{ minWidth: 140 }}>
                <Link to={commitUrl(run)}>{run.batch_label}</Link>
                {String(filters.batch) !== String(run.batch_id) && <OnlyButton label={`Only the runs of the batch ${run.batch_label}`} onClick={() => setFilters({ batch: String(run.batch_id), page: '' })}/>}
                <Meta>
                  <FilterOn value={run.project_id} current={filters.project} {...only(`Only ${run.project_id}`, { project: run.project_id })}/>
                  {' · '}<code>{run.hexsha?.slice(0, 8)}</code>
                </Meta>
              </td>}
              {show_users && <td><FilterOn value={run.user_name} {...only(`Only the runs of ${run.user_name}`, { scope: 'user', user: run.user_name })}>{run.user_name || <span className={Classes.TEXT_MUTED}>unknown</span>}</FilterOn></td>}
              <td style={{ fontSize: 12, overflowWrap: 'anywhere', maxWidth: 220 }}><JobSummary run={run} filters={filters} setFilters={setFilters}/></td>
              <td style={{ minWidth: 130 }}><RunWhen run={run} now={now}/></td>
              <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                {run.output_dir_url && <Tooltip content="Its log: what it printed" hoverOpenDelay={300}>
                  <a className={`${Classes.BUTTON} ${Classes.SMALL} ${Classes.MINIMAL}`} href={`${run.output_dir_url}/log.txt`} target="_blank" rel="noopener noreferrer" aria-label="Its log">
                    <Icon icon="console"/>
                  </a>
                </Tooltip>}
                {run.output_dir_url && <Tooltip content="Its files" hoverOpenDelay={300}>
                  <a className={`${Classes.BUTTON} ${Classes.SMALL} ${Classes.MINIMAL}`} href={run.output_dir_url} target="_blank" rel="noopener noreferrer" aria-label="Its files">
                    <Icon icon="folder-open"/>
                  </a>
                </Tooltip>}
                {(run.status === 'waiting' || run.status === 'running') && onFail && <Tooltip content="Mark as failed…" hoverOpenDelay={300}>
                  <Button size="small" variant="minimal" icon="cross-circle" aria-label="Mark this run as failed" onClick={() => onFail({ ids: [run.id], label: `The run of ${run.input_path}` })}/>
                </Tooltip>}
              </td>
            </tr>;
          })}
        </tbody>
      </HTMLTable>
    </div>
    {data.total > data.runs.length && <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
      <span className={Classes.TEXT_MUTED}>{formatNumber(offset + 1)}–{formatNumber(offset + data.runs.length)} of {formatNumber(data.total)}</span>
      <Button size="small" icon="chevron-left" text="Previous" disabled={page <= 1} onClick={() => setPage(page - 1)}/>
      <Button size="small" endIcon="chevron-right" text="Next" disabled={page >= pages} onClick={() => setPage(page + 1)}/>
    </div>}
  </Rows>;
};


const GroupsTable = ({ group, filters, setFilters, now, live, onFail, onStop }) => {
  const sort = filters.sort || 'active';
  const offset = Math.max(0, (parseInt(filters.page || '1', 10) - 1) * items_page_size);
  const [open, setOpen] = useState(() => new Set());
  const { data, isPending, error, refetch, isPlaceholderData } = useQuery({
    ...itemsQuery(group, filters, { sort, offset, live }),
    enabled: group !== 'option' || !!filters.option,
  });
  if (group === 'option' && !filters.option) return <NonIdealState icon="properties" title="Which job option?" description="Type the name of a job option above, e.g. project or memory for LSF."/>;
  if (isPending) return <Loading label="Loading the runs"/>;
  if (error) return <QueryError error={error} refetch={refetch} what="the runs"/>;
  const items = data.items;
  if (items.length === 0)
    return <Empty title="Nothing here" filters={filters} setFilters={setFilters}
      description={narrowing_keys.some(key => filters[key]) ? "No run matches the filters." : `No ${!filters.scope || filters.scope === 'me' ? 'run of yours' : 'run'} waits or runs now, and none ended in this time window.`}/>;
  const toggle = key => setOpen(current => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const show_users = filters.scope === 'all' && group !== 'user';
  // what "Only these runs" filters on
  const only_filter = item => group === 'project' ? (filters.project !== item.key ? { project: item.key, page: '' } : null)
    : group === 'user' ? (filters.user !== item.key ? { scope: 'user', user: item.key, page: '' } : null)
    : group === 'status' ? (filters.status !== item.key ? { status: item.key, page: '' } : null)
    : filterOnGroup(group, item, filters);
  const pages = Math.max(1, Math.ceil(data.total / items_page_size));
  const page = Math.floor(offset / items_page_size) + 1;
  const columns = 5 + (show_users ? 1 : 0);
  return <>
    <Rows style={{ overflowX: 'auto', opacity: isPlaceholderData ? 0.6 : 1 }}>
      <HTMLTable compact style={{ width: '100%' }} aria-label={groups.find(g => g.id === group)?.label ?? group}>
        <thead>
          <tr>
            <th style={{ width: 30 }} aria-label="Expand"/>
            <th>{groups.find(g => g.id === group)?.label.replace('…', '')}</th>
            <th>Runs</th>
            <th>Since</th>
            {show_users && <th>Run by</th>}
            <th aria-label="Actions"/>
          </tr>
        </thead>
        <tbody>
          {items.map(item => {
            const key = JSON.stringify(item.key);
            const expanded = open.has(key);
            const active = item.waiting + item.running;
            return [
              <tr key={key} data-testid="activity-item">
                <td><Button size="small" variant="minimal" icon={expanded ? 'chevron-down' : 'chevron-right'} aria-expanded={expanded}
                  aria-label={`${expanded ? 'Hide' : 'Show'} the runs: ${group_label(group, item)}`} onClick={() => toggle(key)}/></td>
                <td style={{ minWidth: 220 }}><GroupTitle group={group} item={item} filters={filters} setFilters={setFilters}/></td>
                <td><StatusBar counts={item}/></td>
                <td style={{ minWidth: 120 }}>
                  {active > 0 ? <Since iso={item.active_since} now={now} prefix="pending for" icon/> : <span>last ended <Time iso={item.latest}/></span>}
                  {(item.wait_seconds !== null || item.run_seconds !== null) && <Meta>
                    {[item.wait_seconds >= 60 && `waits ${formatDuration(item.wait_seconds)}`, item.run_seconds !== null && `runs ${formatDuration(item.run_seconds)}`].filter(Boolean).join(', ')}
                    {(item.wait_seconds >= 60 || item.run_seconds !== null) && ' on average'}
                  </Meta>}
                </td>
                {show_users && <td style={{ fontSize: 12 }}>
                  {(item.users ?? []).map((u, i) => <span key={u}>{i > 0 && ', '}<FilterOn value={u} title={`Only the runs of ${u}`} onFilter={() => setFilters({ scope: 'user', user: u, page: '' })}>{u || 'unknown'}</FilterOn></span>)}
                  {item.nb_users > (item.users ?? []).length && <span className={Classes.TEXT_MUTED}> +{item.nb_users - item.users.length}</span>}
                </td>}
                <td style={{ textAlign: 'right' }}>
                  <GroupMenu group={group} item={item} onShowRuns={() => toggle(key)}
                    onFilter={only_filter(item) ? () => setFilters(only_filter(item)) : null}
                    onFail={() => onFail({ group, key: item.key, label: group_label(group, item), batch_id: group === 'batch' ? item.batch_id : null })}
                    onStop={() => onStop(item)}/>
                </td>
              </tr>,
              expanded && <tr key={`${key}-runs`} className="expanded-runs">
                <td aria-hidden/>
                <td colSpan={columns} style={{ background: 'var(--qa-bg-subtle, rgba(143, 153, 168, 0.08))', borderLeft: `3px solid ${statuses.running.color}`, paddingTop: 8, paddingBottom: 8 }}>
                  <RunsTable filters={filters} setFilters={setFilters} group={group} item_key={item.key} now={now} live={live} show_batch={group !== 'batch'} show_users={group !== 'user'} onFail={onFail}/>
                </td>
              </tr>,
            ];
          })}
        </tbody>
      </HTMLTable>
    </Rows>
    {data.total > items.length && <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
      <span className={Classes.TEXT_MUTED}>{formatNumber(offset + 1)}–{formatNumber(offset + items.length)} of {formatNumber(data.total)}</span>
      <Button icon="chevron-left" text="Previous" disabled={page <= 1} onClick={() => setFilters({ page: String(page - 1) })}/>
      <Button endIcon="chevron-right" text="Next" disabled={page >= pages} onClick={() => setFilters({ page: String(page + 1) })}/>
    </div>}
  </>;
};


// A batch started from QA-Board whose `qa batch` didn't start: we read its logs to know where it is
const submission_states = {
  queued: { label: 'Queued', icon: 'time', intent: Intent.WARNING },
  running: { label: 'Starting', intent: Intent.PRIMARY },
  done: { label: 'Started', icon: 'tick', intent: Intent.SUCCESS },
  failed: { label: 'Failed to start', icon: 'cross', intent: Intent.DANGER },
};
const SoonRow = ({ submission, show_users }) => {
  const status = useSubmissionStatus(submission);
  const state = submission_states[status.state] ?? submission_states.queued;
  return <tr data-testid="starting-soon">
    <td><Tag minimal intent={state.intent} icon={status.state === 'running' ? <Spinner size={12}/> : state.icon}>{state.label}</Tag></td>
    <td>
      <Link to={commitUrl(submission)}><strong>{submission.batch_label}</strong></Link>
      {submission.batch && submission.batch !== submission.batch_label && <span className={Classes.TEXT_MUTED}> ({submission.batch})</span>}
      <Meta>{submission.project_id} · {submission.branch || 'no branch'} · <code>{submission.hexsha?.slice(0, 8)}</code></Meta>
    </td>
    {show_users && <td>{submission.user}</td>}
    <td style={{ fontSize: 12 }}>
      {submission.runner}{whereItRuns(submission) ? ` · ${whereItRuns(submission)}` : ''}
      {/* why it waits, if its runner said (the server sends it until qa batch writes logs): e.g. its pod is pending */}
      {submission.pending_note && <Meta style={{ whiteSpace: 'pre-line' }}>{submission.pending_note}</Meta>}
    </td>
    <td>Submitted <Time iso={submission.created_at}/></td>
    <td style={{ textAlign: 'right' }}><Link to={logsUrl(submission)} className={`${Classes.BUTTON} ${Classes.SMALL} ${Classes.MINIMAL}`}><Icon icon="console"/><span className={Classes.BUTTON_TEXT}>Logs</span></Link></td>
  </tr>;
};

const StartingSoon = ({ submissions, show_users }) => {
  if (!submissions?.length) return null;
  return <section aria-label="Starting soon" style={{ marginBottom: 20 }}>
    <h4 className={Classes.HEADING}>
      Starting soon <Tooltip content="Batches started from QA-Board whose qa batch didn't start yet, e.g. its LSF job is queued. Their runs show up below once it starts." hoverOpenDelay={200}>
        <Icon icon="help" size={14} className={Classes.TEXT_MUTED}/>
      </Tooltip>
    </h4>
    <div style={{ overflowX: 'auto' }}>
      <HTMLTable compact style={{ width: '100%' }} aria-label="Batches starting soon">
        <thead><tr><th>Status</th><th>Batch</th>{show_users && <th>By</th>}<th>Job</th><th>Submitted</th><th aria-label="Logs"/></tr></thead>
        <tbody>{submissions.map(s => <SoonRow key={s.id} submission={s} show_users={show_users}/>)}</tbody>
      </HTMLTable>
    </div>
  </section>;
};


// Runs pending for over a week: their job died. Admins clean them up, now or on a schedule.
const Stuck = ({ overview, filters, setFilters }) => {
  const [starting, setStarting] = useState(null);
  const stuck = overview.stuck;
  if (!stuck?.runs) return null;
  const schedule = stuck.schedule;
  const projects = filters.project || '*';
  return <Callout intent={Intent.WARNING} icon="outdated" title={`${plural(stuck.runs, 'run')} pending for over a week`} style={{ marginBottom: 16 }} data-testid="stuck">
    <p style={{ marginBottom: 8 }}>
      Their job probably died without telling QA-Board (killed by LSF, a machine that rebooted…). They count as waiting or running until they're marked as failed.
      {overview.is_admin
        ? schedule ? <> The schedule <strong>{schedule.name}</strong> marks them as failed {schedule.when}{schedule.dry_run ? ' (dry run)' : ''}.</> : ' No schedule marks them as failed.'
        : ' Mark yours as failed from their menu, or ask an admin to set up a schedule.'}
    </p>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <Button icon="sort-asc" text="Show them" onClick={() => setFilters({ status: 'long', sort: 'oldest', page: '' })}/>
      {overview.is_admin && <Button icon="cross-circle" text="Mark them as failed…" onClick={() => setStarting('now')}/>}
      {overview.is_admin && !schedule && <Button icon="time" text="Do it every night…" onClick={() => setStarting('schedule')}/>}
    </div>
    {starting === 'now' && <JobDialog kind="fail_stuck_runs" initial={{ projects: [projects], older_than: '1week' }} title="Mark stuck runs as failed" isOpen onClose={() => setStarting(null)}/>}
    {starting === 'schedule' && <ScheduleDialog isOpen onClose={() => setStarting(null)}
      schedule={{ name: 'Fail stuck runs', kind: 'fail_stuck_runs', cron: '0 3 * * *', params: { projects: ['*'], older_than: '1week', dry_run: false } }}/>}
  </Callout>;
};


// The groups with the most runs pending: who and what loads the cluster. Clicking one shows only its runs.
const BusiestRows = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  column-gap: 12px;
  row-gap: 2px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  .number { text-align: right; white-space: nowrap; }
  .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
`;
const Busiest = ({ title, rows, onSelect, label = key => key || '(none)' }) => {
  const busy = (rows ?? []).filter(r => r.waiting + r.running > 0);
  if (!busy.length) return null;
  return <Card compact style={{ minWidth: 0 }}>
    <BusiestRows>
      <span className={Classes.TEXT_MUTED} style={{ marginBottom: 4 }}>{title}</span>
      <span className={`number ${Classes.TEXT_MUTED}`} style={{ fontSize: 12 }}>running</span>
      <span className={`number ${Classes.TEXT_MUTED}`} style={{ fontSize: 12 }}>waiting</span>
      {busy.slice(0, 5).map(r => [
        // long names, e.g. projects' paths: their end matters most
        <span key={`${r.key}-name`} className="name" title={label(r.key)}>
          &lrm;{onSelect
            ? <FilterText type="button" style={{ color: 'var(--qa-link)' }} title={`Only ${label(r.key)}`} onClick={() => onSelect(r.key)}>{label(r.key)}</FilterText>
            : label(r.key)}&lrm;
        </span>,
        <span key={`${r.key}-running`} className="number">{r.running > 0 ? <StatusText $status="running">{formatNumber(r.running)}</StatusText> : <span className={Classes.TEXT_MUTED}>–</span>}</span>,
        <span key={`${r.key}-waiting`} className="number">{r.waiting > 0 ? <StatusText $status="waiting">{formatNumber(r.waiting)}</StatusText> : <span className={Classes.TEXT_MUTED}>–</span>}</span>,
      ])}
    </BusiestRows>
    {busy.length > 5 && <div className={Classes.TEXT_MUTED} style={{ fontSize: 12, marginTop: 4 }}>+{busy.length - 5} more</div>}
  </Card>;
};


const Help = () => <Popover content={<div style={{ padding: 14, maxWidth: 420 }}>
  <p><strong>What runs, and what ran.</strong> QA-Board knows a run when <code>qa batch</code> queues it, when <code>qa run</code> starts, and when it ends.</p>
  <ul style={{ paddingLeft: 18, margin: '0 0 8px 0' }}>
    <li><strong>Starting soon</strong>: batches you started from QA-Board, whose <code>qa batch</code> waits for the cluster.</li>
    {Object.entries(statuses).map(([id, s]) => <li key={id}><strong>{s.label}</strong>: {s.description}</li>)}
  </ul>
  <p style={{ margin: 0 }} className={Classes.TEXT_MUTED}>Older runs, from before QA-Board recorded when runs end, show when they were created instead. Runs pending for over a day are flagged: their job may have died. The page refreshes every 15 seconds.</p>
</div>}>
  <Button icon="help" variant="minimal" text="What do these mean?"/>
</Popover>;


// While the overview loads: its cards and chart at their size, so that the page doesn't jump when they arrive
const OverviewSkeleton = () => <div aria-busy="true" aria-label="Loading what runs">
  <Summary>
    {[0, 1, 2, 3, 4].map(i => <Card compact key={i}>
      <div className={`value ${Classes.SKELETON}`} style={{ width: '40%' }}>0</div>
      <div className={Classes.SKELETON} style={{ marginTop: 4, width: '70%' }}>runs</div>
    </Card>)}
  </Summary>
  <Card compact style={{ marginBottom: 16 }}>
    <div className={Classes.SKELETON} style={{ width: 220, marginBottom: 8 }}>Runs</div>
    <div className={Classes.SKELETON} style={{ height: 175 }}/>
  </Card>
</div>;

// What filters the runs, besides whose and the time window: to say why nothing matches, and clear them
const narrowing_keys = ['project', 'status', 'search', ...match_keys];
const clearedFilters = Object.fromEntries([...narrowing_keys, 'page'].map(key => [key, '']));

export const Activity = ({ filters }) => {
  const [live, setLive] = useState(true);
  const [failing, setFailing] = useState(null);
  const [stopping, setStopping] = useState(null);
  const setFilters = changes => history.replace(activityUrl({ ...filters, ...changes }));
  const [search, setSearch] = useDebounced(filters.search, search => setFilters({ search, page: '' }));
  const [option, setOption] = useDebounced(filters.option, option => setFilters({ option, page: '' }));
  const { data: overview, isPending, error, refetch, dataUpdatedAt } = useQuery(overviewQuery(filters, { live }));
  const nothing = overview && overview.starting_soon.length === 0 && ['waiting', 'running', 'done', 'failed'].every(s => !overview.totals[s]);
  const narrowed = narrowing_keys.some(key => filters[key] && key !== 'status');
  const scope = filters.scope || 'me';
  const group = filters.group || 'batch';
  const totals = overview?.totals;
  const window_label = windows.find(w => w.value === (filters.window || '24h'))?.label.toLowerCase();
  const card = (status, value, label, extra) => <Card compact interactive onClick={() => setFilters({ status: filters.status === status ? '' : status, page: '' })}
    selected={filters.status === status} data-testid={`total-${status}`} aria-label={`${label}: show them`}>
    <div className="value"><StatusText $status={value ? status === 'ended' ? 'done' : status : undefined}>{formatNumber(value)}</StatusText></div>
    <div className={Classes.TEXT_MUTED}>{label}</div>
    {extra}
  </Card>;

  return <>
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 16 }}>
      <WhoseRuns scope={scope} user={filters.user} onChange={({ scope, user }) => setFilters({ scope, user, page: '' })}/>
      {filters.project && <Tag large minimal icon="projects" onRemove={() => setFilters({ project: '', page: '' })}>{filters.project}</Tag>}
      <MatchTags filters={filters} setFilters={setFilters} matched={overview?.matched}/>
      <HTMLSelect aria-label="Time window" options={windows} value={filters.window || '24h'} onChange={e => setFilters({ window: e.target.value === '24h' ? '' : e.target.value, page: '' })}/>
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {dataUpdatedAt > 0 && <span className={Classes.TEXT_MUTED}>Updated <Time iso={new Date(dataUpdatedAt).toISOString()}/></span>}
        <Switch checked={live} onChange={() => setLive(!live)} label="Live" style={{ margin: 0 }} title="Refresh every 15 seconds"/>
        <Help/>
      </span>
    </div>

    {isPending && <OverviewSkeleton/>}
    {error && <QueryError error={error} refetch={refetch} what="what runs"/>}
    {nothing && <div data-testid="no-runs" style={{ margin: '24px 0 32px' }}><NonIdealState icon="pulse"
      title={narrowed ? 'No runs match the filters' : `No runs in the ${window_label}`}
      description={narrowed
        ? `Nothing waits or runs now, and nothing ended in the ${window_label}, with these filters.`
        : `${scope === 'me' ? 'None of your runs are' : scope === 'user' ? `None of ${filters.user}'s runs are` : 'No runs are'} waiting or running, and none ended in the ${window_label}. Runs show up here once qa batch queues them.`}
      action={<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        {narrowed && <Button icon="filter-remove" text="Clear the filters" onClick={() => setFilters(clearedFilters)}/>}
        {(filters.window || '24h') !== '7d' && <Button icon="time" text="Last 7 days" onClick={() => setFilters({ window: '7d', page: '' })}/>}
        {scope !== 'all' && <Button icon="people" text="See everyone's runs" onClick={() => setFilters({ scope: 'all', user: '', page: '' })}/>}
      </div>}/></div>}
    {overview && !nothing && <>
      <Summary>
        <Card compact data-testid="total-soon">
          <div className="value">{formatNumber(overview.starting_soon.length)}</div>
          <div className={Classes.TEXT_MUTED}>{overview.starting_soon.length === 1 ? 'batch starts' : 'batches start'} soon</div>
        </Card>
        {card('waiting', totals.waiting, 'runs waiting')}
        {card('running', totals.running, 'runs running')}
        {totals.long_active > 0 && <Card compact interactive selected={filters.status === 'long'} data-testid="total-long"
          title="Waiting or running for over a day: their job may have died. Show them, the oldest first."
          onClick={() => setFilters(filters.status === 'long' ? { status: '', page: '' } : { status: 'long', sort: 'oldest', page: '' })}>
          <div className="value"><StatusText $status="waiting">{formatNumber(totals.long_active)}</StatusText></div>
          <div className={Classes.TEXT_MUTED}><Icon icon="warning-sign" size={12} intent={Intent.WARNING} style={{ marginRight: 4 }}/>pending for over a day</div>
        </Card>}
        {card('ended', totals.done + totals.failed, `ended, ${window_label}`)}
        {card('failed', totals.failed, `failed, ${window_label}`)}
      </Summary>

      <Stuck overview={overview} filters={filters} setFilters={setFilters}/>

      <Card compact style={{ marginBottom: 16 }}>
        <div className={Classes.TEXT_MUTED} style={{ marginBottom: 8 }}>Runs pending and ended, {window_label}</div>
        <Timeline timeline={overview.timeline}/>
      </Card>

      {(overview.projects?.length > 0 || overview.users?.length > 0) && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginBottom: 16 }}>
        <Busiest title="Busiest projects" rows={overview.projects} onSelect={project => setFilters({ project, page: '' })}/>
        {scope === 'all' && <Busiest title="Busiest users" rows={overview.users} label={key => key || 'unknown'} onSelect={user => setFilters({ scope: 'user', user, page: '' })}/>}
        <Busiest title="Busiest queues" rows={overview.queues?.filter(q => q.key)} onSelect={queue => setFilters({ queue, page: '' })}/>
      </div>}

      <StartingSoon submissions={overview.starting_soon} show_users={scope !== 'me'}/>
    </>}

    {!nothing && <section aria-label="Runs">
      <Toolbar>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>Group by</span>
          <HTMLSelect aria-label="Group by" options={groups.map(g => ({ value: g.id, label: g.label }))} value={group}
            onChange={e => setFilters({ group: e.target.value === 'batch' ? '' : e.target.value, page: '' })}/>
        </label>
        {group === 'option' && <InputGroup leftIcon="properties" placeholder="Job option, e.g. project" aria-label="Job option" value={option}
          onChange={e => setOption(e.target.value)} list="activity-job-options" style={{ width: 200 }}/>}
        <datalist id="activity-job-options">{common_options.map(o => <option key={o} value={o}>{o}</option>)}</datalist>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>Status</span>
          <HTMLSelect aria-label="Status" options={status_options} value={filters.status} onChange={e => setFilters({ status: e.target.value, page: '' })}/>
        </label>
        <InputGroup leftIcon="search" placeholder="Search…" title="Search projects, branches, batches, commits, users" aria-label="Search" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 240 }}/>
        {group !== 'runs'
          ? <HTMLSelect aria-label="Sort" options={sort_options} value={filters.sort || 'active'} onChange={e => setFilters({ sort: e.target.value, page: '' })}/>
          : <HTMLSelect aria-label="Sort" options={run_sort_options} value={filters.sort === 'oldest' ? 'oldest' : ''} onChange={e => setFilters({ sort: e.target.value, page: '' })}/>}
      </Toolbar>
      {group === 'runs'
        ? <RunsTable filters={filters} setFilters={setFilters} now={overview?.now} live={live} onFail={setFailing}/>
        : <GroupsTable group={group} filters={filters} setFilters={setFilters} now={overview?.now} live={live} onFail={setFailing} onStop={setStopping}/>}
    </section>}

    {failing && <FailDialog target={failing} filters={filters} is_admin={overview?.is_admin} onClose={() => setFailing(null)}/>}
    {stopping && <StopBatchAlert item={stopping} onClose={() => setStopping(null)}/>}
  </>;
};


export const ActivityPage = () => {
  const location = useLocation();
  const filters = readFilters(location.search);
  return <PageShell title="Runs activity" wide>
    <RequireLogin what="see what runs">
      {() => <Activity filters={filters}/>}
    </RequireLogin>
  </PageShell>;
};

export default ActivityPage;
