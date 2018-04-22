import React from "react";
import { Link } from "react-router-dom";
import { Card, Tag, Button, Icon, Intent, EditableText } from "@blueprintjs/core";

import Avatar from "./Avatar";
import { DoneAtTag } from "./DoneAtTag";


const CommitInfoCompareCard = ({new_commit, ref_commit, new_label, ref_label, onConfirmReference}) => {
  const empty_batch = {failed_slam_outputs: 0, valid_slam_outputs: 0, pending_slam_outputs: 0};
  let new_ci_batch = new_commit.batches[new_label] || empty_batch;
  let ref_ci_batch = ref_commit.batches[ref_label] || empty_batch;

  // <Tag intent={Intent.WARNING}>New commit</Tag>
  return <Card elevation={4}>
    <div style={{display:'flex', justifyContent: 'space-between', alignItems: 'center'}}>
      <div style={{flex:'1 1 auto', minWidth: '450px'}}>
        <h1 style={{display: 'flex', alignItems: 'baseline'}}><Avatar href={`/committer/${new_commit.committer_name}`} alt={new_commit.committer_name} src={new_commit.committer_avatar_url} />{new_commit.type==='git' ? new_commit.id.substring(0,8) : new_commit.id}</h1>
          <Link to={`/branch/${new_commit.branch}`}><Button icon="git-branch">{new_commit.branch}</Button></Link><Icon icon='git-commit'/> {new_commit.parents.length>1 ? 'parents' : 'parent'}: {new_commit.parents.map(p => <Button key={p} onClick={e=>{console.log(p); onConfirmReference(p)}}>{p.substring(0,8)}</Button>)}
          <br/>
          <div style={{marginTop: '10px'}}><DoneAtTag commit={new_commit} /> {new_ci_batch.valid_slam_outputs>0 && <Tag intent={Intent.SUCCESS}>{new_ci_batch.valid_slam_outputs} outputs</Tag>} {new_ci_batch.running_slam_outputs>0 && <Tag intent={Intent.SUCCESS}>{new_ci_batch.running_slam_outputs} running</Tag>} {new_ci_batch.pending_slam_outputs-new_ci_batch.running_slam_outputs>0 && <Tag>{new_ci_batch.pending_slam_outputs-new_ci_batch.running_slam_outputs} pending</Tag>} {new_ci_batch.failed_slam_outputs>0 && <Tag intent={Intent.DANGER}>{new_ci_batch.failed_slam_outputs} crashed</Tag>}</div>
          <p style={{marginTop: '10px', maxWidth:'450px'}} className="pt-monospace-text">{new_commit.message}</p>
        </div>
      <div style={{minWidth: '40px', textAlign: 'center'}}><Icon icon="small-cross"></Icon></div>
      <div style={{flex:'1 1 auto'}}>
          <h1 style={{display: 'flex', justifyContent: 'flex-end', alignItems: 'baseline'}}><EditableText style={{flex: '1 1 auto', margin:'auto', borderBottom: '2px solid rgb(100,100,100)'}} onConfirm={onConfirmReference} intent={Intent.PRIMARY} defaultValue={ref_commit.type==='git' ? ref_commit.id.substring(0,8) : ref_commit.id} /><Avatar href={`/committer/${ref_commit.committer_name}`} alt={ref_commit.committer_name} src={ref_commit.committer_avatar_url} /></h1>
          <span style={{display: 'flex', justifyContent: 'flex-end'}}><Link to={`/branch/${ref_commit.branch}`}><Button style={{flex: '1 1 auto', margin:'auto'}} icon="git-branch">{ref_commit.branch}</Button></Link></span>
          <div style={{marginTop: '10px', textAlign: 'right'}}><DoneAtTag commit={ref_commit} /> {ref_ci_batch.valid_slam_outputs>0 && <Tag intent={Intent.SUCCESS}>{ref_ci_batch.valid_slam_outputs} outputs</Tag>} {ref_ci_batch.running_slam_outputs>0 && <Tag intent={Intent.SUCCESS}>{ref_ci_batch.running_slam_outputs} running</Tag>} {ref_ci_batch.pending_slam_outputs-ref_ci_batch.running_slam_outputs>0 && <Tag>{ref_ci_batch.pending_slam_outputs-ref_ci_batch.running_slam_outputs} pending</Tag>} {ref_ci_batch.failed_slam_outputs>0 && <Tag intent={Intent.DANGER}>{ref_ci_batch.failed_slam_outputs} crashed</Tag>} <Tag intent={Intent.PRIMARY}>Reference</Tag></div>
          <p style={{display: 'flex', justifyContent: 'flex-end', textAlign: 'right', marginTop: '10px'}} className="pt-monospace-text">{ref_commit.message}</p>
      </div>
    </div>
  </Card>
}

export { CommitInfoCompareCard };
