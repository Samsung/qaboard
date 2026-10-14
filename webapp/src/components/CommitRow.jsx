import { Fragment, useState } from "react";
import { Link } from "../router";

import styled from "styled-components";

import {
  Classes,
  Button,
  Colors,
  Icon,
  Intent,
  Tooltip,
  Tag,
  Menu,
  MenuDivider,
  MenuItem,
  Popover,
} from "@blueprintjs/core";

import { http, errorMessage } from "../api/http";
import { useRefreshCommit } from "../hooks";
import { CommitAvatar } from "./avatars";
import { DoneAtTag } from "./DoneAtTag";
import { format, shortId, pretty_label } from "../utils";
import { commit_url as git_commit_url } from "../git"
import { has_milestones } from './milestones'
import { copyDirectory } from './logs/DirectoryActions'
import { copyWithToast } from '../utils/clipboard'
import { toaster } from "../toaster";

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

const has_outputs_in_batch = label => commit => {
  if (commit.batches[label] === undefined || commit.batches[label] === null)
    return false;
  const { valid_outputs=0, pending_outputs=0, running_outputs=0, failed_outputs=0 } = commit.batches[label];
  let total_outputs = valid_outputs + pending_outputs + running_outputs + failed_outputs;
  return total_outputs > 0;
}




// We compare the batch with the same batch in the reference commit
const commit_page = (project, commit, label) => {
  const search = label !== 'default' ? `?${new URLSearchParams({ batch: label, batch_ref: label })}` : ''
  return `/${project}/commit/${commit.id}${search}`
}


const CommitResults = ({ project, project_data = {}, commit, className, default_batch = "default" }) => {
    let incomplete_data = commit.message === undefined || commit.message === null;
    if (incomplete_data)
      return <span></span>

    const code_url = git_commit_url(project_data, commit.id);
    let batches_with_results = Object.entries(commit.batches)
                               .filter( ([label]) => has_outputs_in_batch(label)(commit) )
                               .map( ([label]) => label )
    let valid_outputs_not_in_default_batch = (!has_outputs_in_batch(default_batch)(commit) && batches_with_results.length>0)
    let ci_batch_label = valid_outputs_not_in_default_batch ? batches_with_results[0] : default_batch
    let ci_batch =  commit.batches[ci_batch_label];

    if (
      ci_batch === undefined ||
      (ci_batch.failed_outputs === 0 &&
        ci_batch.valid_outputs === 0 &&
        ci_batch.pending_outputs === 0)
    )
      return (
        <div className={className}>
        <a style={{ color: "grey" }} href={code_url}>
          <Button intent={Intent.WARNING} minimal>
          
            Check the pipeline status..
          </Button>
        </a>
        <Link
          style={{ marginLeft: "10px" }}
          to={commit_page(project, commit, ci_batch_label)}
        >
          <Button intent={Intent.DANGER} minimal>
            No results
          </Button>
        </Link>
        </div>
      );

    const formatter = v => format(v, {precision: 3})
    let tuning_batches_labels = Object.keys(commit.batches).filter(label => label !== ci_batch_label);

    const { available_metrics={}, default_metric } = project_data.data?.qatools_metrics || {};
    const default_metric_info = available_metrics[default_metric] || {};
    // const default_metric_info = available_metrics['WB_Err_HSV'] || {};
    
    let status_messages = (
      <Fragment>
        {ci_batch.pending_outputs - ci_batch.running_outputs > 0 && (
          <Tag minimal style={{ marginRight: "4px" }}>
            {ci_batch.pending_outputs - ci_batch.running_outputs} pending
          </Tag>
        )}
        {ci_batch.running_outputs > 0 && (
          <Tag
            minimal
            style={{ marginRight: "4px" }}
            intent={Intent.PRIMARY}
          >
            {ci_batch.running_outputs} running
          </Tag>
        )}
        {ci_batch.failed_outputs > 0 && (
          <Link
            style={{ marginLeft: "10px" }}
            to={commit_page(project, commit, ci_batch_label)}
          >
            <Button intent={Intent.DANGER} minimal>
              {ci_batch.failed_outputs} crashed
            </Button>
          </Link>
        )}
        {tuning_batches_labels.length > 0 && (
          <Tooltip inheritDarkTheme={false} hoverCloseDelay={2000} content={<div>
            {tuning_batches_labels.map(label => {
                let batch = commit.batches[label];
                let status = `${batch.valid_outputs}/${batch.valid_outputs+batch.pending_outputs+batch.failed_outputs} ✅`;
                let failures = batch.failed_outputs > 0 ? `${batch.failed_outputs}❌` : "";
                return <Link
                        key={label}
                        to={commit_page(project, commit, label)}
                       >
                  <Button style={{margin: '5px'}}>{pretty_label(batch)} &nbsp;•&nbsp;{status}&nbsp;{failures}</Button>
                </Link>
            })}
            </div>}
          >
            <Tag
              intent={Intent.SUCCESS}
              minimal
              style={{ marginRight: "4px" }}
            >
              {tuning_batches_labels.length} other batch{tuning_batches_labels.length > 1 ? "es" : ""}
            </Tag>
          </Tooltip>
        )}
        {ci_batch.valid_outputs === 0 && <Link
          style={{ marginLeft: "10px" }}
          to={commit_page(project, commit, ci_batch_label)}
        >
          <Button intent={Intent.DANGER} minimal>
            No results
          </Button>
        </Link>}
        {ci_batch.valid_outputs > 0 &&
            <Fragment>
              {ci_batch.aggregated_metrics[`${default_metric_info.key}_median`] !== ci_batch.aggregated_metrics[`${default_metric_info.key}_average`] && <Tag minimal style={{ marginRight: "4px" }}>
                <strong>
                  {formatter(
                    default_metric_info.scale *
                      ci_batch.aggregated_metrics[
                        `${default_metric_info.key}_median`
                      ]
                  )}
                  {default_metric_info.suffix}
                </strong>{" "}
                median{" "}
              </Tag>}
              {ci_batch.aggregated_metrics[`${default_metric_info.key}_median`] !== undefined && <Tag style={{ marginRight: "4px" }} minimal>
                <strong>
                  {formatter(
                    default_metric_info.scale *
                      ci_batch.aggregated_metrics[
                        `${default_metric_info.key}_average`
                      ]
                  )}
                  {default_metric_info.suffix}
                </strong>{" "}
                avg {default_metric_info.short_label}
              </Tag>}
              {Object.keys(ci_batch.aggregated_metrics).length > 2 && <Tooltip modifiers content={<ul className={Classes.LIST}>
                  {Object.entries(ci_batch.aggregated_metrics || {}).map(([k, v]) => (
                    <li key={k}>
                      <strong>{k}:</strong> {formatter(v)}
                    </li>
                  ))}
                </ul>}
              >
                <Tag minimal round>...</Tag>
              </Tooltip>}
            </Fragment>}
      </Fragment>
    );
    return (
      <div className={className}>
        {status_messages}
        {ci_batch.valid_outputs > 0 && (
          <Link
            style={{ marginLeft: "10px" }}
            to={commit_page(project, commit, ci_batch_label)}
          >
            <Button
              intent={Intent.SUCCESS}
              text={`${ci_batch.valid_outputs} ${pretty_label(ci_batch)} result${ci_batch.valid_outputs > 1 ? 's' : ''}`}
            />
          </Link>
        )}
      </div>
    );
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

const CommitRow = ({ commit, project, project_data = {}, className, tag, default_batch }) => {
  const [waiting, setWaiting] = useState(false);
  const refreshCommit = useRefreshCommit();
  const refresh = () => refreshCommit(project, commit.id);

  const git = project_data.data?.git ?? {};
  const is_subproject = git.path_with_namespace !== project;
  const commit_url = git_commit_url(project_data, commit.id)
  const has_data = !!commit?.authored_datetime
  let maybe_skeletton = has_data ? null : Classes.SKELETON;
  const commit_has_milestones = has_milestones({commit, project, project_data})

  const deleteRuns = url => {
    setWaiting(true)
    toaster.show({message: "Delete requested."});
    http.delete(url)
      .then(() => {
        setWaiting(false)
        toaster.show({message: `Deleted ${commit.id}.`, intent: Intent.SUCCESS});
        refresh()
      })
      .catch(error => {
        setWaiting(false)
        toaster.show({message: errorMessage(error), intent: Intent.DANGER});
        refresh()
      });
  }

  return (
    <CommitRowWrapper className={className}>
      <CommitAvatar
        commit={commit}
        project={project}
      />

      <CommitDetails>
        <CommitContent style={{ maxWidth: "600px" }}>
          {tag}
          {commit_has_milestones && <Icon icon="star" style={{color: Colors.GOLD5}} />}
          <Message className={maybe_skeletton}>{has_data ? commit.message : 'xxxxxxxxxx xxxxxx xxxxxxxxx xxxxxxxxxxx'}</Message>
          <div>
            <Tooltip content="View Commit Diff">
              <CommitShortId href={commit_url}>
                {shortId(project, commit.id)}
              </CommitShortId>
            </Tooltip>
            <Tooltip content="Copy to clipboard">
              <Icon
                style={{marginLeft: '4px', marginRight: '4px'}}
                title="Copy hash to clipboard"
                intent={Intent.PRIMARY}
                icon="duplicate"
                onClick={() => copyWithToast(commit.id, { what: 'the commit hash' })}
              />
            </Tooltip>

          <Popover
            placement="bottom"
            hoverCloseDelay={500}
            interactionKind={"hover"}
            content={<Menu>
              <MenuItem text="Copy Directory" label={<Tag minimal>windows</Tag>} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => copyDirectory(commit.artifacts_url, { windows: true })} />
              <MenuItem text="Copy Directory" label={<Tag minimal>linux</Tag>} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => copyDirectory(commit.artifacts_url)} />
              <MenuItem text="View files in browser" rel="noopener noreferrer" target="_blank" href={commit.artifacts_url} className={Classes.TEXT_MUTED} minimal icon="folder-shared-open"/>
              <MenuDivider title="Manage"/>
              <MenuItem
                text="Delete All Runs"
                icon="trash"
                intent={Intent.DANGER}
                disabled={waiting || commit_has_milestones}
                className={Classes.TEXT_MUTED}
                minimal
                onClick={() => deleteRuns(`/api/v1/commit/${project}/${commit.id}/batches/`)}
              />
              {is_subproject && <MenuItem
                text="Delete All Runs (in all other projects for this commit!)"
                icon="trash"
                intent={Intent.DANGER}
                disabled={waiting || commit_has_milestones}
                className={Classes.TEXT_MUTED}
                minimal
                onClick={() => deleteRuns(`/api/v1/commit/${commit.id}/batches/`)}
              />}
            </Menu>}
          >
            <Icon icon="menu" style={{marginLeft: '4px', marginRight: '10px', color: "rgba(0,0,0,0.45)"}}/>
          </Popover>


            <Icon icon="git-branch" />
            <Link
              style={{
                color: "rgba(0,0,0,0.65)",
                marginRight: '5px',
                marginTop: !!commit.message && '4px',
              }}
              to={`/${project}/commits/${(commit.branch || '')}`}
            >
              {(commit.branch || '')}
            </Link>
            <DoneAtTag project={project} commit={commit} />
          </div>
        </CommitContent>

        <CommitResultsStyled project={project} project_data={project_data} commit={commit} default_batch={default_batch}/>
      </CommitDetails>
    </CommitRowWrapper>
  );
}

export default CommitRow;
