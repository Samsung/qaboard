import React, { Fragment } from "react";
import { Link } from "react-router-dom";

import styled from "styled-components";
import { Button, Icon, Intent, Tooltip, Tag } from "@blueprintjs/core";

import { Avatar } from "./common/Avatar";
import { DoneAtTag } from "./common/DoneAtTag";
import { CopyToClipboard } from "react-copy-to-clipboard";
import { shortId } from "./common/utils";
import { metrics } from "./metrics";

const CommitDetails = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  flex-grow: 1;
  padding-left: 10px;
`;

const Message = styled.span`
  font-weight: 600;
`;

const CommitContent = styled.div`
  padding-right: 10px;
  max-width: 750px;
`;

const CommitRowWrapper = styled.li`
  display: flex;
  border-color: #f0f0f0;
  font-size: 14px;
  color: rgba(0, 0, 0, 0.85);
  padding: 10px 0;
  margin: 0;
`;

const has_outputs_in_batch = label => commit =>
  !!commit.batches[label] && commit.batches[label].valid_outputs > 0;

class CommitResults extends React.Component {
  render() {
    const { project, commit } = this.props;
    const gitlab_commit_url = `http://gitlab-srv/${project}/commit/${
      commit.id
    }`;
    let ci_batch = commit.batches.default;
    if (
      ci_batch === undefined ||
      (ci_batch.failed_outputs === 0 &&
        ci_batch.valid_outputs === 0 &&
        ci_batch.pending_outputs === 0)
    )
      return (
        <a style={{ color: "grey" }} href={gitlab_commit_url}>
          <Button intent={Intent.WARNING} className="pt-minimal">
            Check the pipeline status..
          </Button>
        </a>
      );

    let formatter = new Intl.NumberFormat("en-US", {
      style: "decimal",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    let tuning_batches_labels = Object.keys(commit.batches).filter(
      label =>
        label !== "default" &&
        !label.startsWith("ci") &&
        !label.startsWith("manual")
    );

    let has_android_manual_batch = has_outputs_in_batch("manual-android-rt")(
      commit
    );
    let has_android_batch = has_outputs_in_batch("ci-android-rt")(commit);

    const default_metric_info =
      metrics[project].available_metrics[metrics[project].default_metric];

    let status_messages = (
      <Fragment>
        {ci_batch.pending_outputs - ci_batch.running_outputs > 0 && (
          <Tag className="pt-minimal" style={{ marginRight: "4px" }}>
            {ci_batch.pending_outputs - ci_batch.running_outputs} pending
          </Tag>
        )}
        {ci_batch.running_outputs > 0 && (
          <Tag
            className="pt-minimal"
            style={{ marginRight: "4px" }}
            intent={Intent.PRIMARY}
          >
            {ci_batch.running_outputs} running
          </Tag>
        )}
        {ci_batch.failed_outputs > 0 && (
          <Link style={{ marginLeft: "10px" }} to={`/commit/${commit.id}`}>
            <Button intent={Intent.DANGER} className="pt-minimal">
              {ci_batch.failed_outputs} crashed
            </Button>
          </Link>
        )}
        {tuning_batches_labels.length > 1 && (
          <Tooltip>
            <Tag
              intent={Intent.SUCCESS}
              className="pt-minimal"
              style={{ marginRight: "4px" }}
            >
              {tuning_batches_labels.length} tuning batch{tuning_batches_labels.length >
              1
                ? "es"
                : ""}
            </Tag>
            <ul>
              {tuning_batches_labels.map(label => (
                <li key={label}>
                  <strong>{label}</strong>
                </li>
              ))}
            </ul>
          </Tooltip>
        )}
        {has_android_manual_batch && (
          <Tag
            intent={Intent.SUCCESS}
            className="pt-minimal"
            style={{ marginRight: "4px" }}
          >
            {commit.batches["manual-android-rt"].valid_outputs} @android:manual
          </Tag>
        )}
        {has_android_batch && (
          <Tag
            intent={Intent.SUCCESS}
            className="pt-minimal"
            style={{ marginRight: "4px" }}
          >
            {commit.batches["ci-android-rt"].valid_outputs} @android:ci
          </Tag>
        )}
        {ci_batch.valid_outputs > 0 &&
          ci_batch.aggregated_metrics.translation_rmse_median > 0 && (
            <Fragment>
              <Tag className="pt-minimal" style={{ marginRight: "4px" }}>
                <strong>
                  {formatter.format(
                    default_metric_info.scale *
                      ci_batch.aggregated_metrics[
                        `${default_metric_info.key}_median`
                      ]
                  )}
                  {default_metric_info.suffix}
                </strong>{" "}
                median{" "}
              </Tag>
              <Tag style={{ marginRight: "4px" }} className="pt-minimal">
                <strong>
                  {formatter.format(
                    default_metric_info.scale *
                      ci_batch.aggregated_metrics[
                        `${default_metric_info.key}_average`
                      ]
                  )}
                  {default_metric_info.suffix}
                </strong>{" "}
                avg {default_metric_info.short_label}
              </Tag>
              <Tooltip modifiers>
                <Tag className="pt-minimal pt-round">...</Tag>
                <ul>
                  {Object.entries(ci_batch.aggregated_metrics).map(([k, v]) => (
                    <li key={k}>
                      <strong>{k}:</strong> {formatter.format(v)}
                    </li>
                  ))}
                </ul>
              </Tooltip>
            </Fragment>
          )}
      </Fragment>
    );
    return (
      <div>
        {status_messages}
        {ci_batch.valid_outputs > 0 && (
          <Link
            style={{ marginLeft: "10px" }}
            to={`/commit/${commit.id}?project=${project}`}
          >
            <Button
              intent={Intent.SUCCESS}
              text={`${ci_batch.valid_outputs} results`}
            />
          </Link>
        )}
      </div>
    );
  }
}
const CommitResultsStyled = styled(CommitResults)`
  margin-left: auto;
`;

const CommitShortId = styled.a`
  font-family: "Menlo", "Liberation Mono", "Consolas", "DejaVu Sans Mono",
    "Ubuntu Mono", "Courier New", "andale mono", "lucida console", monospace;
  font-weight: 600;
  color: #1b69b6;
`;

class CommitRow extends React.Component {
  render() {
    const { commit, project, className, toaster } = this.props;
    const commit_url =
      project === "dvs/psp_swip" || project === "tof/swip_tof"
        ? `http://gitlab-srv/${project}/commit/${commit.id}`
        : "#sorry-not-yet-available";
    return (
      <CommitRowWrapper className={className}>
        <Avatar
          alt={commit.committer_name}
          href={`/committer/${commit.committer_name}?project=${project}`}
          src={commit.committer_avatar_url}
        />

        <CommitDetails>
          <CommitContent style={{ maxWidth: "600px" }}>
            <Message>{commit.message}</Message>
            <div>
              <CommitShortId project={project} href={commit_url}>
                {shortId(project, commit.id)}
              </CommitShortId>
              <Tooltip>
                <CopyToClipboard
                  text={commit.id}
                  onCopy={() => {
                    toaster.show({
                      message: "Copied to clipboard!",
                      intent: Intent.PRIMARY
                    });
                  }}
                >
                  <Icon
                    title="copy to clipboard"
                    intent={Intent.PRIMARY}
                    className="pt-minimal pt-small"
                    icon="clipboard"
                  />
                </CopyToClipboard>
                <span>Copy to clipboard</span>
              </Tooltip>
              <Icon icon="pt-icon-git-branch" />
              <Link
                style={{ color: "rgba(0,0,0,0.85)" }}
                to={`/branch/${commit.branch}?project=${project}`}
              >
                {commit.branch}
              </Link>
              <DoneAtTag commit={commit} />
            </div>
          </CommitContent>

          <CommitResultsStyled project={project} commit={commit} />
        </CommitDetails>
      </CommitRowWrapper>
    );
  }
}

export { CommitRow };
