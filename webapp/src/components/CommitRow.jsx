import { Fragment, memo, useState } from "react";
import { Link, useLinkClickHandler } from "../router";

import styled, { css } from "styled-components";
import { DateTime } from "luxon";

import {
  Alert,
  AnchorButton,
  Classes,
  Button,
  Colors,
  Icon,
  Intent,
  Tag,
  Menu,
  MenuDivider,
  MenuItem,
} from "@blueprintjs/core";

import { http, errorMessage } from "../api/http";
import { usePrefetchCommitPage, useRefreshCommit, useUser } from "../hooks";
import { LoginMenuItem } from "./authentication/login";
import { CommitAvatar } from "./avatars";
import { DoneAtTag } from "./DoneAtTag";
import { LazyPopover, LazyTooltip } from "./LazyPopover";
import { format, shortId, pretty_label, metric_info } from "../utils";
import { commit_url as git_commit_url } from "../git"
import { milestones_of, milestone_name } from '../milestones/api'
import { useMilestones } from '../milestones/hooks'
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
const LinkTag = ({ to, intent, style, children, ref }) => {
  const handleClick = useLinkClickHandler(to)
  return <a
    ref={ref}
    href={to}
    onClick={handleClick}
    style={style}
    className={[Classes.TAG, Classes.MINIMAL, Classes.INTERACTIVE, Classes.intentClass(intent)].filter(Boolean).join(' ')}
  >
    <span className={Classes.TEXT_OVERFLOW_ELLIPSIS}>{children}</span>
  </a>
}

// The batch we show for a commit: the default batch (usually the CI's), unless only other batches have runs
const ci_batch_of = (commit, default_batch = "default") => {
  const batches_with_results = Object.keys(commit.batches ?? {}).filter(label => has_outputs_in_batch(label)(commit));
  const label = (!has_outputs_in_batch(default_batch)(commit) && batches_with_results.length > 0) ? batches_with_results[0] : default_batch;
  return { label, batch: commit.batches?.[label] };
}

const runs = n => `${n} run${n === 1 ? '' : 's'}`
const status_icon_style = { marginLeft: '3px', verticalAlign: '-1px' }


// Links to the commit's other batches (tuning, local runs...), in the tooltip of "N other batches"
const OtherBatches = ({ project, commit, labels }) => <div>
  {labels.map(label => {
    const batch = commit.batches[label];
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
</div>

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
    const { label: ci_batch_label, batch: ci_batch } = ci_batch_of(commit, default_batch);

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
          ? <LazyTooltip content={<span>The CI may still be running: results appear once <code>qa batch</code> uploads them.</span>}>
              <Tag minimal icon="time" style={{ marginLeft: "10px" }}>Waiting for results</Tag>
            </LazyTooltip>
          : <LazyTooltip content="No run was uploaded for this commit. Check its CI pipeline.">
              <LinkButton
                style={{ marginLeft: "10px" }}
                to={commit_page(project, commit, ci_batch_label)}
                className={Classes.TEXT_MUTED}
                variant="minimal"
                text="No results"
              />
            </LazyTooltip>}
        </div>
      );

    const formatter = v => format(v, {precision: 3})
    let tuning_batches_labels = Object.keys(commit.batches).filter(label => label !== ci_batch_label);

    const { available_metrics={}, default_metric } = project_data.data?.qatools_metrics || {};
    const default_metric_info = default_metric ? metric_info(available_metrics, default_metric) : {};
    const aggregate_tooltip = aggregate => `${default_metric_info.label ?? default_metric_info.key}: ${aggregate} over the ${ci_batch.valid_outputs} runs of ${pretty_label(ci_batch)}`
    // const default_metric_info = available_metrics['WB_Err_HSV'] || {};
    
    let status_messages = (
      <Fragment>
        {ci_batch.pending_outputs - ci_batch.running_outputs > 0 && (
          <LazyTooltip content="Waiting for a runner">
            <Tag minimal style={{ marginRight: "4px" }}>
              {ci_batch.pending_outputs - ci_batch.running_outputs} pending
            </Tag>
          </LazyTooltip>
        )}
        {ci_batch.running_outputs > 0 && (
          <LazyTooltip content="Running now">
            <Tag
              minimal
              style={{ marginRight: "4px" }}
              intent={Intent.PRIMARY}
            >
              {ci_batch.running_outputs} running
            </Tag>
          </LazyTooltip>
        )}
        {ci_batch.failed_outputs > 0 && (
          <LazyTooltip content="Failed: open the logs to see why">
            <LinkTag
              to={commit_page(project, commit, ci_batch_label)}
              intent={Intent.DANGER}
              style={{ marginRight: "4px" }}
            >
              {ci_batch.failed_outputs} failed
            </LinkTag>
          </LazyTooltip>
        )}
        {tuning_batches_labels.length > 0 && (
          <LazyTooltip inheritDarkTheme={false} hoverCloseDelay={2000} content={<OtherBatches project={project} commit={commit} labels={tuning_batches_labels}/>}>
            <Tag
              intent={Intent.SUCCESS}
              minimal
              style={{ marginRight: "4px" }}
            >
              {tuning_batches_labels.length} other batch{tuning_batches_labels.length > 1 ? "es" : ""}
            </Tag>
          </LazyTooltip>
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
              {ci_batch.aggregated_metrics[`${default_metric_info.key}_median`] !== ci_batch.aggregated_metrics[`${default_metric_info.key}_average`] && <LazyTooltip content={aggregate_tooltip('median')}><Tag minimal style={{ marginRight: "4px" }}>
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
              </Tag></LazyTooltip>}
              {ci_batch.aggregated_metrics[`${default_metric_info.key}_median`] !== undefined && <LazyTooltip content={aggregate_tooltip('average')}><Tag style={{ marginRight: "4px" }} minimal>
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
              </Tag></LazyTooltip>}
              {/* more than the main metric's median, average and sum */}
              {Object.keys(ci_batch.aggregated_metrics).length > 3 && <LazyTooltip content={<>
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
              </LazyTooltip>}
            </Fragment>}
      </Fragment>
    );
    return (
      <div className={className}>
        {status_messages}
        {ci_batch.valid_outputs > 0 && (
          <LazyTooltip content={`Open the ${runs(ci_batch.valid_outputs)} of the ${pretty_label(ci_batch)} batch`}>
            <LinkButton
              style={{ marginLeft: "6px" }}
              to={commit_page(project, commit, ci_batch_label)}
              variant="outlined"
              size="small"
              text={runs(ci_batch.valid_outputs)}
            />
          </LazyTooltip>
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


// The ☰ menu of a commit: copy its directory, browse its files, delete its runs.
// Lists have one per commit: the menu and the confirmation are only created when needed.
const CommitMenu = ({ commit, project, project_data = {}, style }) => {
  const [waiting, setWaiting] = useState(false);
  const is_logged = useUser().is_logged;
  // the runs users asked to delete, until they confirm: {url, all_projects, open}.
  // The alert is only rendered from then until it has closed.
  const [confirm_delete, setConfirmDelete] = useState(null);
  const closeConfirmation = () => setConfirmDelete({ ...confirm_delete, open: false });
  const refreshCommit = useRefreshCommit();
  const refresh = () => refreshCommit(project, commit.id);

  const git = project_data.data?.git ?? {};
  const is_subproject = git.path_with_namespace !== project;
  const commit_milestones = milestones_of(useMilestones(project), {project, commit: commit.id})
  const short_id = shortId(project, commit.id)
  const deleteRuns = ({ url, all_projects }) => {
    closeConfirmation()
    setWaiting(true)
    const what = `all the runs of ${short_id}${all_projects ? ' in all projects' : ''}`
    toaster.show({message: `Deleting ${what}…`, icon: 'time'}, 'delete-commit');
    http.delete(url)
      .then(({ data }) => {
        setWaiting(false)
        const kept = data?.kept?.length ? ` (kept the milestone batch${data.kept.length > 1 ? 'es' : ''}: ${data.kept.map(label => pretty_label({label})).join(', ')})` : ''
        toaster.show({message: `Deleted ${what}${kept}`, intent: Intent.SUCCESS}, 'delete-commit');
        refresh()
      })
      .catch(error => {
        setWaiting(false)
        toaster.show({message: `Could not delete ${what}: ${errorMessage(error)}`, intent: Intent.DANGER}, 'delete-commit');
        refresh()
      });
  }
  const milestones_title = commit_milestones.length > 0 ? `The batches that are milestones are kept: ${[...new Set(commit_milestones.map(m => pretty_label({label: m.batch || 'default'})))].join(', ')}` : undefined

  return <>
    <LazyPopover
      placement="bottom"
      content={<Menu>
        {hasPathMappings() && <MenuItem text="Copy directory" label={<Tag minimal>windows</Tag>} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => copyDirectory(commit.artifacts_url, { windows: true })} />}
        <MenuItem text="Copy directory" label={hasPathMappings() ? <Tag minimal>linux</Tag> : undefined} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => copyDirectory(commit.artifacts_url)} />
        <MenuItem text="View in browser" rel="noopener noreferrer" target="_blank" href={commit.artifacts_url} className={Classes.TEXT_MUTED} minimal icon="folder-shared-open"/>
        <MenuDivider title="Manage"/>
        {!is_logged && <LoginMenuItem text="Sign in to delete runs"/>}
        <MenuItem
          text={commit_milestones.length > 0 ? "Delete all runs, except milestones…" : "Delete all runs…"}
          icon="trash"
          intent={Intent.DANGER}
          disabled={waiting || !is_logged}
          htmlTitle={milestones_title}
          className={Classes.TEXT_MUTED}
          minimal
          onClick={() => setConfirmDelete({url: `/api/v1/commit/${project}/${commit.id}/batches/`, open: true})}
        />
        {is_subproject && <MenuItem
          text="Delete all runs, in all the projects with this commit…"
          icon="trash"
          intent={Intent.DANGER}
          disabled={waiting || !is_logged}
          htmlTitle={milestones_title}
          className={Classes.TEXT_MUTED}
          minimal
          onClick={() => setConfirmDelete({url: `/api/v1/commit/${commit.id}/batches/`, all_projects: true, open: true})}
        />}
      </Menu>}
    >
      <Button
        style={style}
        variant="minimal"
        size="small"
        icon="menu"
        className={Classes.TEXT_MUTED}
        aria-label="Commit actions"
      />
    </LazyPopover>
    {confirm_delete && <Alert
      isOpen={confirm_delete.open}
      icon="trash"
      intent={Intent.DANGER}
      cancelButtonText="Cancel"
      confirmButtonText="Delete runs"
      canEscapeKeyCancel
      onCancel={closeConfirmation}
      onConfirm={() => deleteRuns(confirm_delete)}
      onClosed={() => setConfirmDelete(null)}
    >
      <p><strong>Delete all the runs of {short_id}{confirm_delete.all_projects ? ', in all projects' : ''}?</strong></p>
      <p>Their output files and metrics will be deleted. This can't be undone.</p>
      {!!milestones_title && <p>{milestones_title}.</p>}
    </Alert>}
  </>
}

const CopyHashButton = ({ commit, className, style }) => <LazyTooltip content="Copy the commit hash">
  <Button
    style={style}
    variant="minimal"
    size="small"
    className={[Classes.TEXT_MUTED, className].filter(Boolean).join(' ')}
    icon="duplicate"
    aria-label="Copy the commit hash"
    onClick={() => copyWithToast(commit.id, { what: 'the commit hash' })}
  />
</LazyTooltip>

const MilestoneStar = ({ milestones }) => <LazyTooltip content={<span>Milestone{milestones.length > 1 ? 's' : ''}: {milestones.map(milestone_name).join(', ')}</span>}>
  <Icon icon="star" style={{color: Colors.GOLD5}} aria-label={`Milestone${milestones.length > 1 ? 's' : ''}: ${milestones.map(milestone_name).join(', ')}`} />
</LazyTooltip>


// A few lines per commit: its message, its body's first line, hash, branch, date and committer, then its CI batch's results
const ComfortableCommitRow = ({ commit, project, project_data = {}, className, tag, default_batch }) => {
  const commit_url = git_commit_url(project_data, commit.id)
  const has_data = !!commit?.authored_datetime
  let maybe_skeletton = has_data ? null : Classes.SKELETON;
  const commit_milestones = milestones_of(useMilestones(project), {project, commit: commit.id})
  const [message_title, ...message_body_lines] = (commit.message ?? '').split(/\r?\n/)
  const message_body = message_body_lines.join('\n').trim()
  const short_id = shortId(project, commit.id)
  const prefetch = usePrefetchCommitPage(project, has_data ? commit.id : null)

  return (
    <CommitRowWrapper className={className} {...prefetch}>
      <CommitAvatar
        commit={commit}
        project={project}
      />

      <CommitDetails>
        <CommitContent style={{ maxWidth: "600px" }}>
          {tag}
          {commit_milestones.length > 0 && <MilestoneStar milestones={commit_milestones}/>}
          <Message className={maybe_skeletton}>{has_data ? message_title : 'xxxxxxxxxx xxxxxx xxxxxxxxx xxxxxxxxxxx'}</Message>
          {has_data && !!message_body && <MessageBody className={Classes.TEXT_MUTED} title={message_body}>{message_body}</MessageBody>}
          <div>
            <LazyTooltip content="View the commit's diff">
              <CommitShortId href={commit_url}>
                {short_id}
              </CommitShortId>
            </LazyTooltip>
            <CopyHashButton commit={commit} style={{marginLeft: '2px'}}/>
            <CommitMenu commit={commit} project={project} project_data={project_data} style={{marginRight: '6px'}}/>

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


// Compact rows: one line per commit, in columns shared by all the rows of a list (see CompactCommitList).
// Set on the list, so that every row's columns line up, like a table's.
// The message keeps some room: on smaller screens, the branch shrinks first, then less important details go away.
const compact_columns = {
  // status, hash, message, branch, committer, date, results, actions
  wide: 'max-content max-content minmax(10rem, 1fr) minmax(0, 10rem) minmax(0, 9rem) max-content minmax(13rem, max-content) max-content',
  // the committer's avatar without their name, the main metric without its name
  medium: 'max-content max-content minmax(10rem, 1fr) minmax(0, 8rem) max-content max-content max-content max-content',
  // no date, no main metric
  narrow: 'max-content max-content minmax(8rem, 1fr) minmax(0, 6rem) max-content max-content max-content',
}
// By the list's width, not the window's: compact lists must be in a <CompactListContainer>
const compact_medium = 'commit-list (max-width: 860px)'
const compact_narrow = 'commit-list (max-width: 560px)'
export const CompactListContainer = styled.div`
  container: commit-list / inline-size;
`;

// The columns of compact rows. A parent can share them with several lists, with: ul { grid-template-columns: subgrid }
export const compact_columns_css = css`
  display: grid;
  grid-template-columns: ${compact_columns.wide};
  column-gap: 12px;
  @container ${compact_medium} {
    grid-template-columns: ${compact_columns.medium};
  }
  @container ${compact_narrow} {
    grid-template-columns: ${compact_columns.narrow};
  }
`;

export const CompactCommitList = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  ${compact_columns_css}
`;

const CompactRowWrapper = styled.li`
  display: grid;
  grid-column: 1 / -1;
  /* without subgrid, each row has its own columns */
  grid-template-columns: ${compact_columns.wide};
  grid-template-columns: subgrid;
  align-items: center;
  min-height: 32px;
  padding: 2px 6px;
  margin: 0 -6px;
  border-top: 1px solid var(--qa-border);
  border-radius: 3px;
  font-size: 13px;
  color: var(--qa-text);
  &:first-child {
    border-top-color: transparent;
  }
  &:hover {
    background: var(--qa-hover);
  }
  @container ${compact_medium} {
    grid-template-columns: ${compact_columns.medium};
    grid-template-columns: subgrid;
    .compact-metric-name {
      display: none;
    }
  }
  @container ${compact_narrow} {
    grid-template-columns: ${compact_columns.narrow};
    grid-template-columns: subgrid;
    .compact-date, .compact-metric {
      display: none;
    }
  }
`;

// Cells that cut what doesn't fit with an ellipsis
const Ellipsis = styled.span`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const CompactMessage = styled(Ellipsis)`
  font-weight: 600;
  .${Classes.ICON} {
    margin-right: 4px;
    vertical-align: -2px;
  }
`;

const CompactLink = styled(Link)`
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  /* more specific than Blueprint's dark links */
  && {
    color: var(--qa-text-secondary);
  }
`;

const CommitterName = styled(Ellipsis)`
  @container ${compact_medium} {
    display: none;
  }
`;

const CompactCell = styled.span`
  display: flex;
  align-items: center;
  min-width: 0;
`;

const CompactResultsCell = styled.span`
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  white-space: nowrap;
`;

// Copying the hash is only offered on the row users point at, or move to with the keyboard
const RowActions = styled.span`
  display: flex;
  align-items: center;
  .copy-hash {
    opacity: 0;
  }
  li:hover & .copy-hash, & .copy-hash:focus-visible {
    opacity: 1;
  }
  @media (hover: none) {
    .copy-hash {
      opacity: 1;
    }
  }
`;


// The status of the commit's CI batch, as an icon: finished, failed, running, waiting...
export const commit_status = (commit, default_batch) => {
  const { batch } = ci_batch_of(commit, default_batch);
  const { valid_outputs = 0, pending_outputs = 0, running_outputs = 0, failed_outputs = 0 } = batch ?? {};
  const waiting_outputs = pending_outputs - running_outputs;
  if (failed_outputs > 0)
    return { icon: 'error', intent: Intent.DANGER, label: `${failed_outputs} failed${valid_outputs > 0 ? `, ${valid_outputs} finished` : ''}` };
  if (pending_outputs > 0)
    return { icon: 'time', intent: Intent.PRIMARY, label: [running_outputs > 0 && `${running_outputs} running`, waiting_outputs > 0 && `${waiting_outputs} waiting for a runner`, valid_outputs > 0 && `${valid_outputs} finished`].filter(Boolean).join(', ') };
  if (valid_outputs > 0)
    return { icon: 'tick-circle', intent: Intent.SUCCESS, label: `${runs(valid_outputs)} finished` };
  if (commit.is_recent)
    return { icon: 'time', label: 'Waiting for results' };
  return { icon: 'circle', label: 'No results' };
}

const CommitStatusIcon = ({ commit, default_batch }) => {
  if (!commit?.authored_datetime)
    return <span className={Classes.SKELETON} style={{ display: 'inline-block', width: 16, height: 16 }}/>;
  const { icon, intent, label } = commit_status(commit, default_batch);
  return <LazyTooltip content={label}>
    <Icon icon={icon} intent={intent} title={label} className={intent ? undefined : Classes.TEXT_MUTED} style={{ display: 'flex' }}/>
  </LazyTooltip>;
}

// The CI batch's results, on one line: what's still running or failed, the main metric, and a link to the runs.
// What doesn't fit (the median, all the aggregated metrics, other batches) is in tooltips.
const CompactCommitResults = ({ project, project_data = {}, commit, default_batch = "default" }) => {
  if (commit.message === undefined || commit.message === null)
    return null;
  const { label: ci_batch_label, batch: ci_batch } = ci_batch_of(commit, default_batch);
  const page = commit_page(project, commit, ci_batch_label);
  if (ci_batch === undefined || (ci_batch.failed_outputs === 0 && ci_batch.valid_outputs === 0 && ci_batch.pending_outputs === 0))
    return commit.is_recent
      ? <LazyTooltip content={<span>The CI may still be running: results appear once <code>qa batch</code> uploads them.</span>}>
          <Tag minimal icon="time">Waiting for results</Tag>
        </LazyTooltip>
      : <LazyTooltip content="No run was uploaded for this commit. Check its CI pipeline.">
          <LinkButton to={page} className={Classes.TEXT_MUTED} variant="minimal" size="small" text="No results"/>
        </LazyTooltip>;

  const formatter = v => format(v, {precision: 3})
  const waiting_outputs = ci_batch.pending_outputs - ci_batch.running_outputs;
  const other_batches = Object.keys(commit.batches).filter(label => label !== ci_batch_label);
  const { available_metrics={}, default_metric } = project_data.data?.qatools_metrics || {};
  const metric = default_metric ? metric_info(available_metrics, default_metric) : {};
  const aggregated_metrics = ci_batch.aggregated_metrics ?? {};
  const median = aggregated_metrics[`${metric.key}_median`];
  const average = aggregated_metrics[`${metric.key}_average`];
  const value = v => <>{formatter(metric.scale * v)}{metric.suffix}</>;
  const nb_aggregated_metrics = Object.keys(aggregated_metrics).length;
  const metrics_tooltip = <>
    {median !== undefined && <>
      <strong>{metric.label ?? metric.key}</strong> over the {runs(ci_batch.valid_outputs)} of {pretty_label(ci_batch)}
      <ul className={Classes.LIST}>
        <li>median: {value(median)}</li>
        <li>average: {value(average)}</li>
      </ul>
    </>}
    {nb_aggregated_metrics > 2 && <>
      <strong>All aggregated metrics</strong>
      <ul className={Classes.LIST}>
        {Object.entries(aggregated_metrics).map(([k, v]) => <li key={k}><strong>{k}:</strong> {formatter(v)}</li>)}
      </ul>
    </>}
  </>;

  return <>
    {waiting_outputs > 0 && <LazyTooltip content="Waiting for a runner">
      <Tag minimal>{waiting_outputs} pending</Tag>
    </LazyTooltip>}
    {ci_batch.running_outputs > 0 && <LazyTooltip content="Running now">
      <Tag minimal intent={Intent.PRIMARY}>{ci_batch.running_outputs} running</Tag>
    </LazyTooltip>}
    {ci_batch.failed_outputs > 0 && <LazyTooltip content="Failed: open the logs to see why">
      <LinkTag to={page} intent={Intent.DANGER}>{ci_batch.failed_outputs} failed</LinkTag>
    </LazyTooltip>}
    {other_batches.length > 0 && <LazyTooltip inheritDarkTheme={false} hoverCloseDelay={2000} content={<OtherBatches project={project} commit={commit} labels={other_batches}/>}>
      <Tag minimal intent={Intent.SUCCESS}>+{other_batches.length} batch{other_batches.length > 1 ? "es" : ""}</Tag>
    </LazyTooltip>}
    {ci_batch.valid_outputs > 0 && median !== undefined && <LazyTooltip content={metrics_tooltip} className="compact-metric">
      <Tag minimal><strong>{value(average)}</strong><span className="compact-metric-name"> avg {metric.short_label}</span></Tag>
    </LazyTooltip>}
    {ci_batch.valid_outputs > 0 && median === undefined && nb_aggregated_metrics > 2 && <LazyTooltip content={metrics_tooltip} className="compact-metric">
      <Tag minimal round aria-label="All aggregated metrics">…</Tag>
    </LazyTooltip>}
    {ci_batch.valid_outputs > 0
      ? <LazyTooltip content={`Open the ${runs(ci_batch.valid_outputs)} of the ${pretty_label(ci_batch)} batch`}>
          <LinkButton to={page} variant="outlined" size="small" text={runs(ci_batch.valid_outputs)}/>
        </LazyTooltip>
      : <LinkButton to={page} className={Classes.TEXT_MUTED} variant="minimal" size="small" text="No results"/>}
  </>;
}

const skeleton_text = text => <span className={Classes.SKELETON}>{text}</span>

// One line per commit: status, hash, message, branch, committer, date, results, actions
const CompactCommitRow = ({ commit, project, project_data = {}, className, tag, default_batch }) => {
  const has_data = !!commit?.authored_datetime
  const commit_milestones = milestones_of(useMilestones(project), {project, commit: has_data ? commit.id : null})
  const message = commit.message ?? ''
  const [message_title] = message.split(/\r?\n/)
  const short_id = shortId(project, commit.id)
  const date = DateTime.fromISO(commit.authored_datetime ?? '', { zone: 'utc' })
  const committer = commit.committer_name
  const prefetch = usePrefetchCommitPage(project, has_data ? commit.id : null)

  return (
    <CompactRowWrapper className={className} {...prefetch}>
      <CompactCell><CommitStatusIcon commit={commit} default_batch={default_batch}/></CompactCell>
      <LazyTooltip content="View the commit's diff">
        <CommitShortId href={git_commit_url(project_data, commit.id)} className={has_data ? undefined : Classes.SKELETON}>
          {short_id}
        </CommitShortId>
      </LazyTooltip>
      <CompactMessage title={has_data ? message.trim() : undefined}>
        {tag}
        {commit_milestones.length > 0 && <MilestoneStar milestones={commit_milestones}/>}
        {has_data ? message_title : skeleton_text('xxxxxxxxxx xxxxxx xxxxxxxxx xxxxxxxxxxx')}
      </CompactMessage>
      {has_data
        ? <CompactLink to={`/${project}/commits/${commit.branch || ''}`} title={commit.branch}>
            <Icon icon="git-branch" size={12}/>
            <Ellipsis>{commit.branch || ''}</Ellipsis>
          </CompactLink>
        : skeleton_text('xxxxxxxx')}
      {has_data
        ? <CompactLink to={`/${project}/committer/${committer}`} title={committer} aria-label={committer}>
            {/* the name says who it is: the picture is decoration */}
            <span aria-hidden="true"><CommitAvatar commit={commit} size="20px"/></span>
            <CommitterName>{committer}</CommitterName>
          </CompactLink>
        : skeleton_text('xxxxxxxxx')}
      <span className={`${Classes.TEXT_MUTED} compact-date`} style={{ whiteSpace: 'nowrap' }} title={date.isValid ? date.toLocal().toLocaleString(DateTime.DATETIME_MED) : undefined}>
        {has_data ? date.toRelative({ style: 'short' }) : skeleton_text('xx hours ago')}
      </span>
      <CompactResultsCell>
        {has_data && <CompactCommitResults project={project} project_data={project_data} commit={commit} default_batch={default_batch}/>}
      </CompactResultsCell>
      <RowActions>
        <CopyHashButton commit={commit} className="copy-hash"/>
        <CommitMenu commit={commit} project={project} project_data={project_data}/>
      </RowActions>
    </CompactRowWrapper>
  );
}


// density: "comfortable" (default) or "compact". Compact rows must be in a <CompactCommitList>.
const CommitRow = ({ density = "comfortable", ...props }) => density === "compact"
  ? <CompactCommitRow {...props}/>
  : <ComfortableCommitRow {...props}/>;

// Lists render all their rows again when a page of commits loads: those already there don't change
export default memo(CommitRow);
