import React from "react";
import copy from 'copy-to-clipboard';
import axios from "axios";

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
  NavbarGroup,
  Dialog,
  Tooltip,
  Popover,
  Toaster,
} from "@blueprintjs/core";


import { CommitAvatar } from "./avatars";
import { DoneAtTag } from "./DoneAtTag";
import { SelectBatchesNav } from "./tuning/SelectBatches";
import { MilestonesMenu, CommitMilestoneEditor } from "./milestones"

import { shortId, linux_to_windows } from "../utils";
import { fetchCommit } from "../actions/commit";
import { updateSelected } from "../actions/selected";

export const toaster = Toaster.create();


class CommitMessage extends React.PureComponent {
  render() {
    const { commit } = this.props;
    const style = { whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', ...this.props.style }
    if (commit === undefined || commit === null || commit.message === undefined || commit.message === null || commit.message === '') {
      return <span className={`${Classes.SKELETON} ${Classes.MONOSPACE_TEXT}`} style={style}>This is a placeholder for the commit message. Yep.</span>
    }
    return <>
      <span style={style} title={commit.message} className={Classes.MONOSPACE_TEXT} >
        {commit.message}
      </span>
    </>
  }
}

class CommitBranchButton extends React.PureComponent {
  render() {
    const { commit, onClick, style } = this.props;
    const has_branch = !!commit && !!commit.branch
    return <span style={style}>
      <Tooltip>
        <Tag style={{marginLeft: '10px', padding: '5px'}} interactive minimal onClick={e => { onClick(commit.branch) }} className={has_branch ? null : Classes.SKELETON} icon="git-branch" >
          {has_branch ? commit.branch : 'master'}
        </Tag>
        <span>Click to select the latest commit from <code>{has_branch ? commit.branch : 'the branch'}</code></span>
      </Tooltip>
    </span>
  }
}

class BatchTags extends React.PureComponent {
  render() {
    if (this.props.batch === undefined || this.props.batch === null)
      return <span/>
    const { valid_outputs, running_outputs, pending_outputs, failed_outputs } = this.props.batch;
    return <>
      {valid_outputs > 0 && (
        <Tag intent={Intent.SUCCESS} minimal round>
          {valid_outputs} outputs
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
}




class CommitNavbar extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      waiting: false,
      show_rename_dialog: false,
      renamed_batch_label: '',
    };
  }

  renameBatch = () => {
    const { batch } = this.props;
    const { renamed_batch_label: label } = this.state;
    this.setState({waiting: true, show_rename_dialog: false})
    toaster.show({message: "Redo requested."});
    axios.post(`/api/v1/batch/rename/`, {id: batch.id, label})
      .then(response => {
        this.setState({waiting: false})
        toaster.show({message: `Renamed ${batch.label} to ${label}.`, intent: Intent.PRIMARY});
        this.refresh()    
      })
      .catch(error => {
        this.setState({waiting: false });
        toaster.show({message: JSON.stringify(error), intent: Intent.DANGER});
      });
  }

  render() {
    const { project, project_data, commits, commit, batch, selected, type, dispatch, update } = this.props;
    const qatools_config = (((project_data || {}).data || {}).qatools_config)
    const reference_branch = (((qatools_config || {}).project || {}).reference_branch) || 'master';

    // in qaboard.yaml users specify milestones as arrays, but here we handle them as a mapping...
    const qatools_milestones_array = (((qatools_config || {}).project || {}).milestones || [])
    const qatools_milestones = Object.fromEntries(Object.entries(qatools_milestones_array).map( ([key, branch])=> [key, {branch}] ))
    const shared_milestones = ((project_data || {}).data || {}).milestones || {}
    const private_milestones = project_data.milestones || {}

    const milestones_menu = <Menu style={{maxHeight: '500px', overflowY: 'scroll'}}>
      <MenuDivider title="Quick Actions"/>
      <MenuItem text="Switch new/reference" icon="exchange" onClick={this.switchSelection} />
      <MenuItem text={`Also Select as ${type === 'ref' ? 'New' : 'Reference'}`} icon={type === 'ref' ? "chevron-up" : "chevron-down"} onClick={this.copyToOtherType} />
      <MenuItem text="Remove from comparaison" icon="cross" onClick={() => this.removeSelection()} />
      <MenuDivider title="Select"/>
      <MenuItem text={reference_branch} icon="git-branch" onClick={() => this.selectBranch(reference_branch)} />
      <MilestonesMenu milestones={qatools_milestones} onSelect={this.selectMilestone} icon="crown" title="Select a milestone from qaboard.yaml" type="qatools" />
      {qatools_milestones.length === 0 && <span>Define <code>project.milestones [array]</code> in your <em>qaboard.yaml</em> configuration.</span>}
      <MilestonesMenu milestones={shared_milestones} onSelect={this.selectMilestone} icon="crown" type="shared" title="Select a shared milestone" />
      <MilestonesMenu milestones={private_milestones} onSelect={this.selectMilestone} type="private" title="Select a private milestone" />
    </Menu>

    let has_selected_batch = !!commit && !!commit.batches && !!batch && Object.keys(commit.batches).includes(batch.label)
    return <>
      <NavbarGroup style={{marginLeft: '20px'}}>
        <FormGroup style={{ marginTop: '45px' }}>
          <div style={{ 'marginRight': '10px', display: 'block', position: 'relative', width: '600px', marginBottom: '6px' }}>
            <span style={{ display: 'flex' }}>
              <Tag style={{ flex: '0 1 auto', alignSelf: 'center', marginRight: '5px', fontFamily: 'monospace' }} minimal>{type}</Tag>
              <CommitAvatar size='20px' commit={commit} style={{ marginRight: '5px' }} />
              <CommitMessage
                project={project}
                commit={commit}
                style={{ maxWidth: "450px", minWidth: "450px", flex: '0 1 auto' }}
                is_loaded={!!commit && commit.id && !this.props.commit.is_loaded}
              />
            </span>
          </div>
          <div style={{ display: 'flex' }}>

            <CommitMilestoneEditor
              project={project}
              project_data={project_data}
              commit={commit}
              batch={batch}
              filter={selected[`filter_batch_${type}`]}
              dispatch={dispatch}
            />
            <div style={{ flex: '0 1 auto', alignSelf: 'center' }}>
              <InputGroup
                leftIcon="git-commit"
                style={{
                  width: '160px',
                  fontFamily: 'monospace',
                }}
                rightElement={<Popover position="bottom" hoverCloseDelay={200} interactionKind={"hover"}>
                  <Tag minimal icon="edit">Change</Tag>
                  {milestones_menu}
                </Popover>}
                onChange={this.selectCommit}
                small
                defaultValue={(!!commit && !!commit.id) ? shortId(project, commit.id) : ''}
                key={(!!commit && !!commit.id) ? shortId(project, commit.id) : ''}
              />
            </div>
            <span style={{ flex: '0 1 auto', alignSelf: 'center' }}>
            </span>
            <CommitBranchButton commit={commit} onClick={this.selectBranch} style={{ flex: '0 1 auto', alignSelf: 'center' }} />

            <DoneAtTag dispatch={this.props.dispatch} project={project} commit={commit} style={{ flex: '0 1 auto', alignSelf: 'center' }} />{" "}
            {!!commit && !!commit.error && <Tooltip><Tag intent={Intent.DANGER} icon="error" style={{ marginRight: '8px' }}>Error</Tag><span>{commit.error}</span></Tooltip>}
          </div>
        </FormGroup>
      </NavbarGroup>
      <NavbarGroup align="right">
        <FormGroup
          style={{marginTop: '36px'}}
          labelFor={`filter-${type}-input`}
          helperText={type === 'new' ? <Tooltip>
            <><BatchTags batch={batch.filtered}/> <Icon style={{marginLeft: '5px', color: Colors.GRAY2}} icon="help"/></>
            <ul>
              <li>You can use negative filters: <code>-2X5</code></li>
              <li>You can use regular expressions: <code>2X5|GW1</code>, <code>.*</code></li>
              <li>You can filter outputs by all their properties: path, configuration, platform, tags or tuning parameters (key:value).</li>
            </ul>
          </Tooltip> : <BatchTags batch={batch.filtered}/>}
        >
          <InputGroup
            value={this.props.filter}
            intent={!!this.props.filter ? 'primary' : 'default'}
            placeholder={`filter ${type} outputs`}
            onChange={update(`filter_batch_${type}`)}
            type="search"
            leftIcon="filter"
          />
        </FormGroup>
        <SelectBatchesNav
          commit={commit}
          batch={batch}
          onChange={update(`selected_batch_${type}`)}
          hide_counts
        />
        {!!commit && !!commits[commit.id] && <>
          <Button
            className={Classes.TEXT_MUTED} minimal
            icon="refresh"
            disabled={!!commit && commit.id && !commits[commit.id].is_loaded}
            onClick={this.refresh}
          />
          <Popover position="bottom" hoverCloseDelay={500} interactionKind={"hover"}>
            <Icon icon="menu" className={Classes.TEXT_MUTED}/>
            <Menu>
              <MenuDivider title="Commit"/>
              <MenuItem text="Copy Directory" label={<Tag minimal>windows</Tag>} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => {toaster.show({message: "Windows path copied to clipboard!", intent: Intent.PRIMARY}); copy(linux_to_windows(commit.commit_dir_url))}} />
              <MenuItem text="Copy Directory" label={<Tag minimal>linux</Tag>} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => {toaster.show({message: "Linux path copied to clipboard!", intent: Intent.PRIMARY}); copy(decodeURI(commit.commit_dir_url).slice(2))}} />
              <MenuItem text="View in browser" rel="noopener noreferrer" target="_blank" href={commit.commit_dir_url} className={Classes.TEXT_MUTED} minimal icon="folder-shared-open"/>
              {has_selected_batch && <>
              <MenuDivider title="Batch"/>
              <Dialog
                isOpen={this.state.show_rename_dialog}
                onOpening={() => this.setState({renamed_batch_label: batch.label})}
                onClose={() => this.setState({show_rename_dialog: false})}
                title="Rename batch"
                icon="edit"
              >
                <div className={Classes.DIALOG_BODY}>
                  <input
                    value={this.state.renamed_batch_label}
                    onChange={event => this.setState({renamed_batch_label: event.target.value})}
                    className={Classes.INPUT}
                    style={{marginBottom: '15px'}}
                  />
                  <p>You won't be able to rename a batch with pending outputs.</p>
                </div>
                <div className={Classes.DIALOG_FOOTER}>
                  <div className={Classes.DIALOG_FOOTER_ACTIONS}>
                    <Button onClick={() => this.setState({show_rename_dialog: false})}>Close</Button>
                    <Button onClick={this.renameBatch} intent={Intent.PRIMARY}>Rename</Button>
                  </div>
                </div>
              </Dialog>
              <MenuItem
                icon="edit"
                text="Rename batch"
                minimal
                disabled={this.state.waiting}
                shouldDismissPopover={false}
                onClick={() => this.setState({show_rename_dialog: true})}
              />
              {batch.deleted_outputs > 0 && <MenuItem
                icon="redo"
                text="Redo Deleted Outputs"
                intent={Intent.WARNING}
                minimal
                disabled={this.state.waiting}
                onClick={() => {
                  this.setState({waiting: true})
                  toaster.show({message: "Redo of deleted outputs requested."});
                  axios.post(`/api/v1/batch/redo/`, {id: batch.id, only_deleted: true})
                    .then(response => {
                      this.setState({waiting: false})
                      toaster.show({message: `Redo ${batch.label}.`, intent: Intent.PRIMARY});
                      this.refresh()
                    })
                    .catch(error => {
                      this.setState({waiting: false });
                      toaster.show({message: JSON.stringify(error), intent: Intent.DANGER});
                    });
                }}
              />}
              <MenuItem
                icon="redo"
                text="Redo All Outputs"
                intent={Intent.WARNING}
                minimal
                disabled={this.state.waiting}
                onClick={() => {
                  this.setState({waiting: true})
                  toaster.show({message: "Redo requested."});
                  axios.post(`/api/v1/batch/redo/`, {id: batch.id, only_deleted: false})
                    .then(response => {
                      this.setState({waiting: false})
                      toaster.show({message: `Redo ${batch.label}.`, intent: Intent.PRIMARY});
                      this.refresh()
                      setTimeout(this.refresh,  1*1000)
                      setTimeout(this.refresh,  5*1000)
                      setTimeout(this.refresh, 10*1000)
                    })
                    .catch(error => {
                      this.setState({waiting: false });
                      toaster.show({message: JSON.stringify(error), intent: Intent.DANGER});
                    });
                }}
              />
              <MenuItem
                icon="trash"
                text="Delete Failed Outputs"
                intent={Intent.DANGER}
                minimal
                disabled={this.state.waiting}
                onClick={() => {
                  this.setState({waiting: true})
                  toaster.show({message: "Delete requested for failed outputs."});
                  axios.delete(`/api/v1/batch/${batch.id}/?only_failed=true`)
                    .then(response => {
                      this.setState({waiting: false})
                      toaster.show({message: `Deleted ${batch.label}.`, intent: Intent.PRIMARY});
                      this.refresh()
                      update(`selected_batch_${type}`)('default')
                    })
                    .catch(error => {
                      this.setState({waiting: false });
                      toaster.show({message: JSON.stringify(error), intent: Intent.DANGER});
                      this.refresh()
                    });
                }}
              />
              <MenuItem
                icon="trash"
                text="Delete All Outputs"
                intent={Intent.DANGER}
                minimal
                disabled={this.state.waiting}
                onClick={() => {
                  this.setState({waiting: true})
                  toaster.show({message: "Delete requested."});
                  axios.delete(`/api/v1/batch/${batch.id}/`)
                    .then(response => {
                      this.setState({waiting: false})
                      toaster.show({message: `Deleted ${batch.label}.`, intent: Intent.PRIMARY});
                      this.refresh()
                      update(`selected_batch_${type}`)('default')
                    })
                    .catch(error => {
                      this.setState({waiting: false });
                      toaster.show({message: JSON.stringify(error), intent: Intent.DANGER});
                      this.refresh()
                    });
                }}
              />
            </>}
            </Menu>
          </Popover>
        </>}
      </NavbarGroup>

    </>;
  }

  refresh = () => {
    const { project, commit, dispatch } = this.props;
    dispatch(fetchCommit({project, id: commit.id}))
  }

  selectCommit = e => {
    const { project, type, selected, dispatch } = this.props;
    const id = e.target.value;
    const attribute = `${type}_commit_id`
    const commit_id = selected[attribute]
    if (commit_id === undefined || commit_id === null || !commit_id.startsWith(id)) {
      dispatch(fetchCommit({project, id, update_selected: attribute}));
      dispatch(updateSelected(project, { [attribute]: id }))
    }
  };

  removeSelection = () => {
    const { project, type, dispatch } = this.props;    
    dispatch(updateSelected(project, { [`${type}_commit_id`]: '' }))
  }

  selectBranch = branch => {
    const { project, type, dispatch } = this.props;
    dispatch(fetchCommit({project, branch, update_selected: `${type}_commit_id`}));
  };
  selectMilestone = milestone => {
    const { project, type, dispatch } = this.props;
    dispatch(fetchCommit({project, id: milestone.commit}));
    dispatch(updateSelected(project, {
      [`${type}_commit_id`]: milestone.commit,
      [`selected_batch_${type}`]: milestone.batch,
      [`filter_batch_${type}`]: milestone.filter,
    }))
  };


  copyToOtherType = () => {
    const { project, selected, type, dispatch } = this.props;
    const other_type = type === 'new' ? 'ref' : 'new';
    dispatch(updateSelected(project, {    
      [`${other_type}_commit_id`]: selected[`${type}_commit_id`],
      [`selected_batch_${other_type}`]: selected[`selected_batch_${type}`],
      [`filter_batch_${other_type}`]: selected[`filter_batch_${type}`],
    }))
  }


  switchSelection = () => {
    const { project, selected, dispatch } = this.props;
    dispatch(updateSelected(project, {
      new_commit_id: selected.ref_commit_id,
      ref_commit_id: selected.new_commit_id,
      selected_batch_new: selected.selected_batch_ref,
      selected_batch_ref: selected.selected_batch_new,
      filter_batch_new: selected.filter_batch_ref,
      filter_batch_ref: selected.filter_batch_new,
    }))
    // FIXME: we should also update the URL path and query...
  }

}


export { CommitNavbar };
