import { Fragment, useState } from "react";

import {
  Classes,
  Intent,
  Callout,
  Button,
  Tooltip,
  NonIdealState,
} from "@blueprintjs/core";
import { ConfigurationsTags, ExtraParametersTags } from './tags'
import { http, errorMessage } from "../api/http";
import { useRefreshCommit } from "../hooks";
import { toaster } from "../toaster"
import { SubmissionCallout } from "./logs/BatchSubmissions"


const CommitWarningMessages = ({ project, commit }) => {
  const [waiting, setWaiting] = useState(false);
  const refreshCommit = useRefreshCommit();

  const restore_artifacts = () => {
    if (commit === undefined || commit === null) return;
    const refresh = () => refreshCommit(project, commit.id)
    setWaiting(true)
    toaster.show({message: "Restoring artifacts..."});
    http.post(`/api/v1/commit/save-artifacts/`, {hexsha: commit.id, project})
      .then(() => {
        setWaiting(false)
        toaster.show({message: `Restore artifacts.`, intent: Intent.PRIMARY});
        refresh()
      })
      .catch(error => {
        setWaiting(false)
        toaster.show({message: errorMessage(error), intent: Intent.DANGER});
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
          text="Restore Artifacts"
          minimal
          disabled={waiting}
          onClick={restore_artifacts}
        />
    </Callout>
  }
  return <span></span>
}




const SimpleOutputList = ({outputs, intent}) => {
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
        <strong style={{paddingRight: '5px'}}>{run_path}</strong>
        <ConfigurationsTags intent={intent} configurations={o.configurations}/>
        <ExtraParametersTags intent={intent} parameters={o.extra_parameters} before={<br/>} />
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
    toaster.show({message: "Stop requested."});
    http.post(`/api/v1/batch/stop/`, {id: batch.id})
      .catch(error => {
        console.log(error)
        toaster.show({message: errorMessage(error), intent: Intent.DANGER});
      })
      .finally(() => setWaitingStop(false));
  }

  const redo_batch = () => {
    if (batch === undefined || batch === null) return;
    setWaitingRedo(true)
    toaster.show({message: "Redo requested."});
    http.post(`/api/v1/batch/redo/`, {id: batch.id, only_deleted: true})
      .then(() => {
        toaster.show({message: `Redo ${batch.label}.`, intent: Intent.PRIMARY});
      })
      .catch(error => {
        toaster.show({message: errorMessage(error), intent: Intent.DANGER});
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
      title="Be careful, those are local outputs"
    >
      <p>It is possible they didn't use the code under version control.</p>
      <p>It's fine for debugging. Use your Continuous Integration to share results.</p>
    </Callout>
  )

  const outputs = batch.filtered.outputs.map(id => batch.outputs[id])
  let some_pending = outputs.some(o => o.is_pending);
  let stop_runs = some_pending && <Callout>
    <Button icon="stop" disabled={waiting_stop} onClick={stop_batch} minimal>Stop runs</Button>
  </Callout>


  let running_message = batch.filtered.running_outputs > 0 && (
    <Callout
      icon="info-sign"
      intent={Intent.SUCCESS}
      title={
        <Tooltip content={<SimpleOutputList
          outputs={outputs.filter(o => o.is_running)}
        />}>
          <span>
            {batch.filtered.running_outputs} running
          </span>
        </Tooltip>
      }
    />
  )
  let nb_pending = batch.filtered.pending_outputs - batch.filtered.running_outputs;
  let pending_message = nb_pending > 0 && (
    <Callout
      icon="info-sign"
      intent={Intent.WARNING}
      title={
        <Tooltip content={<SimpleOutputList
          outputs={outputs.filter(o => o.is_pending && !o.is_running)}
          intent={Intent.WARNING}
        />}>
          <span>
            {nb_pending} pending
          </span>
        </Tooltip>
      }
    />
  )
  let failed_message = batch.filtered.failed_outputs > 0 && (
    <Callout
      icon="error"
      intent={Intent.DANGER}
      title={`${batch.filtered.failed_outputs} crashed`}
    >
      <p>Be sure to read the logs.</p>
      <SimpleOutputList
        outputs={outputs.filter(o => o.is_failed)}
        intent={Intent.DANGER}
      />
    </Callout>
  )

  let deleted_message = batch.filtered.deleted_outputs > 0 && (
    <Callout
      icon="trash"
      title={`${batch.filtered.deleted_outputs} of the outputs below were deleted`}
    >
      <Button
        icon="redo"
        text={`Redo Deleted Outputs${commit?.deleted ? '. Requires artifacts.' : ''}`}
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
    {running_message}
    {pending_message}
    {stop_runs}
    {failed_message}
    {deleted_message}
  </Fragment>;
}




export { CommitWarningMessages, BatchStatusMessages }