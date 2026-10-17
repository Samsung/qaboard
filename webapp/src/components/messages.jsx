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
import { http, errorMessage } from "../api/http";
import { useRefreshCommit, updateSelected } from "../hooks";
import { pretty_label } from "../utils";
import { toaster } from "../toaster"
import { SubmissionCallout } from "./logs/BatchSubmissions"


const CommitWarningMessages = ({ project, commit }) => {
  const [waiting, setWaiting] = useState(false);
  const refreshCommit = useRefreshCommit();

  const restore_artifacts = () => {
    if (commit === undefined || commit === null) return;
    const refresh = () => refreshCommit(project, commit.id)
    setWaiting(true)
    toaster.show({message: "Restoring the artifacts…", icon: 'time'}, 'restore-artifacts');
    http.post(`/api/v1/commit/save-artifacts/`, {hexsha: commit.id, project})
      .then(() => {
        setWaiting(false)
        toaster.show({message: "Restored the artifacts. Rebuild if your runs need new binaries.", intent: Intent.SUCCESS}, 'restore-artifacts');
        refresh()
      })
      .catch(error => {
        setWaiting(false)
        toaster.show({message: `Could not restore the artifacts: ${errorMessage(error)}`, intent: Intent.DANGER}, 'restore-artifacts');
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
  if (commit?.deleted) {
    return <Callout
        icon="trash"
        title={`This commit's artifacts have been deleted!`}
      >
        <p>We can restore the artifacts for you, but you'll likely need to rebuild too..!</p>
        <Button
          icon="redo"
          text="Restore artifacts"
          minimal
          disabled={waiting}
          onClick={restore_artifacts}
        />
    </Callout>
  }
  return <span></span>
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
      .then(() => {
        toaster.show({message: `Redoing the deleted runs of ${pretty_label(batch)}`, intent: Intent.SUCCESS, action: show_logs}, key);
      })
      .catch(error => {
        toaster.show({message: errorMessage(error), intent: Intent.DANGER, action: error.response?.data?.submission ? show_logs : undefined}, key);
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
      {some_pending && <Button size="small" icon="stop" disabled={waiting_stop} onClick={stop_batch}>Stop runs</Button>}
    </Callout>
  )
  let failed_message = batch.filtered.failed_outputs > 0 && (
    <Callout
      icon="error"
      intent={Intent.DANGER}
      title={`${batch.filtered.failed_outputs} failed`}
    >
      <SimpleOutputList
        outputs={outputs.filter(o => o.is_failed)}
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
        text={`Redo deleted runs${commit?.deleted ? '. Requires artifacts.' : ''}`}
        minimal
        disabled={waiting_redo || commit?.deleted}
        onClick={redo_batch}
      />
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