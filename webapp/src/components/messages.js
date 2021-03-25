import React, { Fragment } from "react";
import { post } from "axios";

import {
  Classes,
  Intent,
  Callout,
  Button,
  Tooltip,
  NonIdealState,
  Toaster,
} from "@blueprintjs/core";
import { ConfigurationsTags, ExtraParametersTags } from './tags'
import { fetchCommit } from "../actions/commit";

const toaster = Toaster.create();



class CommitWarningMessages extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      waiting: false,
    };
  }
  
  refresh = () => {
    const { project, commit, dispatch } = this.props;
    dispatch(fetchCommit({project, id: commit.id}))
  }

  restore_artifacts() {
    const { commit, project } = this.props;
    if (commit === undefined || commit === null) return;
    this.setState({waiting: true})
    toaster.show({message: "Restoring artifacts..."});
    post(`/api/v1/commit/save-artifacts/`, {hexsha: commit.id, project})
      .then(response => {
        this.setState({waiting: false})
        toaster.show({message: `Restore artifacts.`, intent: Intent.PRIMARY});
        this.refresh()
})
      .catch(error => {
        this.setState({waiting: false });
        toaster.show({message: JSON.stringify(error), intent: Intent.DANGER});
        this.refresh()
      });

  }
  
  render() {
    const commit = this.props.commit;
    if (commit?.id===null) {
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
            disabled={!!this.state.waiting}
            onClick={() => this.restore_artifacts(commit)}
          />
      </Callout>
    } 
    return <span></span>
  }
}




const SimpleOutputList = ({outputs, intent}) => {
  return <ul className={Classes.LIST}>
    {outputs.map(o =>
      <li key={o.id}>
        <strong style={{paddingRight: '5px'}}>{o.test_input_path}</strong>
        <ConfigurationsTags intent={intent} configurations={o.configurations}/>
        <ExtraParametersTags intent={intent} parameters={o.extra_parameters} before={<br/>} />
      </li>
    )}
  </ul>
}



class BatchStatusMessages extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      waiting_stop: false,
      waiting_redo: false,
    };
  }

  stop_batch(batch) {
    if (batch === undefined || batch === null) return;
    this.setState({waiting_stop: true})
    toaster.show({message: "Stop requested."});
    post(`/api/v1/batch/stop/`, {id: batch.id})
    .then(response => {
      this.setState({waiting_stop: false})
    })
    .catch(error => {
      console.log(error)
      toaster.show({message: JSON.stringify(error), intent: Intent.DANGER});
      this.setState({waiting_stop: true, error });
    });
  }

  refresh = (refresh_again=true) => {
    const { project, commit, dispatch } = this.props;
    dispatch(fetchCommit({project, id: commit.id}))
    if (refresh_again) {
      setTimeout(() => this.refresh(false),  1*1000)
      setTimeout(() => this.refresh(false),  5*1000)
      setTimeout(() => this.refresh(false), 10*1000)  
    }
}

  redo_batch(batch) {
    if (batch === undefined || batch === null) return;
    this.setState({waiting_redo: true})
    toaster.show({message: "Redo requested."});
    post(`/api/v1/batch/redo/`, {id: batch.id, only_deleted: true})
      .then(response => {
        this.setState({waiting_redo: false})
        toaster.show({message: `Redo ${batch.label}.`, intent: Intent.PRIMARY});
        this.refresh()
      })
      .catch(error => {
        this.setState({waiting_redo: false });
        toaster.show({message: JSON.stringify(error.response ?? error), intent: Intent.DANGER});
        this.refresh()
      });
  }


  render() {
    const { batch } = this.props;
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
      <Button icon="stop" disabled={!!this.state.waiting_stop} onClick={() => this.stop_batch(batch)} minimal>Stop runs</Button>
    </Callout>


    let running_message = batch.filtered.running_outputs > 0 && (
      <Callout
        icon="info-sign"
        intent={Intent.SUCCESS}
        title={
          <Tooltip>
            <span>
              {batch.filtered.running_outputs} running
            </span>
            <SimpleOutputList
              outputs={outputs.filter(o => o.is_running)}
            />
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
          <Tooltip>
            <span>
              {nb_pending} pending
            </span>
            <SimpleOutputList
              outputs={outputs.filter(o => o.is_pending && !o.is_running)}
              intent={Intent.WARNING}
            />
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
          text={`Redo Deleted Outputs${this.props.commit?.deleted ? '. Requires artifacts.' : ''}`}
          minimal
          disabled={!!this.state.waiting_redo || this.props.commit?.deleted}
          onClick={() => this.redo_batch(batch)}
        />
      </Callout>
    )


    return <Fragment>
      {local_batch_message}
      {running_message}
      {pending_message}
      {stop_runs}
      {failed_message}
      {deleted_message}
    </Fragment>;

  }

}




export { CommitWarningMessages, BatchStatusMessages }