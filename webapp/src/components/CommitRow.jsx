import { Fragment, useState } from "react";
import { Link, useLinkClickHandler } from "../router";

import styled from "styled-components";

import {
  Alert,
  AnchorButton,
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
  PopoverNext,
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
import { hasPathMappings } from '../utils/paths'
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

// The commit message's body, after its first line
const MessageBody = styled.div`
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const CommitContent = styled.div`
  padding-right: 10px;
  max-width: 750px;
`;

const CommitRowWrapper = styled.li`
  display: flex;
  border-color: var(--qa-border);
  font-size: 14px;
  color: var(--qa-text);
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




// A router link that looks like a button: a <Button> inside a <Link> would make two tab stops
const LinkButton = ({ to, ...props }) => {
  const handleClick = useLinkClickHandler(to)
  return <AnchorButton {...props} href={to} onClick={handleClick}/>
}


// A router link that looks like a minimal tag, e.g. "2 failed" next to the other tags
const LinkTag = ({ to, intent, style, children }) => {
  const handleClick = useLinkClickHandler(to)
  return <a
    href={to}
    onClick={handleClick}
    style={style}
    className={[Classes.TAG, Classes.MINIMAL, Classes.INTERACTIVE, Classes.intentClass(intent)].filter(Boolean).join(' ')}
  >
    <span className={Classes.TEXT_OVERFLOW_ELLIPSIS}>{children}</span>
  </a>
}

const runs = n => `${n} run${n === 1 ? '' : 's'}`
const status_icon_style = { marginLeft: '3px', verticalAlign: '-1px' }


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
        <AnchorButton variant="minimal" href={code_url} text="View the commit" endIcon="share" />
        {commit.is_recent
          ? <Tooltip content={<span>The CI may still be running: results appear once <code>qa batch</code> uploads them.</span>}>
              <Tag minimal icon="time" style={{ marginLeft: "10px" }}>Waiting for results</Tag>
            </Tooltip>
          : <Tooltip content="No run was uploaded for this commit. Check its CI pipeline.">
              <LinkButton
                style={{ marginLeft: "10px" }}
                to={commit_page(project, commit, ci_batch_label)}
                className={Classes.TEXT_MUTED}
                variant="minimal"
                text="No results"
              />
            </Tooltip>}
        </div>
      );

    const formatter = v => format(v, {precision: 3})
    let tuning_batches_labels = Object.keys(commit.batches).filter(label => label !== ci_batch_label);

    const { available_metrics={}, default_metric } = project_data.data?.qatools_metrics || {};
    const default_metric_info = available_metrics[default_metric] || {};
    const aggregate_tooltip = aggregate => `${default_metric_info.label ?? default_metric_info.key}: ${aggregate} over the ${ci_batch.valid_outputs} runs of ${pretty_label(ci_batch)}`
    // const default_metric_info = available_metrics['WB_Err_HSV'] || {};
    
    let status_messages = (
      <Fragment>
        {ci_batch.pending_outputs - ci_batch.running_outputs > 0 && (
          <Tooltip content="Waiting for a runner">
            <Tag minimal style={{ marginRight: "4px" }}>
              {ci_batch.pending_outputs - ci_batch.running_outputs} pending
            </Tag>
          </Tooltip>
        )}
        {ci_batch.running_outputs > 0 && (
          <Tooltip content="Running now">
            <Tag
              minimal
              style={{ marginRight: "4px" }}
              intent={Intent.PRIMARY}
            >
              {ci_batch.running_outputs} running
            </Tag>
          </Tooltip>
        )}
        {ci_batch.failed_outputs > 0 && (
          <Tooltip content="Failed: open the logs to see why">
            <LinkTag
              to={commit_page(project, commit, ci_batch_label)}
              intent={Intent.DANGER}
              style={{ marginRight: "4px" }}
            >
              {ci_batch.failed_outputs} failed
            </LinkTag>
          </Tooltip>
        )}
        {tuning_batches_labels.length > 0 && (
          <Tooltip inheritDarkTheme={false} hoverCloseDelay={2000} content={<div>
            {tuning_batches_labels.map(label => {
                let batch = commit.batches[label];
                const total = batch.valid_outputs + batch.pending_outputs + batch.failed_outputs;
                return <LinkButton
                        key={label}
                        to={commit_page(project, commit, label)}
                        style={{margin: '5px'}}
                       >
                  {pretty_label(batch)} &nbsp;•&nbsp;
                  <span title={`${batch.valid_outputs} of ${total} run${total === 1 ? '' : 's'} finished`}>
                    {batch.valid_outputs}/{total}<Icon icon="tick-circle" size={12} intent={Intent.SUCCESS} style={status_icon_style}/>
                  </span>
                  {batch.failed_outputs > 0 && <span title={`${batch.failed_outputs} failed`} style={{marginLeft: '8px'}}>
                    {batch.failed_outputs}<Icon icon="error" size={12} intent={Intent.DANGER} style={status_icon_style}/>
                  </span>}
                </LinkButton>
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
        {ci_batch.valid_outputs === 0 && <LinkButton
          style={{ marginLeft: "10px" }}
          to={commit_page(project, commit, ci_batch_label)}
          className={Classes.TEXT_MUTED}
          variant="minimal"
          text="No results"
        />}
        {ci_batch.valid_outputs > 0 &&
            <Fragment>
              {ci_batch.aggregated_metrics[`${default_metric_info.key}_median`] !== ci_batch.aggregated_metrics[`${default_metric_info.key}_average`] && <Tooltip content={aggregate_tooltip('median')}><Tag minimal style={{ marginRight: "4px" }}>
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
              </Tag></Tooltip>}
              {ci_batch.aggregated_metrics[`${default_metric_info.key}_median`] !== undefined && <Tooltip content={aggregate_tooltip('average')}><Tag style={{ marginRight: "4px" }} minimal>
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
              </Tag></Tooltip>}
              {Object.keys(ci_batch.aggregated_metrics).length > 2 && <Tooltip content={<>
                <strong>All aggregated metrics</strong>
                <ul className={Classes.LIST}>
                  {Object.entries(ci_batch.aggregated_metrics || {}).map(([k, v]) => (
                    <li key={k}>
                      <strong>{k}:</strong> {formatter(v)}
                    </li>
                  ))}
                </ul>
              </>}
              >
                <Tag minimal round aria-label="All aggregated metrics">…</Tag>
              </Tooltip>}
            </Fragment>}
      </Fragment>
    );
    return (
      <div className={className}>
        {status_messages}
        {ci_batch.valid_outputs > 0 && (
          <Tooltip content={`Open the ${runs(ci_batch.valid_outputs)} of the ${pretty_label(ci_batch)} batch`}>
            <LinkButton
              style={{ marginLeft: "6px" }}
              to={commit_page(project, commit, ci_batch_label)}
              variant="outlined"
              size="small"
              text={runs(ci_batch.valid_outputs)}
            />
          </Tooltip>
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
  font-weight: 500;
  color: var(--qa-link);
`;

const CommitRow = ({ commit, project, project_data = {}, className, tag, default_batch }) => {
  const [waiting, setWaiting] = useState(false);
  // the runs users asked to delete, until they confirm: {url, all_projects}
  const [confirm_delete, setConfirmDelete] = useState(null);
  const refreshCommit = useRefreshCommit();
  const refresh = () => refreshCommit(project, commit.id);

  const git = project_data.data?.git ?? {};
  const is_subproject = git.path_with_namespace !== project;
  const commit_url = git_commit_url(project_data, commit.id)
  const has_data = !!commit?.authored_datetime
  let maybe_skeletton = has_data ? null : Classes.SKELETON;
  const commit_has_milestones = has_milestones({commit, project, project_data})
  const [message_title, ...message_body_lines] = (commit.message ?? '').split(/\r?\n/)
  const message_body = message_body_lines.join('\n').trim()

  const short_id = shortId(project, commit.id)
  const deleteRuns = ({ url, all_projects }) => {
    setConfirmDelete(null)
    setWaiting(true)
    const what = `all the runs of ${short_id}${all_projects ? ' in all projects' : ''}`
    toaster.show({message: `Deleting ${what}…`, icon: 'time'}, 'delete-commit');
    http.delete(url)
      .then(() => {
        setWaiting(false)
        toaster.show({message: `Deleted ${what}`, intent: Intent.SUCCESS}, 'delete-commit');
        refresh()
      })
      .catch(error => {
        setWaiting(false)
        toaster.show({message: `Could not delete ${what}: ${errorMessage(error)}`, intent: Intent.DANGER}, 'delete-commit');
        refresh()
      });
  }
  const milestones_title = commit_has_milestones ? "Commits with milestones can't be deleted: remove the milestones first." : undefined

  return (
    <CommitRowWrapper className={className}>
      <CommitAvatar
        commit={commit}
        project={project}
      />

      <CommitDetails>
        <CommitContent style={{ maxWidth: "600px" }}>
          {tag}
          {commit_has_milestones && <Tooltip content="This commit is a milestone">
            <Icon icon="star" style={{color: Colors.GOLD5}} aria-label="This commit is a milestone" />
          </Tooltip>}
          <Message className={maybe_skeletton}>{has_data ? message_title : 'xxxxxxxxxx xxxxxx xxxxxxxxx xxxxxxxxxxx'}</Message>
          {has_data && !!message_body && <MessageBody className={Classes.TEXT_MUTED} title={message_body}>{message_body}</MessageBody>}
          <div>
            <Tooltip content="View the commit's diff">
              <CommitShortId href={commit_url}>
                {short_id}
              </CommitShortId>
            </Tooltip>
            <Tooltip content="Copy the commit hash">
              <Button
                style={{marginLeft: '2px'}}
                variant="minimal"
                size="small"
                className={Classes.TEXT_MUTED}
                icon="duplicate"
                aria-label="Copy the commit hash"
                onClick={() => copyWithToast(commit.id, { what: 'the commit hash' })}
              />
            </Tooltip>

          <PopoverNext
            placement="bottom"
            content={<Menu>
              {hasPathMappings() && <MenuItem text="Copy directory" label={<Tag minimal>windows</Tag>} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => copyDirectory(commit.artifacts_url, { windows: true })} />}
              <MenuItem text="Copy directory" label={hasPathMappings() ? <Tag minimal>linux</Tag> : undefined} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => copyDirectory(commit.artifacts_url)} />
              <MenuItem text="View in browser" rel="noopener noreferrer" target="_blank" href={commit.artifacts_url} className={Classes.TEXT_MUTED} minimal icon="folder-shared-open"/>
              <MenuDivider title="Manage"/>
              <MenuItem
                text="Delete all runs…"
                icon="trash"
                intent={Intent.DANGER}
                disabled={waiting || commit_has_milestones}
                htmlTitle={milestones_title}
                className={Classes.TEXT_MUTED}
                minimal
                onClick={() => setConfirmDelete({url: `/api/v1/commit/${project}/${commit.id}/batches/`})}
              />
              {is_subproject && <MenuItem
                text="Delete all runs, in all the projects with this commit…"
                icon="trash"
                intent={Intent.DANGER}
                disabled={waiting || commit_has_milestones}
                htmlTitle={milestones_title}
                className={Classes.TEXT_MUTED}
                minimal
                onClick={() => setConfirmDelete({url: `/api/v1/commit/${commit.id}/batches/`, all_projects: true})}
              />}
            </Menu>}
          >
            <Button
              style={{marginRight: '6px'}}
              variant="minimal"
              size="small"
              icon="menu"
              className={Classes.TEXT_MUTED}
              aria-label="Commit actions"
            />
          </PopoverNext>
          <Alert
            isOpen={confirm_delete !== null}
            icon="trash"
            intent={Intent.DANGER}
            cancelButtonText="Cancel"
            confirmButtonText="Delete runs"
            canEscapeKeyCancel
            onCancel={() => setConfirmDelete(null)}
            onConfirm={() => deleteRuns(confirm_delete)}
          >
            <p><strong>Delete all the runs of {short_id}{confirm_delete?.all_projects ? ', in all projects' : ''}?</strong></p>
            <p>Their output files and metrics will be deleted. This can't be undone.</p>
          </Alert>


            <Icon icon="git-branch" style={{ marginRight: '4px' }} />
            <Link
              style={{
                color: "var(--qa-text-secondary)",
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
