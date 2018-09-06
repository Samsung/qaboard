import React from "react";
import { Link } from "react-router-dom";
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
    const { commit, style } = this.props;
    if (!commit)
      return <p className={`${Classes.SKELETON} ${Classes.MONOSPACE_TEXT}`}>This is a placeholder for the commit message. Yep.</p>
    return <p style={{ marginTop: "10px", ...style}} className={Classes.MONOSPACE_TEXT} >
      {commit.message}
    </p>
  }
}


class CommitBranchButton extends React.PureComponent {
  render() {
    const { commit, align_right } = this.props;
    const outer_style_align_right = { display: "flex", justifyContent: "flex-end" }
    const inner_style_align_right = { flex: "1 1 auto", margin: "auto" }
    return <span style={align_right && outer_style_align_right}>
      <Link to={commit ? `/branch/${commit.branch}` : '#'}>
        <Button className={!!commit ? null : Classes.SKELETON} style={align_right &&  inner_style_align_right} icon="git-branch" >
          {!!commit ? commit.branch : 'master'}
        </Button>
      </Link>
    </span>
  }
}


const git_commit_icon = <Icon icon="git-commit" style={{verticalAlign: 'middle', margin: '5px'}} />



class CommitInfoCompareCard extends React.PureComponent {
  render() {
    const { project } = this.props;
    const { ref_commit, ref_label, onConfirmReference } = this.props;
    const { new_commit, new_label } = this.props;

    let new_ci_batch = (new_commit && new_commit.batches && new_commit.batches[new_label]) || empty_batch;
    let ref_ci_batch = (ref_commit && ref_commit.batches && ref_commit.batches[ref_label]) || empty_batch;

    // let maybe_skeletton_class = !!new_commit ? Classes.SKELETON : null

    return (
      <Card elevation={4} style={{minHeight: '193px'}}>
        <div style={outer_div_style}>

          <div style={{ flex: "1 1 auto", minWidth: "450px" }}>
            <h1 className={Classes.HEADING} style={{ display: "flex", alignItems: "baseline" }}>
              <CommitAvatar commit={new_commit} />
              {(!!new_commit && !!new_commit.id) ? shortId(project, new_commit.id) : null}
            </h1>
            <CommitBranchButton commit={new_commit}/>
            <CommitParents commit={new_commit} project={project} onClick={onConfirmReference} />
            <br />
            <div style={{ marginTop: "10px" }}>
              <DoneAtTag commit={new_commit} />{" "}
              <BatchTags batch={new_ci_batch}/>
            </div>
            <CommitMessage commit={new_commit} style={{maxWidth: "450px"}}/>
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
                onConfirm={onConfirmReference}
                intent={Intent.PRIMARY}
                defaultValue={shortId(project, ref_commit.id)}
              />}
              {(!ref_commit || !ref_commit.id) && <span className={Classes.SKELETON}>XXXXXXXX</span>}
              <CommitAvatar commit={ref_commit} />
            </h1>
            <CommitBranchButton commit={new_commit} align_right/>
            <div style={{ marginTop: "10px", textAlign: "right" }}>
              <DoneAtTag commit={ref_commit} />{" "}
              <BatchTags batch={ref_ci_batch}/>
              {" "}
              <Tag intent={Intent.PRIMARY}>Reference</Tag>
            </div>
            <CommitMessage commit={ref_commit} style={{ display: "flex", justifyContent: "flex-end", textAlign: "right"}}/>
          </div>
        </div>
      </Card>
    );
  }
}


export { CommitInfoCompareCard };
