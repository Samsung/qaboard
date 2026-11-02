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
import { http, errorMessage, isArtifactsError } from "../api/http";
import { useRefreshCommit, updateSelected, useUser } from "../hooks";
import { pretty_label } from "../utils";
import { toaster } from "../toaster"
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




// link_logs: the run names open their log
const SimpleOutputList = ({outputs, intent, link_logs = false}) => {
  return <ul className={Classes.LIST}>
    {outputs.map(o => {
      const has_metadata = !!o.test_input_metadata && (Object.keys(o.test_input_metadata).length > 0)
      const has_label = has_metadata && !!o.test_input_metadata.label
      let run_path = `${o.test_input_database === '/' ? '/' : ''}${o.test_input_path}`
      if (o.output_type === "pipeline" || o.test_input_path === "PIPELINE") {
        run_path = <span>{o.data.batch} <span className={Classes.TEXT_MUTED}>(pipeline)</span></span>
      }
      if (has_label) {
        run_path = o.test_input_metadata.label
      }
      return <li key={o.id}>
        <strong style={{paddingRight: '5px'}}>
          {link_logs && !!o.output_dir_url
            ? <a href={`${o.output_dir_url}/log.txt`} target="_blank" rel="noopener noreferrer" title="Open its log">{run_path}</a>
            : run_path}
        </strong>
        <ConfigurationsTags intent={intent} configurations={o.configurations} tuning={o.extra_parameters}/>
      </li>
      }
    )}
  </ul>
}



const BatchStatusMessages = ({ project, commit, batch }) => {
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
  let failed_message = failed_runs.length > 0 && (
    <Callout
      icon="error"
      intent={Intent.DANGER}
      title={`${failed_runs.length} failed`}
    >
      <SimpleOutputList
        outputs={failed_runs}
        intent={Intent.DANGER}
        link_logs
      />
      <Button size="small" icon="console" onClick={show_logs}>Open the logs</Button>
    </Callout>
  )

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