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

const toaster = Toaster.create();

const CommitsWarningMessages = ({commits}) => {
	let some_ids_not_correct = Object.keys(commits).some(id => id===null)
	if (some_ids_not_correct)
		return <NonIdealState
      title="No commit selected"
      description="Please first select a commit."
      icon="folder-open"
    />;
  return <span></span>
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
        toaster.show({message: JSON.stringify(error), intent: Intent.DANGER});
        this.refresh()
      });
  }


  render() {
    const { batch } = this.props;
    if (batch === null || batch === undefined  || batch.output_dir_url === undefined)
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

    let some_pending = Object.values(batch.outputs).some(o => o.is_pending);
    let stop_runs = some_pending && <Callout>
      <Button icon="stop" disabled={!!this.state.waiting_stop} onClick={() => this.stop_batch(batch)} minimal>Stop runs</Button>
    </Callout>


    let running_message = batch.running_outputs > 0 && (
      <Callout
        icon="info-sign"
        intent={Intent.SUCCESS}
        title={
          <Tooltip>
            <span>
              {batch.running_outputs} running
            </span>
            <SimpleOutputList
              outputs={Object.values(batch.outputs).filter(o => o.is_running)}
            />
          </Tooltip>
        }
      />
    )
    let nb_pending = batch.pending_outputs - batch.running_outputs;
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
              outputs={Object.values(batch.outputs).filter(o => o.is_pending && !o.is_running)}
              intent={Intent.WARNING}
            />
          </Tooltip>
        }
      />
    )
    let failed_message = batch.failed_outputs > 0 && (
      <Callout
        icon="error"
        intent={Intent.DANGER}
        title={`${batch.failed_outputs} crashed`}
      >
        <p>Be sure to read the logs.</p>
        <SimpleOutputList
          outputs={Object.values(batch.outputs).filter(o => o.is_failed)}
          intent={Intent.DANGER}
        />
      </Callout>
    )

    let deleted_message = batch.deleted_outputs > 0 && (
      <Callout
        icon="trash"
        title={`${batch.deleted_outputs} of the outputs below were deleted`}
      >
        <Button
          icon="redo"
          text="Redo deleted outputs"
          minimal
          disabled={!!this.state.waiting_stop}
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




export { CommitsWarningMessages, BatchStatusMessages }