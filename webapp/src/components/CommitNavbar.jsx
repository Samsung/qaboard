import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  Classes,
  Colors,
  Intent,
  Menu,
  MenuItem,
  MenuDivider,
  Tag,
  Icon,
  Button,
  FormGroup,
  InputGroup,
  ControlGroup,
  NavbarGroup,
  Dialog,
  Tooltip,
  Popover,
  Switch,
} from "@blueprintjs/core";
import { MultiSelect } from "@blueprintjs/select";

import { CommitAvatar } from "./avatars";
import { DoneAtTag } from "./DoneAtTag";
import { SelectBatchesNav } from "./tuning/SelectBatches";
import { has_milestones, MilestonesMenu, CommitMilestoneEditor } from "./milestones"

import { shortId } from "../utils";
import { http, errorMessage } from "../api/http";
import { commitQuery } from "../api/queries";
import { useRefreshCommit, useUrlText, updateSelected } from "../hooks";
import { toaster } from "../toaster"
import { copyDirectory } from "./logs/DirectoryActions"


const CommitMessage = ({ commit, style: extra_style }) => {
  const style = { whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', ...extra_style }
  if (!commit?.message) {
    return <span className={`${Classes.SKELETON} ${Classes.MONOSPACE_TEXT}`} style={style}>This is a placeholder for the commit message. Yep.</span>
  }
  return <span style={style} title={commit.message} className={Classes.MONOSPACE_TEXT} >
    {commit.message}
  </span>
}

const CommitBranchButton = ({ commit, onClick, style }) => {
  const has_branch = !!commit?.branch
  return <span style={style}>
    <Tooltip content={<span>Click to select the latest commit from <code>{has_branch ? commit.branch : 'the branch'}</code></span>}>
      <Tag style={{marginLeft: '10px', padding: '5px'}} interactive minimal onClick={() => { if (has_branch) onClick(commit.branch) }} className={has_branch ? null : Classes.SKELETON} icon="git-branch" >
        <span className="hide-small-screen">{has_branch ? commit.branch : 'master'}</span>
      </Tag>
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
        {valid_outputs} output{valid_outputs === 1 ? '' : 's'}
      </Tag>
    )}{" "}
    {running_outputs > 0 && (
      <Tag intent={Intent.SUCCESS} minimal round>
        {running_outputs} running
      </Tag>
    )}{" "}
    {pending_outputs - running_outputs > 0 && (
      <Tag minimal round>
        {pending_outputs - running_outputs}{" "}
        pending
      </Tag>
    )}{" "}
    {failed_outputs > 0 && (
      <Tag intent={Intent.DANGER} minimal round>
        {failed_outputs} crashed
      </Tag>
    )}
  </>
}


// useCommit gives errors as strings like "404 ..."
const commit_error_text = error => typeof error === 'string' ? error : errorMessage(error)


// The "new" or "reference" commit we compare: which commit, batch and filter.
const CommitNavbar = ({ update, loading, commit, batch, filter, project, project_data, selected, type }) => {
  const queryClient = useQueryClient();
  const refreshCommit = useRefreshCommit();
  const [waiting, setWaiting] = useState(false);
  const [soft_delete, setSoftDelete] = useState(false);
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
    setWaiting(true)
    toaster.show({message: requested});
    return request()
      .then(() => {
        setWaiting(false)
        toaster.show({message: done, intent: Intent.SUCCESS});
        refresh()
        onDone?.()
      })
      .catch(error => {
        setWaiting(false)
        toaster.show({message: errorMessage(error), intent: Intent.DANGER});
        if (error_refresh) refresh()
      });
  }

  const renameBatch = () => {
    const label = dst_batch_label
    setShowRenameDialog(false)
    batchAction(() => http.post(`/api/v1/batch/rename/`, {id: batch.id, label}), {
      requested: "Rename requested.",
      done: `Renamed ${batch.label} to ${label}.`,
    })
  }

  const moveBatch = () => {
    const label = dst_batch_label
    setShowMoveDialog(false)
    batchAction(() => http.post(`/api/v1/batch/move/`, {id: batch.id, label, filter: batch_filter}), {
      requested: "Move requested.",
      done: `Moved to ${label}.`,
    })
  }

  // Redo the batch's runs, or those matching the filter. QA-Board starts them with a single `qa batch`.
  const redo = ({ only_failed = false, only_deleted = false } = {}) => {
    const output_ids = batch_filter ? (batch.filtered?.outputs ?? []) : undefined
    const show_logs = { text: "Show the logs", onClick: () => updateSelected({ selected_views: 'logs' }) }
    setWaiting(true)
    toaster.show({message: "Redo requested."});
    http.post(`/api/v1/batch/redo/`, {id: batch.id, only_failed, only_deleted, output_ids})
      .then(({ data }) => {
        setWaiting(false)
        const runs = data?.submission?.runs
        toaster.show({message: `Redoing ${runs ?? 'the'} run${runs === 1 ? '' : 's'} from ${batch.label}.`, intent: Intent.SUCCESS, action: show_logs});
        refresh()
        setTimeout(refresh,  5*1000)
        setTimeout(refresh, 10*1000)
      })
      .catch(error => {
        setWaiting(false)
        toaster.show({message: errorMessage(error), intent: Intent.DANGER, action: error.response?.data?.submission ? show_logs : undefined});
        refresh()
      });
  }

  const deleteBatch = (params, requested) => batchAction(() => http.delete(`/api/v1/batch/${batch.id}/`, {
    params: {...params, soft: soft_delete, filter: files_delete_filter},
  }), {
    requested,
    done: `Deleted ${batch.label}.`,
    error_refresh: true,
    onDone: () => update(`selected_batch_${type}`)('default'),
  })

  const isDeleteBatchSelected = label => show_delete_batches_values.includes(label)

  const deleteBatches = () => {
    setWaiting(true)
    toaster.show({message: `Deleting ${show_delete_batches_values.length} batches.`});
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
    Promise.all(requests)
      .then(() => {
        toaster.show({message: `Deleted.`, intent: Intent.SUCCESS});
        refresh()
        // the selected batch was deleted
        if (isDeleteBatchSelected(selected[`selected_batch_${type}`])) {
          update(`selected_batch_${type}`)('default')
        }
      })
      .catch(error => {
        toaster.show({message: errorMessage(error), intent: Intent.DANGER});
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

  const is_milestone = has_milestones({commit, project, project_data, batch})
  const milestones_menu = <Menu style={{maxHeight: '500px', overflowY: 'scroll'}}>
    <MenuDivider title="Change Project"/>
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
      <Button icon="arrow-right" onClick={() => selectCommit(commit?.id)}></Button>
    </ControlGroup>
    <MenuDivider title="Quick Actions"/>
    <MenuItem text="Switch new/reference" icon="exchange" onClick={switchSelection} />
    <MenuItem text={`Also Select as ${type === 'ref' ? 'New' : 'Reference'}`} icon={type === 'ref' ? "chevron-up" : "chevron-down"} onClick={copyToOtherType} />
    <MenuItem text="Remove from comparison" icon="cross" onClick={removeSelection} />
    <MenuDivider title="Select"/>
    <MenuItem text={reference_branch} icon="git-branch" onClick={() => selectBranch(reference_branch)} />
    <MilestonesMenu project={project} milestones={qatools_milestones} onSelect={selectMilestone} icon="crown" title="Select a milestone from qaboard.yaml" type="qatools" />
    {Object.keys(qatools_milestones).length === 0 && <span>Define <code>project.milestones [array]</code> in your <em>qaboard.yaml</em> configuration.</span>}
    <MilestonesMenu project={project} milestones={shared_milestones} onSelect={selectMilestone} icon="crown" type="shared" title="Select a shared milestone" />
    <MilestonesMenu project={project} milestones={private_milestones} onSelect={selectMilestone} type="private" title="Select a private milestone" />
  </Menu>

  const has_selected_batch = !!commit?.batches && !!batch && Object.keys(commit.batches).includes(batch.label)
  // With a filter, we only redo the runs that match it
  const redo_counts = (batch_filter ? batch?.filtered : batch) ?? {}
  const error_text = commit?.error ? commit_error_text(commit.error) : ''
  return <>
    <NavbarGroup style={{marginLeft: '20px'}}>
      <FormGroup style={{marginBottom: '0px'}}>
        <div style={{ 'marginRight': '10px', display: 'block', position: 'relative', width: '600px', marginBottom: '6px' }}>
          <span style={{ display: 'flex' }}>
            <Tag style={{ flex: '0 1 auto', alignSelf: 'center', marginRight: '5px', fontFamily: 'monospace' }} minimal>{type}</Tag>
            <CommitAvatar size='20px' commit={commit} project={selected[project_attr] ?? project} style={{ marginRight: '5px' }} />
            <CommitMessage
              commit={commit}
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
              style={{
                width: '160px',
                fontFamily: 'monospace',
              }}
              rightElement={<Popover
                  placement="bottom"
                  hoverCloseDelay={200}
                  interactionKind={"hover"}
                  content={milestones_menu}
                >
                <Tag minimal icon="edit"><span className="hide-small-screen">Change</span></Tag>
              </Popover>}
              onChange={selectCommit}
              onBlur={() => setTyping(false)}
              small
              defaultValue={commit?.id ? shortId(project, commit.id) : ''}
              key={commit?.id ? shortId(project, commit.id) : ''}
            />
          </div>
          <span style={{ flex: '0 1 auto', alignSelf: 'center' }}>
          </span>
          {!!selected[project_attr] && project !== selected[project_attr] && <Tag style={{marginLeft: '10px', padding: '5px'}}>{selected[project_attr]}</Tag>}
          <CommitBranchButton commit={commit} onClick={selectBranch} style={{ flex: '0 1 auto', alignSelf: 'center' }} />

          <DoneAtTag project={project} commit={commit} style={{ flex: '0 1 auto', alignSelf: 'center' }} />{" "}
          {!!error_text && <Tooltip content={
            <span>
              <code>{error_text}</code>
              <br></br>
              {error_text.startsWith('40') && <strong>Check the commit is correct? Or the runs belong to a different project?</strong>}
              {error_text.startsWith('50') && <strong>This is a system error, contact QA-Board admins.</strong>}
            </span>
          } targetProps={{style: {alignSelf: "center"}}}>
            <Tag
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
        helperText={type === 'new' ? <Tooltip content={<ul>
            <li>You can use negative filters: <code>-2X5</code></li>
            <li>You can use regular expressions: <code>2X5|GW1</code>, <code>.*</code></li>
            <li>You can filter runs by all their properties: path, batch, parameters (key:value), metadata, platform...</li>
          </ul>}
        >
          <><BatchTags batch={batch?.filtered}/> <Icon style={{marginLeft: '5px', color: Colors.GRAY2}} icon="help"/></>
        </Tooltip> : <BatchTags batch={batch?.filtered}/>}
      >
        <InputGroup
          value={filter_text}
          intent={filter_text ? 'primary' : 'default'}
          placeholder={`filter ${type} outputs`}
          onChange={onFilterChange}
          type="search"
          leftIcon="filter"
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
        <Button
          className={Classes.TEXT_MUTED} minimal
          icon="refresh"
          disabled={loading}
          onClick={refresh}
        />
        <Popover placement="bottom" hoverCloseDelay={500} interactionKind={"hover"} content={<Menu>
          <MenuDivider title="Commit"/>
          <MenuItem text="Copy Artifact Dir" label={<Tag minimal>windows</Tag>} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => copyDirectory(commit.artifacts_url, { windows: true })} />
          <MenuItem text="Copy Artifact Dir" label={<Tag minimal>linux</Tag>} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => copyDirectory(commit.artifacts_url)} />
          <MenuItem text="View in browser" rel="noopener noreferrer" target="_blank" href={commit.artifacts_url} className={Classes.TEXT_MUTED} minimal icon="folder-shared-open"/>
          {has_selected_batch && <>
          <MenuDivider title="Batch"/>
          <MenuItem text="Copy Output Dir" label={<Tag minimal>windows</Tag>} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => copyDirectory(batch.batch_dir_url, { windows: true })} />
          <MenuItem text="Copy Output Dir" label={<Tag minimal>linux</Tag>} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => copyDirectory(batch.batch_dir_url)} />
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
              <p>You won't be able to rename a batch with pending outputs.</p>
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
            text={batch_filter ? "Redo Filtered Deleted Outputs" : "Redo Deleted Outputs"}
            intent={Intent.WARNING}
            minimal
            disabled={waiting || commit?.deleted}
            onClick={() => redo({only_deleted: true})}
          />}
          {redo_counts.failed_outputs > 0 && <MenuItem
            icon="redo"
            text={batch_filter ? "Redo Filtered Failed Outputs" : "Redo Failed Outputs"}
            intent={Intent.WARNING}
            minimal
            disabled={waiting || commit?.deleted}
            onClick={() => redo({only_failed: true})}
          />}
          <MenuItem
            icon="redo"
            text={batch_filter ? `Redo the ${batch.filtered?.outputs?.length ?? 0} Filtered Outputs` : "Redo All Outputs"}
            intent={Intent.WARNING}
            minimal
            disabled={waiting || commit?.deleted || (!!batch_filter && !batch.filtered?.outputs?.length)}
            onClick={() => redo()}
          />
          <MenuDivider/>
          <MenuItem
            icon="trash"
            text={`Delete Failed Outputs${soft_delete ? "' Files" : ''}`}
            intent={Intent.DANGER}
            minimal
            disabled={waiting}
            onClick={() => deleteBatch({only_failed: true}, "Delete requested for failed outputs.")}
          />
          <MenuItem
            icon={!is_milestone ? "trash" : "crown"}
            text={`Delete All Outputs${soft_delete ? "' Files" : ''}`}
            intent={Intent.DANGER}
            minimal
            disabled={waiting || (is_milestone && !soft_delete)}
            onClick={() => deleteBatch({}, "Delete requested.")}
          />
          <MenuItem
              text={<em>Delete files, keep metadata</em>}
              shouldDismissPopover={false}
              labelElement={<Switch checked={soft_delete} innerLabelChecked="soft" onChange={() => setSoftDelete(!soft_delete)} />}
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
          {soft_delete && <InputGroup
            placeholder="Delete patterns (*.png, **/*.py)"
            leftIcon="filter"
            value={files_delete_filter ?? ''}
            className={batch_filter === '' ? undefined : Intent.PRIMARY}
            onChange={e => setFilesDeleteFilter(e.target.value)}
            fill
          />
          }
        </>}
        </Menu>
        }>
          <Icon icon="menu" className={Classes.TEXT_MUTED}/>
        </Popover>
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
            <p><Tag interactive onClick={() => setShowDeleteBatchesValues(Object.keys(commit?.batches ?? {}))}>Select All Batches</Tag></p>
            <p>We won't delete batches defined as milestones.</p>
          </div>
          <div className={Classes.DIALOG_FOOTER}>
            <div className={Classes.DIALOG_FOOTER_ACTIONS}>
              <Button onClick={() => setShowDeleteBatchesDialog(false)}>Close</Button>
              <Button disabled={waiting} onClick={deleteBatches} intent={Intent.DANGER}>Delete</Button>
            </div>
          </div>
        </Dialog>
    </NavbarGroup>
  </>;
}


export { CommitNavbar, BatchTags };
