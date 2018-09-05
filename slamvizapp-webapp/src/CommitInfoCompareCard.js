import React, { Fragment } from "react";
import { Link } from "react-router-dom";
import {
  Classes,
  Card,
  Tag,
  Button,
  Icon,
  Intent,
  EditableText
} from "@blueprintjs/core";

import { Avatar } from "./common/Avatar";
import { DoneAtTag } from "./common/DoneAtTag";
import { shortId } from "./common/utils";

const empty_batch = {
  failed_outputs: 0,
  valid_outputs: 0,
  pending_outputs: 0
};


const CommitInfoCompareCard = ({
  project,
  new_commit,
  ref_commit,
  new_label,
  ref_label,
  onConfirmReference
}) => {
  // if(!new_commit || !ref_commit)
  //   return <span/>

  let new_ci_batch = (new_commit && new_commit.batches && new_commit.batches[new_label]) || empty_batch;
  let ref_ci_batch = (ref_commit && ref_commit.batches && ref_commit.batches[ref_label]) || empty_batch;


  return (
    <Card elevation={4} style={{minHeight: '193px'}}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center"
        }}
      >
        {new_commit && new_commit.id &&
        <div style={{ flex: "1 1 auto", minWidth: "450px" }}>
          <h1 className={Classes.HEADING} style={{ display: "flex", alignItems: "baseline" }}>
            <Avatar
              href={`/committer/${new_commit.committer_name}`}
              alt={new_commit.committer_name}
              src={new_commit.committer_avatar_url}
            />
            {shortId(project, new_commit.id)}
          </h1>
          <Link to={`/branch/${new_commit.branch}`}>
            <Button icon="git-branch">{new_commit.branch}</Button>
          </Link>
          <Icon icon="git-commit" style={{verticalAlign: 'middle', margin: '5px'}} />{" "}
          {new_commit.parents.length > 1 ? "parents" : "parent"}:{" "}
          {new_commit.parents.map(p => (
            <Button
              key={p}
              onClick={e => {
                onConfirmReference(p);
              }}
            >
              {shortId(project, p)}
            </Button>
          ))}
          <br />
          <div style={{ marginTop: "10px" }}>
            <DoneAtTag commit={new_commit} />{" "}
            {new_ci_batch.valid_outputs > 0 && (
              <Tag intent={Intent.SUCCESS}>
                {new_ci_batch.valid_outputs} outputs
              </Tag>
            )}{" "}
            {new_ci_batch.running_outputs > 0 && (
              <Tag intent={Intent.SUCCESS}>
                {new_ci_batch.running_outputs} running
              </Tag>
            )}{" "}
            {new_ci_batch.pending_outputs - new_ci_batch.running_outputs >
              0 && (
              <Tag>
                {new_ci_batch.pending_outputs - new_ci_batch.running_outputs}{" "}
                pending
              </Tag>
            )}{" "}
            {new_ci_batch.failed_outputs > 0 && (
              <Tag intent={Intent.DANGER}>
                {new_ci_batch.failed_outputs} crashed
              </Tag>
            )}
          </div>
          <p
            style={{ marginTop: "10px", maxWidth: "450px" }}
            className={Classes.MONOSPACE_TEXT}
          >
            {new_commit.message}
          </p>
        </div>}

        {ref_commit && ref_commit.id &&
        <Fragment>
        <div style={{ minWidth: "40px", textAlign: "center" }}>
          <span/>
        </div>
        <div style={{ flex: "1 1 auto" }}>
          <h1 className={Classes.HEADING}
            style={{
              display: "flex",
              justifyContent: "flex-end",
              alignItems: "baseline"
            }}
          >
            <EditableText
              style={{
                flex: "1 1 auto",
                margin: "auto",
                borderBottom: "2px solid rgb(100,100,100)"
              }}
              onConfirm={onConfirmReference}
              intent={Intent.PRIMARY}
              defaultValue={shortId(project, ref_commit.id)}
            />
            <Avatar
              href={`/committer/${ref_commit.committer_name}`}
              alt={ref_commit.committer_name}
              src={ref_commit.committer_avatar_url}
            />
          </h1>
          <span style={{ display: "flex", justifyContent: "flex-end" }}>
            <Link to={`/branch/${ref_commit.branch}`}>
              <Button
                style={{ flex: "1 1 auto", margin: "auto" }}
                icon="git-branch"
              >
                {ref_commit.branch}
              </Button>
            </Link>
          </span>
          <div style={{ marginTop: "10px", textAlign: "right" }}>
            <DoneAtTag commit={ref_commit} />{" "}
            {ref_ci_batch.valid_outputs > 0 && (
              <Tag intent={Intent.SUCCESS}>
                {ref_ci_batch.valid_outputs} outputs
              </Tag>
            )}{" "}
            {ref_ci_batch.running_outputs > 0 && (
              <Tag intent={Intent.SUCCESS}>
                {ref_ci_batch.running_outputs} running
              </Tag>
            )}{" "}
            {ref_ci_batch.pending_outputs - ref_ci_batch.running_outputs >
              0 && (
              <Tag>
                {ref_ci_batch.pending_outputs - ref_ci_batch.running_outputs}{" "}
                pending
              </Tag>
            )}{" "}
            {ref_ci_batch.failed_outputs > 0 && (
              <Tag intent={Intent.DANGER}>
                {ref_ci_batch.failed_outputs} crashed
              </Tag>
            )}{" "}
            <Tag intent={Intent.PRIMARY}>Reference</Tag>
          </div>
          <p
            style={{
              display: "flex",
              justifyContent: "flex-end",
              textAlign: "right",
              marginTop: "10px"
            }}
            className={Classes.MONOSPACE_TEXT}
          >
            {ref_commit.message}
          </p>
        </div></Fragment>}
      </div>
    </Card>
  );
};

export { CommitInfoCompareCard };
