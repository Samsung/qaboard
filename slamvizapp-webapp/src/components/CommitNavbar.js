import React from "react";

import {
  Classes,
  Tag,
  Button,
  Intent,
  EditableText,
  Tooltip,
  Popover,
  FormGroup,
  Menu,
} from "@blueprintjs/core";

import { CommitAvatar } from "./avatars";
import { DoneAtTag } from "./DoneAtTag";
import { MilestonesMenu, CommitMilestoneEditor } from "./milestones"
import { shortId } from "../utils";

import { fetchCommit } from "../actions/commit";
import { updateSelected } from "../actions/selected";


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
      <Button minimal onClick={e => { onClick(commit.branch) }} className={has_branch ? null : Classes.SKELETON} icon="git-branch" >
        {has_branch ? commit.branch : 'master'}
      </Button>
    </span>
  }
}


class CommitNavbar extends React.Component {
  render() {
    const { project, project_data, commit, batch, selected, type, dispatch } = this.props;
    const qatools_config = (((project_data || {}).data || {}).qatools_config)
    const reference_branch = (((qatools_config || {}).project || {}).reference_branch) || 'master';

    // in qatools.yaml users specify milestones as arrays, but here we handle them as a mapping...
    const qatools_milestones_array = (((qatools_config || {}).project || {}).milestones || [])
    const qatools_milestones = Object.fromEntries(Object.entries(qatools_milestones_array).map( ([key, branch])=> [key, {branch}] ))
    const shared_milestones = ((project_data || {}).data || {}).milestones || {}
    const private_milestones = project_data.milestones || {}

    const milestones_menu = <Menu>
      <li className={Classes.MENU_HEADER}><h6 className={Classes.HEADING}>Select</h6></li>
      <Menu.Item text={reference_branch} icon="git-branch" onClick={() => this.selectBranch(reference_branch)} />
      <MilestonesMenu milestones={qatools_milestones} onSelect={this.selectMilestone} icon="crown" title="Select a milestone from qatools.yaml" type="qatools" />
      {qatools_milestones.length === 0 && <span>Define <code>project.milestones [array]</code> in your <em>qatools.yaml</em> configuration.</span>}
      <MilestonesMenu milestones={shared_milestones} onSelect={this.selectMilestone} icon="crown" type="shared" title="Select a shared milestone" />
      <MilestonesMenu milestones={private_milestones} onSelect={this.selectMilestone} type="private" title="Select a private milestone" />
      <Menu.Divider/>
      <Menu.Item text="Switch new/reference" icon="exchange" onClick={this.switchSelection} />
      <Menu.Item text={`Copy ${type === 'ref' ? 'above in new' : 'below in reference'}`} icon="duplicate" onClick={this.copyToOtherType} />
      <Menu.Item text="Remove" icon="delete" onClick={() => this.removeSelection()} />
    </Menu>

    return (
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

          <span style={{ flex: '0 1 auto', alignSelf: 'center' }}>
            <Popover position="bottom" hoverCloseDelay={500} interactionKind={"hover"}>
              <EditableText
                onConfirm={this.selectCommit}
                minWidth={60}
                placeholder='id'
                key={(!!commit && !!commit.id) ? shortId(project, commit.id) : ''}
                defaultValue={(!!commit && !!commit.id) ? shortId(project, commit.id) : ''}
              />
              {milestones_menu}
            </Popover>
          </span>
          <CommitBranchButton commit={commit} onClick={this.selectBranch} style={{ flex: '0 1 auto', alignSelf: 'center' }} />

          <DoneAtTag dispatch={this.props.dispatch} project={project} commit={commit} style={{ flex: '0 1 auto', alignSelf: 'center' }} />{" "}
          {!!commit && !!commit.error && <Tooltip><Tag intent={Intent.DANGER} icon="error" style={{ marginRight: '8px' }}>Error</Tag><span>{commit.error}</span></Tooltip>}
        </div>
      </FormGroup>
    );
  }

  selectCommit = id => {
    const { project, type, selected, dispatch } = this.props;
    const attribute = `${type}_commit_id`
    const commit_id = selected[attribute]
    if (commit_id === undefined || commit_id === null || !commit_id.startsWith(id)) {
      dispatch(fetchCommit(project, id, attribute));
      dispatch(updateSelected(project, { [attribute]: id }))
    }
  };

  removeSelection = () => {
    const { project, type, dispatch } = this.props;    
    dispatch(updateSelected(project, { [`${type}_commit_id`]: '' }))
  }

  selectBranch = branch => {
    const { project, batch, type, dispatch } = this.props;
    dispatch(fetchCommit(project, null, [`${type}_commit_id`], branch, null, /*update_selected=*/!!branch));
    dispatch(updateSelected(project, { [`${type}_commit_id`]: branch }))
  };
  selectMilestone = milestone => {
    const { project, type, dispatch, batch } = this.props;
    dispatch(fetchCommit(project, milestone.commit, `${type}_commit_id`)); // which branch?
    dispatch(updateSelected(project, {
      [`${type}_commit_id`]: milestone.commit,
      [`selected_batch_${type}`]: milestone.batch
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
