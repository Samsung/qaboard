// Admin → Storage: what a job does (the projects, the dates...), to start it now or on a schedule.
// The server checks everything again: its errors are shown at the top of the form.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, Callout, Classes, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect, InputGroup, Intent, Radio, RadioGroup,
  Switch, Tag,
} from "@blueprintjs/core";

import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { history } from "../router";
import { parseDate } from "../settings/format";
import { DateTime } from "luxon";
import { startJob, saveSchedule, estimateJob, matchingProjectsQuery, nextRunsQuery } from "./api";
import { kind_labels, number } from "./jobs";


// "a*, b" => ["a*", "b"]
export const splitPatterns = text => (text ?? '').split(/[\n,]/).map(p => p.trim()).filter(Boolean);
const joinPatterns = list => (list ?? []).join(', ');

const defaults = {
  hard_delete: { projects: '*', exclude_projects: '', runs: 'deleted', created_before: '1month', created_after: '', dry_run: true },
  delete_artifacts: { projects: '*', exclude_projects: '', older_than: '1month', keep: '', can_delete_reference_branch: false, dry_run: true },
  garbage_collect: {
    projects: '*', exclude_projects: '', default_older_than: '1month', older_than: '',
    can_delete_reference_branch: false, delete_outputs: true, delete_artifacts: false, dry_run: true,
  },
  scan_storage: { projects: '*', exclude_projects: '', roots: '', min_size_mb: '50', threads: '8' },
  measure_deleted: { projects: '*', exclude_projects: '' },
  fail_stuck_runs: { projects: '*', exclude_projects: '', older_than: '1week', only_running: false, dry_run: true },
};

// The server's params => the form
export const fromParams = (kind, params = {}) => {
  const form = { ...defaults[kind] };
  for (const [key, value] of Object.entries(params ?? {})) {
    if (!(key in form)) continue;
    form[key] = Array.isArray(value) ? joinPatterns(value) : value ?? '';
  }
  return form;
};

// The form => the server's params
export const toParams = (kind, form) => {
  const params = {};
  for (const key of Object.keys(defaults[kind])) {
    const value = form[key];
    if (key === 'projects' || key === 'exclude_projects' || key === 'keep' || key === 'roots') params[key] = splitPatterns(value);
    else if (key === 'min_size_mb' || key === 'threads') params[key] = Number(value);
    else if (typeof value === 'boolean') params[key] = value;
    else if (typeof value === 'string' && value.trim()) params[key] = value.trim();
  }
  return params;
};

// "2026-01-31" or "3months", "2 weeks"...
const date_or_duration = /^(\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?|((\d+(\.\d+)?) *(y(ears?)?|m(onths?)?|w(eeks?)?|d(ays?)?|h(ours?)?|min(utes?)?|s(econds?)?) *)+)$/;
const duration = /^((\d+(\.\d+)?) *(y(ears?)?|m(onths?)?|w(eeks?)?|d(ays?)?|h(ours?)?|min(utes?)?|s(econds?)?) *)+$/;

// => {field: "a sentence"}
export const validateParams = (kind, form) => {
  const errors = {};
  if (splitPatterns(form.projects).length === 0 && !(kind === 'scan_storage' && splitPatterns(form.roots).length)) errors.projects = "Which projects? * for all of them.";
  if (kind === 'scan_storage') {
    if (splitPatterns(form.roots).some(root => !root.startsWith('/'))) errors.roots = "Absolute paths, e.g. /algo/project/outputs";
    if (!(Number(form.min_size_mb) >= 0)) errors.min_size_mb = "A number of MB, e.g. 50";
    if (!(Number.isInteger(Number(form.threads)) && Number(form.threads) >= 1 && Number(form.threads) <= 64)) errors.threads = "Between 1 and 64";
  }
  for (const key of ['created_before', 'created_after']) {
    if (kind === 'hard_delete' && form[key]?.trim() && !date_or_duration.test(form[key].trim()))
      errors[key] = "A date like 2026-01-31, or a duration like 3months or 2weeks.";
  }
  for (const key of ['older_than', 'default_older_than']) {
    if (kind !== 'hard_delete' && form[key]?.trim() && !duration.test(form[key].trim()))
      errors[key] = "A duration like 1month, 2weeks or 1year.";
  }
  if (kind === 'delete_artifacts' && !form.older_than?.trim()) errors.older_than = "How long since the commit's latest run, e.g. 1month.";
  if (kind === 'fail_stuck_runs' && !form.older_than?.trim()) errors.older_than = "How long they've been pending, e.g. 1week.";
  if (kind === 'garbage_collect' && form.older_than?.trim() && splitPatterns(form.projects).join() === '*')
    errors.older_than = "It overrides what every project asks in qaboard.yaml: choose projects, or use the default below.";
  return errors;
};

// Patterns are applied a moment after admins stop typing
const useDebounced = (value, delay = 400) => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
};

const MatchingProjects = ({ projects, exclude_projects }) => {
  const patterns = useDebounced({ projects: splitPatterns(projects).join(','), exclude_projects: splitPatterns(exclude_projects).join(',') });
  const { data, isPending, error } = useQuery({ ...matchingProjectsQuery(patterns), enabled: !!patterns.projects });
  const [open, setOpen] = useState(false);
  if (!patterns.projects || isPending) return null;
  if (error) return <span className={Classes.TEXT_MUTED}>{errorMessage(error)}</span>;
  const shown = data?.projects ?? [];
  return <span>
    <Tag minimal intent={data?.total ? Intent.PRIMARY : Intent.WARNING} round>{number(data?.total)} project{data?.total === 1 ? '' : 's'}</Tag>
    {data?.total > 0 && <Button variant="minimal" size="small" text={open ? 'Hide' : 'Show'} onClick={() => setOpen(!open)}/>}
    {open && <div className={Classes.TEXT_MUTED} style={{ fontSize: 12, maxHeight: 120, overflowY: 'auto', marginTop: 4, overflowWrap: 'anywhere' }}>
      {shown.join(', ')}{data.total > shown.length ? `, and ${number(data.total - shown.length)} more` : ''}
    </div>}
  </span>;
};

// How many deleted runs match, before the milestones are excluded. Counting can be too slow on big databases.
const Estimate = ({ kind, form }) => {
  const [state, setState] = useState(null);
  if (kind !== 'hard_delete') return null;
  const estimate = () => {
    setState({ busy: true });
    estimateJob(kind, toParams(kind, form))
      .then(answer => setState({ answer }))
      .catch(error => setState({ error: errorMessage(error) }));
  };
  const answer = state?.answer;
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
    <Button icon="calculator" text={form.runs === 'deleted' ? 'Count the deleted runs' : 'Count the runs to check'} onClick={estimate} loading={state?.busy}/>
    {answer && !answer.timeout && <span>
      <strong>{number(answer.total)}</strong> {form.runs === 'deleted' ? 'deleted runs match' : 'runs to check'}, before excluding the milestones
      {Object.keys(answer.projects ?? {}).length > 1 && <span className={Classes.TEXT_MUTED}>{' '}(most in {Object.entries(answer.projects).slice(0, 3).map(([project, count]) => `${project}: ${number(count)}`).join(', ')})</span>}
    </span>}
    {answer?.timeout && <span className={Classes.TEXT_MUTED}>Too many to count quickly: start a dry run instead.</span>}
    {state?.error && <span className={Classes.INTENT_DANGER}>{state.error}</span>}
  </div>;
};


const run_options = [
  { value: 'deleted', label: 'Deleted by users', description: "Their files were deleted, their metadata was kept. What's left of their files is deleted too." },
  { value: 'missing_files', label: 'Whose files are gone', description: "Deleted or not, their folder was deleted, e.g. by a quota script. No file is deleted: only their metadata." },
  { value: 'both', label: 'Both' },
];

// The fields of a job's parameters
export const JobParamsFields = ({ kind, form, set, errors, id_prefix = 'job' }) => {
  const group = (key, helper) => ({
    labelFor: `${id_prefix}-${key}`,
    intent: errors[key] ? Intent.DANGER : undefined,
    helperText: errors[key] ?? helper,
  });
  const text = key => ({
    id: `${id_prefix}-${key}`,
    value: form[key] ?? '',
    onChange: e => set({ [key]: e.target.value }),
    intent: errors[key] ? Intent.DANGER : undefined,
    spellCheck: false,
  });
  return <>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', columnGap: 16 }}>
      <FormGroup label="Projects" {...group('projects', <>Patterns, comma-separated: <code>*</code> matches anything, e.g. <code>group/repo*</code> is a project and its subprojects.</>)}>
        <InputGroup {...text('projects')} className={Classes.MONOSPACE_TEXT} placeholder="*"/>
      </FormGroup>
      <FormGroup label="Except" {...group('exclude_projects', "Patterns of projects to leave alone.")}>
        <InputGroup {...text('exclude_projects')} className={Classes.MONOSPACE_TEXT} placeholder="None"/>
      </FormGroup>
    </div>
    <div style={{ marginTop: -8, marginBottom: 12 }}><MatchingProjects projects={form.projects} exclude_projects={form.exclude_projects}/></div>

    {kind === 'hard_delete' && <FormGroup label="Which runs" labelFor={`${id_prefix}-runs`}>
      <RadioGroup selectedValue={form.runs} onChange={e => set({ runs: e.target.value })} aria-label="Which runs">
        {run_options.map(option => <Radio key={option.value} value={option.value} labelElement={<span>
          {option.label}
          <span className={Classes.TEXT_MUTED} style={{ display: 'block', fontSize: 12 }}>{option.description}</span>
        </span>}/>)}
      </RadioGroup>
    </FormGroup>}

    {kind === 'scan_storage' && <>
      <FormGroup label="Other folders" {...group('roots', "Scanned with the projects' outputs and artifacts folders, comma-separated. Leave the projects empty to scan only these.")}>
        <InputGroup {...text('roots')} className={Classes.MONOSPACE_TEXT} placeholder="/algo/project/outputs"/>
      </FormGroup>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', columnGap: 16 }}>
        <FormGroup label="Details down to (MB)" {...group('min_size_mb', "Smaller folders and files are summed up in their parent folder: the scan stays small.")}>
          <InputGroup {...text('min_size_mb')} type="number" min={0}/>
        </FormGroup>
        <FormGroup label="Threads" {...group('threads', "Network storage answers slowly but in parallel: more threads scan faster, and load it more.")}>
          <InputGroup {...text('threads')} type="number" min={1} max={64}/>
        </FormGroup>
      </div>
    </>}

    {kind === 'delete_artifacts' && <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', columnGap: 16 }}>
        <FormGroup label="Commits without runs for" {...group('older_than', "Since their latest run, or since they were made if they never had runs.")}>
          <InputGroup {...text('older_than')} placeholder="1month"/>
        </FormGroup>
        <FormGroup label="Keep" {...group('keep', <>Artifact groups, paths or globs, e.g. <code>coverage_report, build/*.html</code>. Also kept: what qaboard.yaml's <code>storage.garbage.artifacts.keep</code> lists.</>)}>
          <InputGroup {...text('keep')} className={Classes.MONOSPACE_TEXT} placeholder="Nothing more"/>
        </FormGroup>
      </div>
      <Switch checked={form.can_delete_reference_branch} onChange={() => set({ can_delete_reference_branch: !form.can_delete_reference_branch })} label="Also on the reference branch (its latest commit is kept)"/>
    </>}

    {kind === 'hard_delete' && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', columnGap: 16 }}>
      <FormGroup label="Runs created before" {...group('created_before', "A date (UTC), or how long before the job starts, e.g. 1month. Empty: any date.")}>
        <InputGroup {...text('created_before')} placeholder="Any date"/>
      </FormGroup>
      <FormGroup label="Runs created after" {...group('created_after', "Optional, e.g. 2025-01-01.")}>
        <InputGroup {...text('created_after')} placeholder="Any date"/>
      </FormGroup>
    </div>}

    {kind === 'garbage_collect' && <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', columnGap: 16 }}>
        <FormGroup label="By default, older than" {...group('default_older_than', <>For the projects whose qaboard.yaml doesn't set <code>storage.garbage.after</code>.</>)}>
          <InputGroup {...text('default_older_than')} placeholder="1month"/>
        </FormGroup>
        <FormGroup label="Override: older than" {...group('older_than', "Ignores what the projects' qaboard.yaml says. Rarely needed.")}>
          <InputGroup {...text('older_than')} placeholder="As qaboard.yaml says"/>
        </FormGroup>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 24 }}>
        <Switch checked={form.delete_outputs} onChange={() => set({ delete_outputs: !form.delete_outputs })} label="Delete the runs' files"/>
        <Switch checked={form.delete_artifacts} onChange={() => set({ delete_artifacts: !form.delete_artifacts })} label="Delete the artifacts, even if qaboard.yaml doesn't ask"/>
        <Switch checked={form.can_delete_reference_branch} onChange={() => set({ can_delete_reference_branch: !form.can_delete_reference_branch })} label="Also on the reference branch (its latest commit is kept)"/>
      </div>
    </>}

    {kind === 'fail_stuck_runs' && <>
      <FormGroup label="Pending for over" {...group('older_than', "Since they were queued, or started running. Runs from before QA-Board recorded it: since they were created.")}>
        <InputGroup {...text('older_than')} placeholder="1week" style={{ maxWidth: 240 }}/>
      </FormGroup>
      <Switch checked={form.only_running} onChange={() => set({ only_running: !form.only_running })} label="Only runs that started (leave the runs still waiting in a queue)"/>
    </>}

    <Estimate kind={kind} form={form}/>
    {'dry_run' in (defaults[kind] ?? {}) && <Switch
      checked={form.dry_run}
      onChange={() => set({ dry_run: !form.dry_run })}
      labelElement={<span><strong>Dry run</strong> <span className={Classes.TEXT_MUTED}>— nothing is deleted: the job says what would be</span></span>}
    />}
  </>;
};

const what_is_kept = {
  hard_delete: "Runs are deleted from the database: see below what happens to their files. Milestones are never deleted: the batches saved as milestones, and the commits qaboard.yaml protects. Runs are never purged because their folder is missing right under a storage root: the storage may just not be mounted. It can't be undone.",
  delete_artifacts: "Deletes the artifacts that qa save-artifacts saved, for commits without recent runs. Kept: the artifacts of milestones, the reference branch's (unless you ask), commits with runs in progress, and what Keep lists. Runs and commits stay, and QA-Board can recreate the artifacts if qaboard.yaml says how.",
  garbage_collect: "Deletes the files of old runs, and maybe the commits' artifacts, as each project's qaboard.yaml says. Runs stay listed, as deleted: a hard delete removes them later. Milestones are kept.",
  scan_storage: "Walks the projects' folders on disk, and finds what QA-Board doesn't track: runs it doesn't know, exports, what deleted runs and artifacts left, other files, with who owns them. Nothing is deleted: explore the scan, and choose what to delete. It can take hours on big storage.",
  measure_deleted: "Measures what the runs deleted before QA-Board measured it left on disk (manifests, files their manifests don't list): users see it in Storage usage. Nothing is deleted.",
  fail_stuck_runs: "Marks as failed the runs waiting or running for too long: their job died without telling QA-Board (killed by LSF, a machine that rebooted…). Users stop seeing them as running, and can redo them. Their jobs aren't stopped, nothing is deleted: a run that still runs saves its results when it ends.",
};


// Start a job now
export const kind_icons = { hard_delete: 'trash', garbage_collect: 'clean', delete_artifacts: 'box', scan_storage: 'search', measure_deleted: 'calculator', fail_stuck_runs: 'outdated' };

export const JobDialog = ({ kind, isOpen, onClose, initial, title }) => {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => fromParams(kind, initial));
  const [errors, setErrors] = useState({});
  const [server_error, setServerError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = changes => setForm(form => ({ ...form, ...changes }));

  const submit = event => {
    event.preventDefault();
    const found = validateParams(kind, form);
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    setServerError(null);
    startJob(queryClient, kind, toParams(kind, form))
      .then(job => {
        toaster.show({ message: `Started job #${job.id}${job.dry_run ? ' (dry run)' : ''}`, intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 });
        onClose();
        history.push(`/admin/storage/jobs/${job.id}`);
      })
      .catch(error => setServerError({ message: errorMessage(error), job: error?.response?.data?.job }))
      .finally(() => setBusy(false));
  };

  return <Dialog isOpen={isOpen} onClose={onClose} title={title ?? kind_labels[kind]} icon={kind_icons[kind]} style={{ width: 680, maxWidth: 'calc(100vw - 32px)' }}>
    <form onSubmit={submit} noValidate>
      <DialogBody>
        {server_error && <Callout intent={Intent.DANGER} style={{ marginBottom: 16 }} role="alert" title="The server refused it">
          {server_error.message}
          {server_error.job && <div><Button variant="minimal" size="small" text={`See job #${server_error.job.id}`} onClick={() => { onClose(); history.push(`/admin/storage/jobs/${server_error.job.id}`); }}/></div>}
        </Callout>}
        <p className={Classes.TEXT_MUTED}>{what_is_kept[kind]}</p>
        <JobParamsFields kind={kind} form={form} set={set} errors={errors}/>
        {'dry_run' in defaults[kind] && !form.dry_run && <Callout intent={Intent.WARNING} icon="warning-sign" style={{ marginTop: 12 }}>
          This is not a dry run: {kind === 'hard_delete' ? 'the runs will be deleted for good.' : kind === 'delete_artifacts' ? 'the artifacts will be deleted.' : kind === 'fail_stuck_runs' ? 'the runs will be marked as failed.' : 'files will be deleted.'} Errors don't stop the job: they're listed on its page.
        </Callout>}
      </DialogBody>
      <DialogFooter actions={<>
        <Button text="Cancel" onClick={onClose}/>
        {'dry_run' in defaults[kind]
          ? <Button type="submit" intent={form.dry_run ? Intent.PRIMARY : Intent.DANGER} text={form.dry_run ? 'Start the dry run' : kind === 'fail_stuck_runs' ? 'Mark as failed' : 'Delete'} loading={busy}/>
          : <Button type="submit" intent={Intent.PRIMARY} text="Start" loading={busy}/>}
      </>}/>
    </form>
  </Dialog>;
};


const cron_presets = [
  { value: '0 2 * * *', label: 'Every night at 2:00' },
  { value: '0 3 * * 6', label: 'Every Saturday at 3:00' },
  { value: '0 3 1 * *', label: 'The 1st of every month at 3:00' },
];
const browser_timezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

const NextRuns = ({ cron, timezone }) => {
  const debounced = useDebounced({ cron, timezone });
  const { data, error, isPending } = useQuery(nextRunsQuery(debounced.cron, debounced.timezone));
  if (!debounced.cron?.trim() || isPending) return null;
  if (error) return <span className={Classes.INTENT_DANGER} role="alert">{errorMessage(error)}</span>;
  return <span className={Classes.TEXT_MUTED}>Next: {data.slice(0, 3).map(iso => parseDate(iso).toLocaleString(DateTime.DATETIME_MED)).join(', ')}</span>;
};


// Create or edit a schedule
export const ScheduleDialog = ({ isOpen, onClose, schedule }) => {
  const queryClient = useQueryClient();
  const create = !schedule?.id;
  const [kind, setKind] = useState(schedule?.kind ?? 'hard_delete');
  const [form, setForm] = useState(() => fromParams(kind, schedule?.params ?? { dry_run: false }));
  const [name, setName] = useState(schedule?.name ?? '');
  const [cron, setCron] = useState(schedule?.cron ?? '0 2 * * *');
  const [timezone, setTimezone] = useState(schedule?.timezone ?? browser_timezone());
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [errors, setErrors] = useState({});
  const [server_error, setServerError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = changes => setForm(form => ({ ...form, ...changes }));

  const changeKind = new_kind => {
    setKind(new_kind);
    setForm(form => ({ ...fromParams(new_kind, { dry_run: false }), projects: form.projects, exclude_projects: form.exclude_projects }));
  };

  const submit = event => {
    event.preventDefault();
    const found = validateParams(kind, form);
    if (!name.trim()) found.name = "Say what it's for, e.g. Nightly purge.";
    if (cron.trim().split(/\s+/).length !== 5 && !cron.trim().startsWith('@')) found.cron = "5 fields: minute hour day-of-month month day-of-week.";
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    setServerError(null);
    saveSchedule(queryClient, schedule?.id, { name: name.trim(), kind, params: toParams(kind, form), cron: cron.trim(), timezone, enabled })
      .then(saved => {
        toaster.show({ message: create ? `Scheduled "${saved.name}"` : `Saved "${saved.name}"`, intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 });
        onClose();
      })
      .catch(error => setServerError(errorMessage(error)))
      .finally(() => setBusy(false));
  };

  return <Dialog isOpen={isOpen} onClose={onClose} title={create ? 'New schedule' : `Edit "${schedule.name}"`} icon="time" style={{ width: 680, maxWidth: 'calc(100vw - 32px)' }}>
    <form onSubmit={submit} noValidate>
      <DialogBody>
        {server_error && <Callout intent={Intent.DANGER} style={{ marginBottom: 16 }} role="alert" title="The server refused it">{server_error}</Callout>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', columnGap: 16 }}>
          <FormGroup label="Name" labelFor="schedule-name" intent={errors.name ? Intent.DANGER : undefined} helperText={errors.name}>
            <InputGroup id="schedule-name" value={name} onChange={e => setName(e.target.value)} placeholder="Nightly purge" autoFocus/>
          </FormGroup>
          <FormGroup label="Job" labelFor="schedule-kind">
            <HTMLSelect id="schedule-kind" fill value={kind} onChange={e => changeKind(e.target.value)} options={Object.entries(kind_labels).map(([value, label]) => ({ value, label }))}/>
          </FormGroup>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', columnGap: 16 }}>
          <FormGroup label="When (cron)" labelFor="schedule-cron" intent={errors.cron ? Intent.DANGER : undefined}
            helperText={errors.cron ?? <NextRuns cron={cron} timezone={timezone}/>}>
            <div style={{ display: 'flex', gap: 8 }}>
              <InputGroup id="schedule-cron" value={cron} onChange={e => setCron(e.target.value)} className={Classes.MONOSPACE_TEXT} spellCheck={false} fill/>
              <HTMLSelect aria-label="Presets" value="" onChange={e => e.target.value && setCron(e.target.value)}
                options={[{ value: '', label: 'Presets' }, ...cron_presets]}/>
            </div>
          </FormGroup>
          <FormGroup label="Time zone" labelFor="schedule-timezone" helperText="Of the cron expression, e.g. UTC or Asia/Jerusalem.">
            <InputGroup id="schedule-timezone" value={timezone} onChange={e => setTimezone(e.target.value)} spellCheck={false}/>
          </FormGroup>
        </div>
        <p className={Classes.TEXT_MUTED}>{what_is_kept[kind]}</p>
        <JobParamsFields kind={kind} form={form} set={set} errors={errors} id_prefix="schedule"/>
        <Switch checked={enabled} onChange={() => setEnabled(!enabled)} label="Enabled" style={{ marginTop: 8 }}/>
      </DialogBody>
      <DialogFooter actions={<>
        <Button text="Cancel" onClick={onClose}/>
        <Button type="submit" intent={Intent.PRIMARY} text={create ? 'Schedule' : 'Save'} loading={busy}/>
      </>}/>
    </form>
  </Dialog>;
};
