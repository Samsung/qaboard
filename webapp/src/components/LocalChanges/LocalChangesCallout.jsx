// Above the runs of local batches: which code they ran, said once for all the runs when they share it.
import { useState } from "react";
import { Button, Callout, Intent } from "@blueprintjs/core";

import { updateSelected } from "../../hooks";
import { LocalChangesDialogLoader } from "./LocalChangesTag";
import { changes_sentence, local_changes_view, saved_file, short_sha, unpushed_text } from "./localChanges";

const showLocalChangesView = () => updateSelected({ selected_views: local_changes_view });

// "2 with different uncommitted changes, 1 without, 1 unknown, 1 didn't record it"
const mixed_sentence = groups => {
  let changes = 0, sets = 0, exact = true, clean = 0, unknown = 0;
  for (const group of groups.groups) {
    if (group.kind === 'changes') {
      changes += group.count;
      sets += 1;
      exact = exact && group.exact;
    } else if (group.kind === 'clean') clean += group.count;
    else unknown += group.count;
  }
  const parts = [];
  if (changes > 0)
    parts.push(changes === 1 ? '1 with uncommitted changes'
      : sets > 1 ? `${changes} with different uncommitted changes`
      : exact ? `${changes} with the same uncommitted changes` : `${changes} with uncommitted changes`);
  if (clean > 0) parts.push(`${clean} without`);
  if (unknown > 0) parts.push(`${unknown} unknown`);
  if (groups.missing > 0) parts.push(`${groups.missing} didn't record it`);
  return parts.join(', ');
};

// groups: group_local_changes(the runs shown); find_reference: output => its reference run, for the dialog's comparison
export const LocalChangesCallout = ({ groups, find_reference }) => {
  const [open, setOpen] = useState(false);
  if (!groups?.has_data) return null;
  if (!groups.single) {
    const sentence = mixed_sentence(groups);
    return <Callout icon="git-new-branch" title={groups.groups.length > 1 ? `These runs didn't all run the same code: ${sentence}` : `Not all these runs recorded their code: ${sentence}`}>
      <Button size="small" icon="list-detail-view" text="See which runs" onClick={showLocalChangesView}/>
    </Callout>;
  }
  const { changes, output, kind } = groups.groups[0];
  const sha = <code>{short_sha(changes.head) || '?'}</code>;
  const unpushed = unpushed_text(changes);
  const unpushed_suffix = unpushed ? ` · ${unpushed}` : '';
  const viewable = kind !== 'clean' || !!saved_file(changes, 'unpushed');
  const title = kind === 'changes'
    ? <>Local runs on {sha} with uncommitted changes: {changes_sentence(changes)}{unpushed_suffix}</>
    : kind === 'clean'
      ? <>Local runs on {sha}, without local changes{unpushed_suffix}</>
      : <>Local runs on {sha}: git couldn't tell whether they had local changes{unpushed_suffix}</>;
  // the same tones as the runs' tags: a fact, a warning only when we can't say which code ran
  const intent = kind === 'clean' ? (changes.pushed === false ? Intent.NONE : Intent.SUCCESS) : kind === 'unknown' || !saved_file(changes, 'patch') ? Intent.WARNING : Intent.NONE;
  return <Callout
    icon={kind === 'changes' ? 'git-new-branch' : kind === 'clean' ? 'git-commit' : 'help'}
    intent={intent}
    title={title}
  >
    {viewable && <Button size="small" icon="eye-open" text={kind === 'changes' ? 'View changes' : 'View'} onClick={() => setOpen(true)}/>}
    <LocalChangesDialogLoader isOpen={open} onClose={() => setOpen(false)} output={output} output_ref={find_reference?.(output)}/>
  </Callout>;
};
