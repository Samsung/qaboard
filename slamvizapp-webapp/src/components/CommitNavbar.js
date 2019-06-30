import React from "react";

import {
  Classes,
  Tag,
  Button,
  Intent,
  EditableText,
  Tooltip,
  FormGroup,
  Menu,
} from "@blueprintjs/core";

import { CommitAvatar } from "./avatars";
import { DoneAtTag } from "./DoneAtTag";

import { fetchCommit } from "../actions/commit";
import { updateSelected } from "../actions/selected";
import { shortId } from "../utils";


class CommitMessage extends React.PureComponent {
  render() {
    const { commit } = this.props;
    const style = {marginTop: "10px", whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', ...this.props.style}
    if (commit === undefined || commit === null  || commit.message === undefined || commit.message === null || commit.message === '') {
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
      <Button minimal onClick={e => {onClick(commit.branch)} } className={has_branch ? null : Classes.SKELETON} icon="git-branch" >
        {has_branch ? commit.branch.replace('origin/', '') : 'master'}
      </Button>
    </span>
  }
}


class CommitNavbar extends React.Component {
  render() {
    const { project, project_data, commit, label } = this.props;
    const qatools_config = (((project_data || {}).data || {}).qatools_config)
    const milestones = (((qatools_config || {}).project || {}).milestones || [])
    const reference_branch = (((qatools_config || {}).project || {}).reference_branch) || 'master';
    return (
       <FormGroup style={{marginTop: '45px'}}>
          <div style={{'marginRight': '10px', display: 'block', position: 'relative', width: '600px', marginBottom: '6px'}}>
            <span style={{display: 'flex'}}>
              <Tag style={{flex: '0 1 auto', alignSelf: 'center', marginRight: '5px', fontFamily: 'monospace'}} minimal>{label}</Tag>
              <CommitAvatar size='20px' commit={commit} style={{marginRight: '5px'}}/>
              <CommitMessage
                project={project}
                commit={commit}
                style={{maxWidth: "450px", minWidth: "450px", flex: '0 1 auto', alignSelf: 'center'}}
                is_loaded={!!commit && commit.id && !this.props.commit.is_loaded}
              />
            </span>
          </div>
          <div style={{display: 'flex'}}>
            <span style={{flex: '0 1 auto', alignSelf: 'center'}}><EditableText
              onConfirm={this.handleSubmit}
              minWidth={60}
              placeholder='id'
              key={(!!commit && !!commit.id) ? shortId(project, commit.id) : ''}
              defaultValue={(!!commit && !!commit.id) ? shortId(project, commit.id) : ''}
            /></span>
            <Tooltip position="auto-end"  hoverCloseDelay={1500}>
              <CommitBranchButton commit={commit} onClick={this.handleSubmitBranch} style={{flex: '0 1 auto', alignSelf: 'center'}}/>
              <Menu>
                <li className={Classes.MENU_HEADER}><h6 className={Classes.HEADING}>Compare to the reference branch</h6></li>
                <Menu.Item text={reference_branch} icon="git-branch" onClick={() => this.handleSubmitBranch(reference_branch)}/>
                <li className={Classes.MENU_HEADER}><h6 className={Classes.HEADING}>Compare to milestones</h6></li>
                {milestones.map(m => {
                    return <Menu.Item
                      text={m}
                      icon="locate"
                      onClick={() => this.handleSubmitBranch(m)}
                    />}
                )}
                {milestones.length===0 && <span>Define <code>project.milestones [array]</code> in your <em>qatools.yaml</em> configuration.</span>}
                <li className={Classes.MENU_HEADER}><h6 className={Classes.HEADING}>Actions</h6></li>
                <Menu.Item text="Remove reference" icon="delete" onClick={() => this.handleSubmitBranch(null)}/>
              </Menu>
            </Tooltip>

            <DoneAtTag dispatch={this.props.dispatch} project={project} commit={commit} style={{flex: '0 1 auto', alignSelf: 'center'}} />{" "}
            {!!commit && !!commit.error && <Tooltip><Tag intent={Intent.DANGER} icon="error" style={{marginRight: '8px'}}>Error</Tag><span>{commit.error}</span></Tooltip>}
          </div>
      </FormGroup>
    );
  }


  handleSubmit = id => {
    const { project, label, selected, dispatch } = this.props;
    const attribute = `${label}_commit_id`
    const commit_id = selected[attribute]
    if (commit_id === undefined || commit_id === null || !commit_id.startsWith(id)) {
      dispatch(fetchCommit(project, id, attribute));
      dispatch(updateSelected(project, {[attribute]: id }))
    }
  };

  handleSubmitBranch = branch => {
    const { project, dispatch } = this.props;
    dispatch(fetchCommit(project, null, "ref_commit_id", branch));
    dispatch(updateSelected(project, { ref_commit_id: branch }))
  };

}



export { CommitNavbar };
