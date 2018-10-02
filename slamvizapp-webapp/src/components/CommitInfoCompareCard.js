import React from "react";
import { connect } from 'react-redux'
import {
  Classes,
  Card,
  Tag,
  Button,
  Icon,
  Intent,
  EditableText
} from "@blueprintjs/core";

import { CommitAvatar } from "./avatars";
import { DoneAtTag } from "./DoneAtTag";

import { fetchCommit } from "../actions/commit";
import { updateSelected } from "../actions/selected";
import { shortId } from "../utils";
import { empty_batch } from "../defaults"


const outer_div_style = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
}


class BatchTags extends React.PureComponent {
  render() {
    const { valid_outputs, running_outputs, pending_outputs, failed_outputs } = this.props.batch;
    return <>
      {valid_outputs > 0 && (
        <Tag intent={Intent.SUCCESS}>
          {valid_outputs} outputs
        </Tag>
      )}{" "}
      {running_outputs > 0 && (
        <Tag intent={Intent.SUCCESS}>
          {running_outputs} running
        </Tag>
      )}{" "}
      {pending_outputs - running_outputs > 0 && (
        <Tag>
          {pending_outputs - running_outputs}{" "}
          pending
        </Tag>
      )}{" "}
      {failed_outputs > 0 && (
        <Tag intent={Intent.DANGER}>
          {failed_outputs} crashed
        </Tag>
      )}
    </>
  }
}


// class CommitInfo extends React.PureComponent {
//   render() {
//     const { commit, align_right } = this.props;
//     return <div/>
//   }
// }

class CommitParents extends React.PureComponent {
  render() {
    const { commit, onClick, project } = this.props;

    if (commit === undefined)
      return <Button className={Classes.SKELETON}>XXXXXXXX</Button>
    if (!commit.parents)
      return <span/>

    return <>
      {git_commit_icon}{" "}
      {commit.parents.length > 1 ? "parents" : "parent"}:{" "}
      {commit.parents.map( p => 
        <Button key={p} onClick={e => { onClick(p);}}>{shortId(project, p)}</Button>
      )}
    </>
  }
}


class CommitMessage extends React.PureComponent {
  render() {
    const { commit, style, on_refresh, is_loaded } = this.props;
    if (!commit || !commit.message)
      return <p className={`${Classes.SKELETON} ${Classes.MONOSPACE_TEXT}`}>This is a placeholder for the commit message. Yep.</p>
    return <>
      <p style={{ marginTop: "10px", ...style}} className={Classes.MONOSPACE_TEXT} >
        {commit.message}
      </p>
      <p style={style}>
        <Button className={Classes.TEXT_MUTED} minimal icon="refresh" disabled={is_loaded} onClick={on_refresh}></Button>
        <a href={`/api/v1/commit/${commit.id}`}><Button className={Classes.TEXT_MUTED} minimal icon="import">JSON</Button></a>
      </p>
    </>
  }
}


class CommitBranchButton extends React.PureComponent {
  render() {
    const { commit, align_right, onClick } = this.props;
    const has_branch = !!commit && !!commit.branch
    const outer_style_align_right = { display: "flex", justifyContent: "flex-end" }
    return <span style={align_right && outer_style_align_right}>
      <Button onClick={e => {onClick(commit.branch)} } className={has_branch ? null : Classes.SKELETON} icon="git-branch" >
        {has_branch ? commit.branch : 'master'}
      </Button>
    </span>
  }
}

const git_commit_icon = <Icon icon="git-commit" style={{verticalAlign: 'middle', margin: '5px'}} />



class CommitInfoCompareCard extends React.PureComponent {
  render() {
    const { project } = this.props;
    const { ref_commit, ref_label } = this.props;
    const { new_commit, new_label } = this.props;

    let new_ci_batch = (new_commit && new_commit.batches && new_commit.batches[new_label]) || empty_batch;
    let ref_ci_batch = (ref_commit && ref_commit.batches && ref_commit.batches[ref_label]) || empty_batch;

    // let maybe_skeletton_class = !!new_commit ? Classes.SKELETON : null
    const empty_commit_id = <span className={Classes.SKELETON}>XXXXXXXX</span>
    return (
      <Card elevation={4} style={{minHeight: '193px'}}>
        <div style={outer_div_style}>

          <div style={{ flex: "1 1 auto", minWidth: "450px" }}>
            <h1 className={Classes.HEADING} style={{ display: "flex", alignItems: "baseline" }}>
              <CommitAvatar commit={new_commit} />
              {(!!new_commit && !!new_commit.id) ? shortId(project, new_commit.id) : empty_commit_id}
            </h1>
            <CommitBranchButton commit={new_commit} onClick={this.handleSubmitBranch}/>
            <CommitParents commit={new_commit} project={project} onClick={this.handleSubmitReference} />
            <br />
            <div style={{ marginTop: "10px" }}>
              <DoneAtTag commit={new_commit} />{" "}
              <BatchTags batch={new_ci_batch}/>
            </div>
            <CommitMessage
              commit={new_commit}
              style={{maxWidth: "450px"}}
              is_loaded={new_commit && new_commit.id && !this.props.commits[new_commit.id].is_loaded}
              on_refresh={() => this.props.dispatch(fetchCommit(project, new_commit.id, "new_commit_id")) }
            />
          </div>

          <div style={{ minWidth: "40px", textAlign: "center" }}>
            <span/>
          </div>
          <div style={{ flex: "1 1 auto" }}>
            <h1 className={Classes.HEADING} style={{ display: "flex", justifyContent: "flex-end", alignItems: "baseline"}}>
              {!!ref_commit && !!ref_commit.id &&
              <EditableText
                style={{
                  flex: "1 1 auto",
                  margin: "auto",
                  borderBottom: "2px solid rgb(100,100,100)"
                }}
                onConfirm={this.handleSubmitReference}
                intent={Intent.PRIMARY}
                defaultValue={shortId(project, ref_commit.id)}
              />}
              {(!ref_commit || !ref_commit.id) && empty_commit_id}
              <CommitAvatar commit={ref_commit} />
            </h1>
            <CommitBranchButton commit={new_commit} onClick={this.handleSubmitBranch} align_right/>
            <div style={{ marginTop: "10px", textAlign: "right" }}>
              <DoneAtTag commit={ref_commit} />{" "}
              <BatchTags batch={ref_ci_batch}/>
              {" "}
              <Tag intent={Intent.PRIMARY}>Reference</Tag>
            </div>
            <CommitMessage
              commit={ref_commit}
              style={{ display: "flex", justifyContent: "flex-end", textAlign: "right"}}
              is_loaded={ref_commit && ref_commit.id && !this.props.commits[ref_commit.id].is_loaded}
              on_refresh={() => this.props.dispatch(fetchCommit(project, ref_commit.id, "ref_commit_id")) }
            />
          </div>
        </div>
      </Card>
    );
  }

  handleSubmitReference = new_ref_commit_id => {
    const { project, dispatch } = this.props;
    if (!this.props.selected[project] || !this.props.selected[project].ref_commit_id)
      return
    const ref_commit_id = this.props.selected[project].ref_commit_id;
    if (!ref_commit_id.startsWith(new_ref_commit_id)) {
      dispatch(fetchCommit(project, new_ref_commit_id, "ref_commit_id"));
      dispatch(updateSelected(project, { ref_commit_id: new_ref_commit_id }))
    }
  };

  handleSubmitBranch = branch => {
    console.log(branch);
    const { project, dispatch } = this.props;
    dispatch(fetchCommit(project, null, "ref_commit_id", branch));
    dispatch(updateSelected(project, { ref_commit_id: branch }))
  };

}

export default connect(state => ({selected: state.selected, commits: state.commits}))(CommitInfoCompareCard)
