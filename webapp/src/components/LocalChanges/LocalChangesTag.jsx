// A run's local changes, in its card's header: "+40 −12 · 3 files". Clicking opens them.
import { lazy, Suspense, useContext, useState } from "react";
import { Classes, Intent, Tag, Tooltip } from "@blueprintjs/core";

import {
  LocalChangesSharedContext, changes_lines, changes_sentence, is_dirty, local_changes_of, omitted_message, saved_file, state_key, unpushed_text,
} from "./localChanges";

// The dialog shows the patch in Monaco: the commit page doesn't pay for it until someone opens it
const LocalChangesDialog = lazy(() => import("./LocalChangesDialog"));

// Renders the dialog only once opened. Same props as LocalChangesDialog.
export const LocalChangesDialogLoader = ({ isOpen, ...props }) => isOpen
  ? <Suspense fallback={null}><LocalChangesDialog isOpen {...props}/></Suspense>
  : null;

const TagTooltip = ({ changes }) => {
  const unpushed = unpushed_text(changes);
  const omitted = omitted_message(changes.patch);
  return <div style={{ maxWidth: 360 }}>
    {is_dirty(changes) === null
      ? <div>git couldn't tell whether this run had uncommitted changes{changes.timed_out ? ' (it took too long)' : ''}.</div>
      : <div>Uncommitted changes: {changes_sentence(changes)}</div>}
    {changes.branch && <div>Branch: <code>{String(changes.branch)}</code></div>}
    {unpushed && <div>Its commit: {unpushed}</div>}
    <div className={Classes.TEXT_MUTED}>
      {saved_file(changes, 'patch') ? 'The patch is saved: click to see it.' : (omitted ?? 'Click for details.')}
    </div>
  </div>;
};

const tag_style = { marginLeft: 5, cursor: 'pointer', fontVariantNumeric: 'tabular-nums' };

export const LocalChangesTag = ({ output, output_ref, style }) => {
  const [open, setOpen] = useState(false);
  const shared = useContext(LocalChangesSharedContext);
  const changes = local_changes_of(output);
  if (!changes) return null;
  const dirty = is_dirty(changes);
  if (dirty === false) return null;
  // the batch's callout already says it for all the runs
  if (shared !== null && shared === state_key(changes, output.id)?.key) return null;
  const text = dirty === null ? 'local changes unknown' : `uncommitted ${changes_lines(changes)}`;
  // a fact, quiet; a warning only when we can't say which code ran
  const warn = dirty === null || !saved_file(changes, 'patch');
  return <>
    <Tooltip content={<TagTooltip changes={changes}/>} hoverOpenDelay={300} placement="bottom">
      <Tag
        minimal
        interactive
        icon="git-new-branch"
        intent={warn ? Intent.WARNING : Intent.NONE}
        style={{ ...tag_style, ...style }}
        role="button"
        tabIndex={0}
        aria-label={dirty === null ? 'Local changes unknown: show details' : `Uncommitted changes, ${changes_sentence(changes)}: show them`}
        onClick={() => setOpen(true)}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(true); } }}
      >
        {text}
      </Tag>
    </Tooltip>
    <LocalChangesDialogLoader isOpen={open} onClose={() => setOpen(false)} output={output} output_ref={output_ref}/>
  </>;
};
