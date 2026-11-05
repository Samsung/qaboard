import { Fragment, useState } from "react";

import {
  Classes,
  Intent,
  Callout,
  Button,
  Tooltip,
  NonIdealState,
} from "@blueprintjs/core";
import { ConfigurationsTags } from './tags'
import { RunName } from './runNames'
import { http, errorMessage, isArtifactsError } from "../api/http";
import { useRefreshCommit, updateSelected, useUser } from "../hooks";
import { pretty_label, shows_only_failed, only_failed_filter, without_failed_filter, only_run_filter } from "../utils";
import { toaster } from "../toaster"
import { track } from "../analytics"
import { SubmissionCallout } from "./logs/BatchSubmissions"
import { ArtifactsCallout } from "./ArtifactsCallout"
import { LoginHint } from "./authentication/login"


const CommitWarningMessages = ({ project, commit }) => {
  const [waiting, setWaiting] = useState(false);
  const refreshCommit = useRefreshCommit();

  const restore_artifacts = () => {
    if (commit === undefined || commit === null) return;
    const refresh = () => refreshCommit(project, commit.id)
    setWaiting(true)
    const message = commit.artifacts?.recreate ? "Asking to recreate the artifacts…" : "Restoring the artifacts from the source code…"
    toaster.show({message, icon: 'time'}, 'restore-artifacts');
    http.post(`/api/v1/commit/save-artifacts/`, {hexsha: commit.id, project})
      .then(response => {
        toaster.show({
          message: response.data?.message ?? "Restored the artifacts.",
          intent: response.data?.status === 'restored' ? Intent.SUCCESS : Intent.PRIMARY,
          timeout: 10000,
        }, 'restore-artifacts');
      })
      .catch(error => {
        toaster.show({message: `Could not restore the artifacts: ${errorMessage(error)}`, intent: Intent.DANGER, timeout: 15000}, 'restore-artifacts');
      })
      .finally(() => {
        setWaiting(false)
        refresh()
      });
  }

  if (commit?.id === null) {
    return <NonIdealState
      title="No commit selected"
      description="Please first select a commit."
      icon="folder-open"
    />;
  }
  if (!commit) return <span></span>
  return <ArtifactsCallout
    deleted={commit.deleted}
    artifacts={commit.artifacts}
    waiting={waiting}
    onRestore={restore_artifacts}
  />
}




// link_logs: the run names open their log, actions: what's shown after each run, e.g. buttons
const SimpleOutputList = ({outputs, intent, link_logs = false, actions}) => {
  return <ul className={Classes.LIST}>
    {outputs.map(o => {
      // after its batch and database when the runs come from several, like everywhere
      const run_path = <RunName output={o} hover={false}/>
      return <li key={o.id}>
        <strong style={{paddingRight: '5px'}}>
          {link_logs && !!o.output_dir_url
            ? <a href={`${o.output_dir_url}/log.txt`} target="_blank" rel="noopener noreferrer" title="Open its log">{run_path}</a>
            : run_path}
        </strong>
        <ConfigurationsTags intent={intent} configurations={o.configurations} tuning={o.extra_parameters}/>
        {actions?.(o)}
      </li>
      }
    )}
  </ul>
}



// Up to this many failed runs, we list them. When more fail, it's often for a common reason: the list would push
// the page down, users rather filter the page to show only the runs that failed, and list them on demand.
const few_failed_runs = 5

// Filters the page to show only this run (Back shows them all again)
const goToRun = (id, filter) => updateSelected({ filter_batch_new: only_run_filter(filter, id) })

// The runs that failed, among those the filter keeps
const FailedRunsCallout = ({ runs, filter, onShowLogs }) => {
  const [expanded, setExpanded] = useState(false)
  if (runs.length === 0) return null
  const is_long = runs.length > few_failed_runs
  const only_failed = shows_only_failed(filter)
  const setFilter = value => updateSelected({ filter_batch_new: value })
  return <Callout icon="error" intent={Intent.DANGER} title={`${runs.length} failed`}>
    {(!is_long || expanded) && <SimpleOutputList
      outputs={runs}
      intent={Intent.DANGER}
      link_logs
      actions={o => <Tooltip content="Show only this run" placement="right">
        <Button size="small" variant="minimal" icon="locate" aria-label="Show only this run" onClick={() => goToRun(o.id, filter)}/>
      </Tooltip>}
    />}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {only_failed
        ? <Button size="small" icon="filter-remove" onClick={() => setFilter(without_failed_filter(filter))}>Show all the runs</Button>
        : <Button size="small" icon="filter" intent={is_long ? Intent.DANGER : Intent.NONE} onClick={() => setFilter(only_failed_filter(filter))}>
            Show only the failed runs
          </Button>}
      {is_long && <Button size="small" variant="minimal" icon={expanded ? 'chevron-up' : 'chevron-down'} onClick={() => setExpanded(!expanded)}>
        {expanded ? 'Hide the list' : `List the ${runs.length} runs`}
      </Button>}
      <Button size="small" icon="console" onClick={onShowLogs}>Open the logs</Button>
    </div>
  </Callout>
}


const BatchStatusMessages = ({ project, commit, batch, filter }) => {
  const [waiting_stop, setWaitingStop] = useState(false);
  const [waiting_redo, setWaitingRedo] = useState(false);
  const refreshCommit = useRefreshCommit();
  const is_logged = useUser().is_logged;

  const refresh = (refresh_again = true) => {
    if (!commit?.id) return
    refreshCommit(project, commit.id)
    if (refresh_again) {
      setTimeout(() => refreshCommit(project, commit.id),  1*1000)
      setTimeout(() => refreshCommit(project, commit.id),  5*1000)
      setTimeout(() => refreshCommit(project, commit.id), 10*1000)
    }
  }

  const stop_batch = () => {
    if (batch === undefined || batch === null) return;
    setWaitingStop(true)
    const key = `stop-${batch.id}`
    toaster.show({message: `Stopping the runs of ${pretty_label(batch)}…`, icon: 'time'}, key);
    http.post(`/api/v1/batch/stop/`, {id: batch.id})
      .then(() => {
        toaster.show({message: `Stopping the runs of ${pretty_label(batch)}`, intent: Intent.SUCCESS}, key);
        track('batch_stop', { commit_id: commit?.id }, { project_id: project })
        refresh()
      })
      .catch(error => {
        toaster.show({message: `Could not stop the runs: ${errorMessage(error)}`, intent: Intent.DANGER}, key);
      })
      .finally(() => setWaitingStop(false));
  }

  const redo_batch = () => {
    if (batch === undefined || batch === null) return;
    setWaitingRedo(true)
    const key = `redo-deleted-${batch.id}`
    const show_logs = { text: "Show the logs", onClick: () => updateSelected({ selected_views: 'logs' }) }
    toaster.show({message: `Starting the deleted runs of ${pretty_label(batch)} again…`, icon: 'time'}, key);
    http.post(`/api/v1/batch/redo/`, {id: batch.id, only_deleted: true})
      .then(({ data }) => {
        toaster.show({message: `Redoing the deleted runs of ${pretty_label(batch)}`, intent: Intent.SUCCESS, action: show_logs}, key);
        track('batch_start', { kind: 'redo', commit_id: commit?.id, n_runs: typeof data?.submission?.runs === 'number' ? data.submission.runs : undefined }, { project_id: project })
        // e.g. only the source files of the artifacts could be restored
        if (data?.warning) toaster.show({message: data.warning, intent: Intent.WARNING, timeout: 15000});
      })
      .catch(error => {
        // 409: the artifacts are missing, maybe being recreated by the CI
        toaster.show({message: errorMessage(error), intent: isArtifactsError(error) ? Intent.WARNING : Intent.DANGER, timeout: 15000, action: error.response?.data?.submission ? show_logs : undefined}, key);
      })
      .finally(() => {
        setWaitingRedo(false)
        refresh()
      });
  }

  if (batch === null || batch === undefined  || batch.batch_dir_url === undefined)
    return <span></span>

  let local_batch_message = (batch.data && batch.data.type === 'local') && (
    <Callout
      icon="eye-off"
      intent={Intent.WARNING}
      title="Be careful, those are local runs"
    >
      <p>It is possible they didn't use the code under version control.</p>
      <p>It's fine for debugging. Use your Continuous Integration to share results.</p>
    </Callout>
  )

  const outputs = batch.filtered.outputs.map(id => batch.outputs[id])
  let some_pending = outputs.some(o => o.is_pending);
  const nb_running = batch.filtered.running_outputs;
  const nb_pending = batch.filtered.pending_outputs - batch.filtered.running_outputs;
  const show_logs = () => updateSelected({ selected_views: 'logs' })

  // The runs in progress, and how to stop them
  let progress_message = (nb_running > 0 || nb_pending > 0 || some_pending) && (
    <Callout
      icon="time"
      intent={Intent.PRIMARY}
      title={<>
        {nb_running > 0 && <Tooltip content={<SimpleOutputList outputs={outputs.filter(o => o.is_running)}/>}>
          <span>{nb_running} running</span>
        </Tooltip>}
        {nb_running > 0 && nb_pending > 0 && ' · '}
        {nb_pending > 0 && <Tooltip content={<SimpleOutputList outputs={outputs.filter(o => o.is_pending && !o.is_running)}/>}>
          <span>{nb_pending} pending</span>
        </Tooltip>}
      </>}
    >
      {some_pending && <Button size="small" icon="stop" disabled={waiting_stop || !is_logged} onClick={stop_batch}>Stop runs</Button>}
      {some_pending && !is_logged && <LoginHint text="Sign in to stop runs"/>}
    </Callout>
  )
  // A failed evaluation of an automated tuning isn't one of the batch's runs: Tuning Analysis explains it
  const failed_runs = outputs.filter(o => o.is_failed && o.output_type !== 'optim_iteration')
  let failed_message = <FailedRunsCallout runs={failed_runs} filter={filter} onShowLogs={show_logs}/>

  let deleted_message = batch.filtered.deleted_outputs > 0 && (
    <Callout
      icon="trash"
      title={`${batch.filtered.deleted_outputs} of the runs below were deleted`}
    >
      <Button
        icon="redo"
        text={`Redo deleted runs${commit?.deleted ? ' (restores the artifacts first)' : ''}`}
        minimal
        disabled={waiting_redo || !is_logged}
        onClick={redo_batch}
      />
      {!is_logged && <LoginHint text="Sign in to redo runs"/>}
    </Callout>
  )


  return <Fragment>
    <SubmissionCallout
      batch={batch}
      has_runs={Object.keys(batch.outputs ?? {}).length > 0}
      onFinished={refresh}
    />
    {local_batch_message}
    {progress_message}
    {failed_message}
    {deleted_message}
  </Fragment>;
}




export { CommitWarningMessages, BatchStatusMessages }