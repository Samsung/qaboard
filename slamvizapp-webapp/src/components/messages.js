import React, { Fragment } from "react";
import {
  Classes,
  Intent,
  Callout,
  Tag,
  Tooltip,
  // Spinner,
  NonIdealState,
} from "@blueprintjs/core";


const CommitsWarningMessages = ({commits}) => {
	let some_ids_not_correct = Object.keys(commits).some(id => id===null)
	if (some_ids_not_correct)
		return <NonIdealState
      title="No commit selected"
      description="Please first select a commit."
      icon="folder-open"
    />;

  let commits_ = Object.values(commits);
	// let some_loading = commits_.some( commit => commit===null || commit===undefined || !commit.is_loaded);
	let commits_with_errors = commits_.filter(commit => !!commit && commit.error);
	let errors_messages = <span>
		{commits_with_errors.map( commit =><span key={commit}><strong>{commit.id}:</strong> {commit.error}</span>)}
	</span>;

    // {some_loading && <NonIdealState title="Loading" icon={<Spinner />} />}
	return <Fragment>
	  {commits_with_errors.length>0 && <NonIdealState
      title="Network Error"
      description={errors_messages}
      icon="error"
    />}
	</Fragment>
}


const SimpleOutputList = ({outputs, intent}) => {
  return <ul className={Classes.LIST}>
    {outputs.map(o =>
      <li key={o.id}>
        <Tag intent={intent} minimal>{`${o.configuration} @${o.platform}`}</Tag>{" "}
        <strong>{o.test_input_path}</strong>
        {Object.keys(o.extra_parameters).length > 0 && (
          <Fragment>
            <br />
            <span>{JSON.stringify(o.extra_parameters)}</span>
          </Fragment>
        )}
      </li>
    )}
  </ul>
}


const BatchStatusMessages = ({batch}) => {
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
      <p>Be sure to read the logs in one of the tabs below.</p>
      <SimpleOutputList
        outputs={Object.values(batch.outputs).filter(o => o.is_failed)}
        intent={Intent.DANGER}
      />
    </Callout>
  )

  return <Fragment>
    {running_message}
    {pending_message}
    {failed_message}
  </Fragment>;
}



export { CommitsWarningMessages, BatchStatusMessages }