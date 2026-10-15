import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  Alert,
  Classes,
  Intent,
  Menu,
  MenuItem,
  MenuDivider,
  Tag,
  Button,
  FormGroup,
  InputGroup,
  ControlGroup,
  NavbarGroup,
  Dialog,
  Tooltip,
  PopoverNext,
  Switch,
} from "@blueprintjs/core";
import { MultiSelect } from "@blueprintjs/select";

import { CommitAvatar } from "./avatars";
import { DoneAtTag } from "./DoneAtTag";
import { SelectBatchesNav } from "./tuning/SelectBatches";
import { has_milestones, MilestonesMenu, CommitMilestoneEditor } from "./milestones"

import { shortId, pretty_label } from "../utils";
import { http, errorMessage } from "../api/http";
import { commitQuery } from "../api/queries";
import { useRefreshCommit, useUrlText, updateSelected, useSiteConfig } from "../hooks";
import { toaster } from "../toaster"
import { copyDirectory } from "./logs/DirectoryActions"
import { hasPathMappings } from "../utils/paths"


// error: why we could not load the commit, e.g. "404 ..."
const CommitMessage = ({ commit, error, style: extra_style }) => {
  const style = { whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', ...extra_style }
  if (!commit?.message) {
    if (error)
      return <span className={Classes.TEXT_MUTED} style={style}>{error.startsWith('404') ? "Commit not found" : "Could not load this commit"}</span>
    return <span className={Classes.SKELETON} style={style}>This is a placeholder for the commit message. Yep.</span>
  }
  return <span style={style} title={commit.message}>
    {commit.message}
  </span>
}

const CommitBranchButton = ({ commit, error, onClick, style }) => {
  const has_branch = !!commit?.branch
  // we won't learn the branch: no placeholder
  if (!has_branch && error)
    return null
  return <span style={style}>
    <Tooltip content={<span>Click to select the latest commit from <code>{has_branch ? commit.branch : 'the branch'}</code></span>}>
      <Button style={{marginLeft: '10px'}} size="small" variant="minimal" onClick={() => { if (has_branch) onClick(commit.branch) }} className={has_branch ? null : Classes.SKELETON} icon="git-branch" >
        <span className="hide-small-screen">{has_branch ? commit.branch : 'master'}</span>
      </Button>
    </Tooltip>
  </span>
}

const BatchTags = ({ batch }) => {
  if (batch === undefined || batch === null)
    return <span/>
  const { valid_outputs, running_outputs, pending_outputs, failed_outputs } = batch;
  return <>
    {valid_outputs > 0 && (
      <Tag intent={Intent.SUCCESS} minimal round>
        {valid_outputs} run{valid_outputs === 1 ? '' : 's'}
      </Tag>
    )}{" "}
    {running_outputs > 0 && (
      <Tag intent={Intent.PRIMARY} minimal round title="Running now">
        {running_outputs} running
      </Tag>
    )}{" "}
    {pending_outputs - running_outputs > 0 && (
      <Tag minimal round title="Waiting for a runner">
        {pending_outputs - running_outputs}{" "}
        pending
      </Tag>
    )}{" "}
    {failed_outputs > 0 && (
      <Tag intent={Intent.DANGER} minimal round title="Failed: open the logs to see why">
        {failed_outputs} failed
      </Tag>
    )}
  </>
}


// useCommit gives errors as strings like "404 ..."
const commit_error_text = error => typeof error === 'string' ? error : errorMessage(error)

const runs = n => `${n} run${n === 1 ? '' : 's'}`
const nb_runs = batch => Object.keys(batch?.outputs ?? {}).length


// What the batch actions ask users to confirm
const confirmations = {
  'redo-all': {
    icon: 'redo', intent: Intent.WARNING, confirm: 'Redo runs',
    title: ({ n, label, filter }) => `Redo the ${runs(n)} of ${label}${filter ? ' that match the filter' : ''}?`,
    body: () => "Their current results are replaced when they start.",
  },
  'delete-failed': {
    icon: 'trash', intent: Intent.DANGER, confirm: 'Delete runs',
    title: ({ n, label, soft }) => `Delete ${soft ? 'the files of ' : ''}the ${n} failed run${n === 1 ? '' : 's'} of ${label}?`,
  },
  'delete-all': {
    icon: 'trash', intent: Intent.DANGER, confirm: 'Delete runs',
    title: ({ n, label, soft }) => soft ? `Delete the files of all the ${runs(n)} of ${label}?` : `Delete all the ${runs(n)} of ${label}?`,
  },
}


// The "new" or "reference" commit we compare: which commit, batch and filter.
// same_as_new: the reference shows the same results as the new commit, there is nothing to compare
const CommitNavbar = ({ update, loading, commit, batch, filter, project, project_data, selected, type, same_as_new = false }) => {
  const queryClient = useQueryClient();
  const refreshCommit = useRefreshCommit();
  const [waiting, setWaiting] = useState(false);
  const [soft_delete, setSoftDelete] = useState(false);
  const { docs_root } = useSiteConfig();
  // the batch action users need to confirm: 'redo-all', 'delete-failed' or 'delete-all'
  const [confirming, setConfirming] = useState(null);
  const [show_rename_dialog, setShowRenameDialog] = useState(false);
  const [show_move_dialog, setShowMoveDialog] = useState(false);
  const [show_delete_batches_dialog, setShowDeleteBatchesDialog] = useState(false);
  const [show_delete_batches_query, setShowDeleteBatchesQuery] = useState('');
  const [show_delete_batches_values, setShowDeleteBatchesValues] = useState([]);
  const [dst_batch_label, setDstBatchLabel] = useState('');
  const [project_input, setProjectInput] = useState(null);
  const [files_delete_filter, setFilesDeleteFilter] = useState(null);

  const project_attr = `${type}_project`
  const commit_attr = `${type}_commit_id`
  const batch_attr = `selected_batch_${type}`
  const filter_attr = `filter_batch_${type}`
  const other_type = type === 'new' ? 'ref' : 'new';
  const batch_filter = selected[`filter_batch_${type}`]
  const [filter_text, onFilterChange] = useUrlText(filter, update(`filter_batch_${type}`))

  const refresh = () => {
    if (commit?.id) refreshCommit(selected[project_attr] ?? project, commit.id)
  }

  // Calls the API about the batch, then refreshes the commit
  const batchAction = (request, { requested, done, error_refresh = false, onDone }) => {
    const key = `batch-action-${type}`
    setWaiting(true)
    toaster.show({message: requested, icon: 'time'}, key);
    return request()
      .then(() => {
        setWaiting(false)
        toaster.show({message: done, intent: Intent.SUCCESS}, key);
        refresh()
        onDone?.()
      })
      .catch(error => {
        setWaiting(false)
        toaster.show({message: errorMessage(error), intent: Intent.DANGER}, key);
        if (error_refresh) refresh()
      });
  }

  const renameBatch = () => {
    const label = dst_batch_label
    setShowRenameDialog(false)
    batchAction(() => http.post(`/api/v1/batch/rename/`, {id: batch.id, label}), {
      requested: `Renaming ${batch.label}…`,
      done: `Renamed ${batch.label} to ${label}`,
    })
  }

  const moveBatch = () => {
    const label = dst_batch_label
    setShowMoveDialog(false)
    batchAction(() => http.post(`/api/v1/batch/move/`, {id: batch.id, label, filter: batch_filter}), {
      requested: `Moving the runs of ${batch.label}…`,
      done: `Moved the runs of ${batch.label} to ${label}`,
    })
  }

  // Redo the batch's runs, or those matching the filter. QA-Board starts them with a single `qa batch`.
  const redo = ({ only_failed = false, only_deleted = false } = {}) => {
    const output_ids = batch_filter ? (batch.filtered?.outputs ?? []) : undefined
    const show_logs = { text: "Show the logs", onClick: () => updateSelected({ selected_views: 'logs' }) }
    const key = `redo-${type}`
    setWaiting(true)
    toaster.show({message: `Starting the runs of ${pretty_label(batch)} again…`, icon: 'time'}, key);
    http.post(`/api/v1/batch/redo/`, {id: batch.id, only_failed, only_deleted, output_ids})
      .then(({ data }) => {
        setWaiting(false)
        const runs = data?.submission?.runs
        toaster.show({message: `Redoing ${runs ?? 'the'} run${runs === 1 ? '' : 's'} of ${pretty_label(batch)}`, intent: Intent.SUCCESS, action: show_logs}, key);
        refresh()
        setTimeout(refresh,  5*1000)
        setTimeout(refresh, 10*1000)
      })
      .catch(error => {
        setWaiting(false)
        toaster.show({message: errorMessage(error), intent: Intent.DANGER, action: error.response?.data?.submission ? show_logs : undefined}, key);
        refresh()
      });
  }

  const deleteBatch = ({ only_failed = false } = {}) => {
    const what = `${only_failed ? 'the failed runs' : 'all the runs'} of ${pretty_label(batch)}`
    const files = soft_delete ? 'the files of ' : ''
    return batchAction(() => http.delete(`/api/v1/batch/${batch.id}/`, {
      params: {...(only_failed ? {only_failed} : {}), soft: soft_delete, filter: files_delete_filter},
    }), {
      requested: `Deleting ${files}${what}…`,
      done: `Deleted ${files}${what}`,
      error_refresh: true,
      onDone: () => update(`selected_batch_${type}`)('default'),
    })
  }

  const confirmAction = () => {
    const action = confirming
    setConfirming(null)
    if (action === 'redo-all') redo()
    else deleteBatch({ only_failed: action === 'delete-failed' })
  }

  const isDeleteBatchSelected = label => show_delete_batches_values.includes(label)

  const deleteBatches = () => {
    setWaiting(true)
    const requests = []
    for (const label of show_delete_batches_values) {
      const batch = commit.batches[label]
      if (batch === undefined)
        continue
      if (has_milestones({commit, project, project_data, batch})) {
        toaster.show({message: `Cannot delete ${label} because it is a milestone`, intent: Intent.WARNING});
        continue
      }
      requests.push(http.delete(`/api/v1/batch/${batch.id}/`, {
        params: {soft: soft_delete, filter: files_delete_filter}
      }))
    }
    const deleted = `${requests.length} batch${requests.length === 1 ? '' : 'es'}`
    if (requests.length > 0)
      toaster.show({message: `Deleting ${deleted}…`, icon: 'time'}, 'delete-batches');
    Promise.all(requests)
      .then(() => {
        if (requests.length > 0)
          toaster.show({message: `Deleted ${deleted}`, intent: Intent.SUCCESS}, 'delete-batches');
        refresh()
        // the selected batch was deleted
        if (isDeleteBatchSelected(selected[`selected_batch_${type}`])) {
          update(`selected_batch_${type}`)('default')
        }
      })
      .catch(error => {
        toaster.show({message: errorMessage(error), intent: Intent.DANGER}, 'delete-batches');
        refresh()
      })
      .finally(() => {
        setWaiting(false)
        setShowDeleteBatchesDialog(false)
      });
  }

  const renderBatchItem = (label, { modifiers, handleClick }) => {
    if (!modifiers.matchesPredicate)
      return null;
    return (
      <MenuItem
        active={modifiers.active}
        icon={isDeleteBatchSelected(label) ? "tick" : "blank"}
        key={label}
        onClick={handleClick}
        text={label}
        shouldDismissPopover={false}
      />
    );
  };
  const deselectDeleteBatch = index => setShowDeleteBatchesValues(values => values.filter((_, i) => i !== index))
  const handleDeleteBatchSelect = label => {
    if (!isDeleteBatchSelected(label))
      setShowDeleteBatchesValues(values => [...values, label])
    else
      deselectDeleteBatch(show_delete_batches_values.indexOf(label))
  };
  const handleDeleteBatchesPaste = labels => setShowDeleteBatchesValues(values => [...values, ...labels])


  // While users type a commit id, the first change adds a browser history entry, the next ones replace it
  const [typing, setTyping] = useState(false)
  // The page fetches the commit, then replaces the short id with the full id in the URL
  const selectCommit = (value, input = project_input) => {
    const id = value?.target?.value ?? value;
    const commit_project = input || project
    const commit_id = selected[commit_attr]
    if (commit_id && commit_id.startsWith(id) && selected[project_attr] === commit_project)
      return
    updateSelected({
      [commit_attr]: id,
      ...(input ? {[project_attr]: input} : {}),
    }, {replace: typing})
    setTyping(true)
  };

  const removeSelection = () => updateSelected({ [commit_attr]: '' })

  const selectBranch = async branch => {
    const commit_project = selected[project_attr]
    try {
      const branch_commit = await queryClient.fetchQuery(commitQuery({project: commit_project, branch}))
      queryClient.setQueryData(commitQuery({project: commit_project, id: branch_commit.id}).queryKey, branch_commit)
      updateSelected({[commit_attr]: branch_commit.id})
    } catch (error) {
      toaster.show({message: `Could not find the latest commit on ${branch}: ${errorMessage(error)}`, intent: Intent.DANGER});
    }
  };

  const selectMilestone = milestone => {
    // milestones from qaboard.yaml are only a branch, tag or commit
    if (!milestone.commit && milestone.branch)
      return selectBranch(milestone.branch)
    updateSelected({
      [commit_attr]: milestone.commit,
      [batch_attr]: milestone.batch,
      [filter_attr]: milestone.filter,
      [project_attr]: milestone.project ?? project,
    })
  };

  const copyToOtherType = () => {
    const other_commit_attr = `${other_type}_commit_id`
    const other_batch_attr = `selected_batch_${other_type}`
    const other_filter_attr = `filter_batch_${other_type}`
    const other_project_attr = `${other_type}_project`
    updateSelected({
      [other_commit_attr]: selected[commit_attr],
      [other_batch_attr]: selected[batch_attr],
      [other_filter_attr]: selected[filter_attr],
      [other_project_attr]: selected[project_attr],
    })
  }

  const switchSelection = () => {
    updateSelected({
      new_project: selected.ref_project,
      ref_project: selected.new_project,
      new_commit_id: selected.ref_commit_id,
      ref_commit_id: selected.new_commit_id,
      selected_batch_new: selected.selected_batch_ref,
      selected_batch_ref: selected.selected_batch_new,
      filter_batch_new: selected.filter_batch_ref,
      filter_batch_ref: selected.filter_batch_new,
    })
  }


  const qatools_config = project_data?.data?.qatools_config
  const reference_branch = qatools_config?.project?.reference_branch ?? 'master';

  // in qaboard.yaml users specify milestones as arrays, but here we handle them as a mapping...
  const qatools_milestones_array = qatools_config?.project?.milestones ?? []
  const qatools_milestones = Object.fromEntries(Object.entries(qatools_milestones_array).map( ([key, branch])=> [key, {branch}] ))
  const shared_milestones = project_data?.data?.milestones ?? {}
  const private_milestones = project_data?.milestones ?? {}
  const has_any_milestone = [qatools_milestones, shared_milestones, private_milestones].some(m => Object.keys(m).length > 0)

  const is_milestone = has_milestones({commit, project, project_data, batch})
  const milestones_menu = <Menu style={{maxHeight: '500px', maxWidth: '360px', overflowY: 'auto'}}>
    <MenuDivider title="Change project"/>
    <ControlGroup>
      <InputGroup
        placeholder="project"
        leftIcon="git-repo"
        value={project_input ?? selected[project_attr]}
        onChange={e => setProjectInput(e.target.value)}
        onBlur={e => {
          setProjectInput(e.target.value)
          selectCommit(commit?.id, e.target.value)
        }}
        fill
      />
      <Button icon="arrow-right" aria-label="Show this commit in the project" onClick={() => selectCommit(commit?.id)}></Button>
    </ControlGroup>
    <MenuDivider title="Quick actions"/>
    <MenuItem text="Switch new/reference" icon="exchange" onClick={switchSelection} />
    <MenuItem text={`Also select as ${type === 'ref' ? 'new' : 'reference'}`} icon={type === 'ref' ? "chevron-up" : "chevron-down"} onClick={copyToOtherType} />
    <MenuItem text="Remove from comparison" icon="cross" onClick={removeSelection} />
    <MenuDivider title="Select"/>
    <MenuItem text={reference_branch} icon="git-branch" onClick={() => selectBranch(reference_branch)} />
    <MilestonesMenu project={project} milestones={qatools_milestones} onSelect={selectMilestone} icon="crown" title="Select a milestone from qaboard.yaml" type="qatools" />
    {!has_any_milestone && <>
      <MenuItem
        disabled
        multiline
        icon="star-empty"
        text={<>No milestones yet. Save one with ☆ next to a commit on its page, or list branches under <code>project.milestones</code> in qaboard.yaml.</>}
      />
      <MenuItem icon="manual" text="Learn more" href={`${docs_root}docs/references-and-milestones`} target="_blank" rel="noopener noreferrer" />
    </>}
    <MilestonesMenu project={project} milestones={shared_milestones} onSelect={selectMilestone} icon="crown" type="shared" title="Select a shared milestone" />
    <MilestonesMenu project={project} milestones={private_milestones} onSelect={selectMilestone} type="private" title="Select a private milestone" />
  </Menu>

  const has_selected_batch = !!commit?.batches && !!batch && Object.keys(commit.batches).includes(batch.label)
  // With a filter, we only redo the runs that match it
  const redo_counts = (batch_filter ? batch?.filtered : batch) ?? {}
  const error_text = commit?.error ? commit_error_text(commit.error) : ''
  const confirmation = confirmations[confirming]
  const confirmation_counts = {
    n: confirming === 'redo-all'
      ? (batch_filter ? batch?.filtered?.outputs?.length ?? 0 : nb_runs(batch))
      : (confirming === 'delete-failed' ? batch?.failed_outputs ?? 0 : nb_runs(batch)),
    label: batch ? pretty_label(batch) : '',
    filter: !!batch_filter,
    soft: soft_delete,
  }
  const filter_help = <ul>
    <li>You can use negative filters: <code>-2X5</code></li>
    <li>You can use regular expressions: <code>2X5|GW1</code>, <code>.*</code></li>
    <li>You can filter runs by all their properties: path, batch, parameters (key:value), metadata, platform...</li>
    <li>Redo and Move apply to the runs that match. Delete applies to the whole batch.</li>
  </ul>
  return <>
    <NavbarGroup style={{marginLeft: '20px'}}>
      <FormGroup style={{marginBottom: '0px'}}>
        <div style={{ 'marginRight': '10px', display: 'block', position: 'relative', width: '600px', marginBottom: '6px' }}>
          <span style={{ display: 'flex' }}>
            <Tooltip
              content={type === 'new' ? "New: the results you're looking at" : "Reference: what the new results are compared to. Change it with “Change” or pick a milestone."}
              targetProps={{style: {flex: '0 1 auto', alignSelf: 'center', marginRight: '5px'}}}
            >
              <Tag minimal>{type}</Tag>
            </Tooltip>
            {(!error_text || !!commit?.committer_name) && <CommitAvatar size='20px' commit={commit} project={selected[project_attr] ?? project} style={{ marginRight: '5px' }} />}
            <CommitMessage
              commit={commit}
              error={error_text}
              style={{ maxWidth: "450px", minWidth: "450px", flex: '0 1 auto' }}
            />
          </span>
        </div>
        <div style={{ display: 'flex' }}>

          <CommitMilestoneEditor
            project={project}
            project_shown={selected[project_attr]}
            project_data={project_data}
            commit={commit}
            batch={batch}
            filter={batch_filter}
            type={type}
          />
          <div style={{ flex: '0 1 auto', alignSelf: 'center' }}>
            <InputGroup
              leftIcon="git-commit"
              style={{ width: '120px' }}
              inputClassName={Classes.MONOSPACE_TEXT}
              onChange={selectCommit}
              onBlur={() => setTyping(false)}
              small
              placeholder="commit id"
              aria-label={`The ${type === 'new' ? 'new' : 'reference'} commit`}
              defaultValue={commit?.id ? shortId(project, commit.id) : ''}
              key={commit?.id ? shortId(project, commit.id) : ''}
            />
          </div>
          <PopoverNext
            placement="bottom-start"
            content={milestones_menu}
          >
            <Button size="small" variant="minimal" icon="edit" style={{ alignSelf: 'center', marginLeft: '2px' }} aria-label={`Change the ${type === 'new' ? 'new' : 'reference'} commit`}>
              <span className="hide-small-screen">Change</span>
            </Button>
          </PopoverNext>
          {!!selected[project_attr] && project !== selected[project_attr] && <Tooltip content={`Results from another project: ${selected[project_attr]}`} targetProps={{style: {alignSelf: "center"}}}>
            <Tag style={{marginLeft: '10px', padding: '5px'}}>{selected[project_attr]}</Tag>
          </Tooltip>}
          <CommitBranchButton commit={commit} error={error_text} onClick={selectBranch} style={{ flex: '0 1 auto', alignSelf: 'center' }} />

          {(!error_text || !!commit?.authored_datetime) && <DoneAtTag project={project} commit={commit} style={{ flex: '0 1 auto', alignSelf: 'center' }} />}{" "}
          {same_as_new && <Tooltip content="Same commit as new: pick another reference to compare" targetProps={{style: {alignSelf: "center"}}}>
            <Tag minimal intent={Intent.WARNING} icon="duplicate" style={{ marginLeft: '5px' }}>Same as new</Tag>
          </Tooltip>}
          {!!error_text && <Tooltip content={
            <span>
              <code>{error_text}</code>
              <br></br>
              {error_text.startsWith('40') && <strong>Check the commit is correct? Or the runs belong to a different project?</strong>}
              {error_text.startsWith('50') && <strong>This is a system error, contact QA-Board admins.</strong>}
            </span>
          } targetProps={{style: {alignSelf: "center"}}}>
            <Tag
              minimal
              intent={Intent.DANGER}
              icon="error"
              style={{ marginRight: '5px', marginLeft: '5px' }}>
                Error
            </Tag>
          </Tooltip>}
        </div>
      </FormGroup>
    </NavbarGroup>
    <NavbarGroup align="right" style={{height: "auto"}}>
      <FormGroup
        labelFor={`filter-${type}-input`}
        style={{ marginBottom: '0px', marginRight: '10px' }}
        helperText={<BatchTags batch={batch?.filtered}/>}
      >
        <InputGroup
          id={`filter-${type}-input`}
          value={filter_text}
          intent={filter_text ? 'primary' : 'default'}
          placeholder={type === 'ref' ? "Filter the reference's runs…" : "Filter runs…"}
          onChange={onFilterChange}
          type="text"
          leftIcon="filter"
          rightElement={<>
            {!!filter_text && <Button size="small" variant="minimal" icon="cross" aria-label="Clear the filter" onClick={() => onFilterChange('')}/>}
            <Tooltip content={filter_help}>
              <Button size="small" variant="minimal" icon="help" className={Classes.TEXT_MUTED} aria-label="How to filter runs"/>
            </Tooltip>
          </>}
        />
      </FormGroup>
      <SelectBatchesNav
        commit={commit}
        batch={batch}
        project={project}
        project_data={project_data}
        onChange={update(`selected_batch_${type}`)}
        hide_counts
      />
      {!!commit && <>
        <Tooltip content="Reload this commit's results">
          <Button
            className={Classes.TEXT_MUTED} minimal
            icon="refresh"
            aria-label="Reload this commit's results"
            disabled={loading}
            onClick={refresh}
          />
        </Tooltip>
        <PopoverNext placement="bottom" content={<Menu>
          <MenuDivider title="Commit"/>
          {hasPathMappings() && <MenuItem text="Copy artifacts directory" label={<Tag minimal>windows</Tag>} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => copyDirectory(commit.artifacts_url, { windows: true })} />}
          <MenuItem text="Copy artifacts directory" label={hasPathMappings() ? <Tag minimal>linux</Tag> : undefined} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => copyDirectory(commit.artifacts_url)} />
          <MenuItem text="View in browser" rel="noopener noreferrer" target="_blank" href={commit.artifacts_url} className={Classes.TEXT_MUTED} minimal icon="folder-shared-open"/>
          {has_selected_batch && <>
          <MenuDivider title="Batch"/>
          {hasPathMappings() && <MenuItem text="Copy output directory" label={<Tag minimal>windows</Tag>} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => copyDirectory(batch.batch_dir_url, { windows: true })} />}
          <MenuItem text="Copy output directory" label={hasPathMappings() ? <Tag minimal>linux</Tag> : undefined} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => copyDirectory(batch.batch_dir_url)} />
          <MenuItem text="View in browser" rel="noopener noreferrer" target="_blank" href={batch.batch_dir_url} className={Classes.TEXT_MUTED} minimal icon="folder-shared-open"/>
          <MenuDivider/>
          <Dialog
            isOpen={show_rename_dialog}
            onOpening={() => setDstBatchLabel(batch.label)}
            onClose={() => setShowRenameDialog(false)}
            title={batch_filter.length > 0 ? "Rename whole batch" : "Rename batch" }
            icon="edit"
          >
            <div className={Classes.DIALOG_BODY}>
              <input
                value={dst_batch_label}
                onChange={event => setDstBatchLabel(event.target.value)}
                className={Classes.INPUT}
                style={{marginBottom: '15px'}}
              />
              <p>You won't be able to rename a batch with pending runs.</p>
            </div>
            <div className={Classes.DIALOG_FOOTER}>
              <div className={Classes.DIALOG_FOOTER_ACTIONS}>
                <Button onClick={() => setShowRenameDialog(false)}>Close</Button>
                <Button onClick={renameBatch} intent={Intent.PRIMARY}>Rename</Button>
              </div>
            </div>
          </Dialog>
          <Dialog
            isOpen={show_move_dialog}
            onOpening={() => setDstBatchLabel(batch.label)}
            onClose={() => setShowMoveDialog(false)}
            title={batch_filter.length > 0 ? "Move runs to another batch" : "Move selection to another batch" }
            icon="send-to-graph"
          >
            <div className={Classes.DIALOG_BODY}>
              <input
                value={dst_batch_label}
                onChange={event => setDstBatchLabel(event.target.value)}
                className={Classes.INPUT}
                style={{marginBottom: '15px'}}
              />
              <p>The destination batch will be created if needed.</p>
            </div>
            <div className={Classes.DIALOG_FOOTER}>
              <div className={Classes.DIALOG_FOOTER_ACTIONS}>
                <Button onClick={() => setShowMoveDialog(false)}>Close</Button>
                <Button onClick={moveBatch} intent={Intent.PRIMARY}>Move</Button>
              </div>
            </div>
          </Dialog>
          <MenuItem
            icon="send-to-graph"
            text={batch_filter.length > 0 ? "Move runs to another batch" : "Move selection to another batch"}
            minimal
            disabled={waiting}
            shouldDismissPopover={false}
            onClick={() => setShowMoveDialog(true)}
          >
          </MenuItem>
          <MenuItem
            icon="edit"
            text={batch_filter.length > 0 ? "Rename whole batch" : "Rename batch"}
            minimal
            disabled={waiting}
            shouldDismissPopover={false}
            onClick={() => setShowRenameDialog(true)}
          />
          {redo_counts.deleted_outputs > 0 && <MenuItem
            icon="redo"
            text={batch_filter ? "Redo filtered deleted runs" : "Redo deleted runs"}
            intent={Intent.WARNING}
            minimal
            disabled={waiting || commit?.deleted}
            onClick={() => redo({only_deleted: true})}
          />}
          {redo_counts.failed_outputs > 0 && <MenuItem
            icon="redo"
            text={batch_filter ? "Redo filtered failed runs" : "Redo failed runs"}
            intent={Intent.WARNING}
            minimal
            disabled={waiting || commit?.deleted}
            onClick={() => redo({only_failed: true})}
          />}
          <MenuItem
            icon="redo"
            text={batch_filter ? `Redo the ${runs(batch.filtered?.outputs?.length ?? 0)} that match the filter…` : "Redo all runs…"}
            intent={Intent.WARNING}
            minimal
            disabled={waiting || commit?.deleted || (!!batch_filter && !batch.filtered?.outputs?.length)}
            onClick={() => setConfirming('redo-all')}
          />
          <MenuDivider/>
          <MenuItem
            icon="trash"
            text={`Delete failed runs${soft_delete ? "' files" : ''}…`}
            intent={Intent.DANGER}
            minimal
            disabled={waiting || !batch.failed_outputs}
            onClick={() => setConfirming('delete-failed')}
          />
          <MenuItem
            icon={!is_milestone ? "trash" : "crown"}
            text={`Delete all runs${soft_delete ? "' files" : ''}…`}
            intent={Intent.DANGER}
            minimal
            disabled={waiting || (is_milestone && !soft_delete)}
            htmlTitle={(is_milestone && !soft_delete) ? "This batch is a milestone: only its files can be deleted (switch on “Delete files, keep metadata”)." : undefined}
            onClick={() => setConfirming('delete-all')}
          />
          <MenuItem
              text="Delete files, keep metadata"
              shouldDismissPopover={false}
              htmlTitle="Deletes the output files to free storage, keeps the runs and their metrics"
              labelElement={<Switch checked={soft_delete} innerLabelChecked="soft" aria-label="Delete files, keep metadata" onChange={() => setSoftDelete(!soft_delete)} />}
          />
          <MenuItem
            icon="trash"
            text={"Delete multiple batches"}
            intent={Intent.DANGER}
            minimal
            disabled={waiting}
            shouldDismissPopover={false}
            onClick={() => setShowDeleteBatchesDialog(true)}
          />
          {soft_delete && <Tooltip content="Only delete files matching these patterns, e.g. *.png, **/*.bin" fill>
            <InputGroup
              placeholder="Delete patterns (*.png, **/*.py)"
              aria-label="Only delete files matching these patterns"
              leftIcon="filter"
              value={files_delete_filter ?? ''}
              intent={files_delete_filter ? Intent.PRIMARY : undefined}
              onChange={e => setFilesDeleteFilter(e.target.value)}
              fill
            />
          </Tooltip>
          }
        </>}
        </Menu>
        }>
          <Button variant="minimal" icon="menu" className={Classes.TEXT_MUTED} aria-label="Commit and batch actions"/>
        </PopoverNext>
        <Alert
          isOpen={!!confirmation}
          icon={confirmation?.icon}
          intent={confirmation?.intent}
          cancelButtonText="Cancel"
          confirmButtonText={confirmation?.confirm}
          canEscapeKeyCancel
          onCancel={() => setConfirming(null)}
          onConfirm={confirmAction}
        >
          {!!confirmation && <>
            <p><strong>{confirmation.title(confirmation_counts)}</strong></p>
            {confirming === 'redo-all'
              ? <p>{confirmation.body()}</p>
              : <>
                {soft_delete
                  ? <p>Their metrics are kept. {!!files_delete_filter && <>Only the files matching <code>{files_delete_filter}</code> are deleted.</>}</p>
                  : <p>Their output files and metrics will be deleted. This can't be undone.</p>}
                {!!batch_filter && <p>The filter doesn't apply: the whole batch is deleted.</p>}
              </>}
          </>}
        </Alert>
      </>}
        <Dialog
          isOpen={show_delete_batches_dialog}
          onOpening={() => setShowDeleteBatchesValues([])}
          onClose={() => setShowDeleteBatchesDialog(false)}
          title={"Delete all runs in multiple batches" }
          icon="trash"
          intent={Intent.DANGER}
        >
          <div className={Classes.DIALOG_BODY}>
            <MultiSelect
              items={Object.keys(commit?.batches ?? {})}
              itemRenderer={renderBatchItem}
              tagRenderer={label => label}
              query={show_delete_batches_query}
              onQueryChange={setShowDeleteBatchesQuery}
              selectedItems={show_delete_batches_values}
              itemPredicate={(query, label) => label.toLowerCase().includes(query.toLowerCase())}
              tagInputProps={{
                tagProps: {minimal: true},
                onRemove: (_tag, index) => deselectDeleteBatch(index),
                rightElement: show_delete_batches_values.length > 0 ? <Button icon="cross" minimal={true} onClick={() => setShowDeleteBatchesValues([])} /> : undefined
              }}
              placeholder="Select batches to delete..."
              noResults={<MenuItem disabled text="No batch matches." />}
              onItemSelect={handleDeleteBatchSelect}
              onItemsPaste={handleDeleteBatchesPaste}
            >
            </MultiSelect>
            <p><Button size="small" onClick={() => setShowDeleteBatchesValues(Object.keys(commit?.batches ?? {}))}>Select all batches</Button></p>
            <p>We won't delete batches defined as milestones.</p>
          </div>
          <div className={Classes.DIALOG_FOOTER}>
            <div className={Classes.DIALOG_FOOTER_ACTIONS}>
              <Button onClick={() => setShowDeleteBatchesDialog(false)}>Close</Button>
              <Button disabled={waiting || show_delete_batches_values.length === 0} onClick={deleteBatches} intent={Intent.DANGER}>
                {show_delete_batches_values.length > 0 ? `Delete ${show_delete_batches_values.length} batch${show_delete_batches_values.length === 1 ? '' : 'es'}` : 'Delete'}
              </Button>
            </div>
          </div>
        </Dialog>
    </NavbarGroup>
  </>;
}


export { CommitNavbar, BatchTags };
