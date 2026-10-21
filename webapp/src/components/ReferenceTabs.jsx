// Users can stack several references and compare the new commit with one at a time (src/selection.js).
// The references hang below the commit bars as tabs, so that the new and reference bars stay alike:
//   - with one reference, hovering its bar shows a handle below it: "Stack a reference"
//   - with several, tabs in their colors: click one to compare with it, drag them to reorder, double-click to rename,
//     right-click or "⋯" for the rest. "r" shows the next reference, "Shift r" the previous one.
//     Hovering a tab shows what the reference's bar would: its commit, batch, filter, runs, and if it's the same as new.
// A reference has one name, in its tab, the reference's bar and the viewers: see reference_names in src/selection.js.
// The references not shown are fetched without their outputs (commits can have thousands). Once the page is idle, we
// load the next and previous references' outputs, so that "r" shows them at once. Hovering a tab loads it too.
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import styled from "styled-components";
import { create } from "zustand";
import {
  Button,
  Classes,
  ContextMenu,
  Icon,
  InputGroup,
  Intent,
  Menu,
  MenuDivider,
  MenuItem,
  PopoverNext,
  Tooltip,
} from "@blueprintjs/core";
import { DateTime } from "luxon";

import { MilestonesPanel } from "../milestones/MilestonesPanel";
import { results_project } from "../milestones/api";
import { commitQuery, nb_outputs } from "../api/queries";
import { errorMessage } from "../api/http";
import { useComparison, useSiteConfig, updateSelected, usePrefetchCommitPage } from "../hooks";
import {
  add_reference, duplicate_reference, is_default_name, move_reference, remove_reference, rename_reference, show_reference, swap_with_top,
} from "../selection";
import { available_batch } from "../selectors/batches";
import { CommitAvatar } from "./avatars";
import { is_typing } from "./HelpSheet";
import { commit_bar_height, reference_tabs_height } from "./layout";
import { shortId, pretty_label } from "../utils";
import { toaster } from "../toaster";
import { sider_width } from "../AppSider";


// The menu to add a reference is opened from the tabs, the handle, or the reference bar's Change menu
const useAddMenu = create(set => ({ open: false, setOpen: open => set({ open }) }));
export const openAddReference = () => useAddMenu.getState().setOpen(true);

// Bigger commits take long to download and much memory: we load them only when users want to see them
const prefetch_max_outputs = 5000;

// Once the reference shown is loaded and the page idle, the references around it, with their outputs
function usePrefetchNeighbors(references, ref_index, ready) {
  const queryClient = useQueryClient();
  const n = references.length;
  const neighbors = [...new Set([(ref_index + 1) % n, (ref_index - 1 + n) % n])]
    .filter(index => index !== ref_index)
    .map(index => references[index])
    // we know how big they are once we have them without their outputs
    .filter(r => !!r.commit_id && !!r.commit?.batches && nb_outputs(r.commit) <= prefetch_max_outputs);
  const key = neighbors.map(r => `${r.project}/${r.commit_id}`).join(' ');
  useEffect(() => {
    if (!ready || !key || navigator.connection?.saveData) return;
    const idle = window.requestIdleCallback ?? (callback => setTimeout(callback, 200));
    const cancel = window.cancelIdleCallback ?? clearTimeout;
    const handle = idle(() => {
      for (const id of key.split(' ')) {
        const slash = id.lastIndexOf('/');
        queryClient.prefetchQuery(commitQuery({ project: id.slice(0, slash), id: id.slice(slash + 1) }));
      }
    }, { timeout: 5000 });
    return () => cancel(handle);
  }, [queryClient, ready, key]);
}

// Commit ids are hexadecimal, the rest are branches (or tags)
const is_commit_id = text => /^[0-9a-f]{6,40}$/i.test(text);

const Strip = styled.div`
  position: fixed;
  left: 0;
  right: 0;
  z-index: 9;
  height: ${reference_tabs_height}px;
  padding: 0 12px 0 calc(${sider_width} + 14px);
  display: flex;
  align-items: flex-start;
  gap: 8px;
  background: var(--qa-background);
  box-shadow: inset 0 -1px 0 var(--qa-border);
  transition: padding-left 150ms ease;
  container-type: inline-size;

  /* the tabs' wrappers (context menu, tooltip): they shrink down to the tabs' names, then the tabs scroll */
  .qa-tab-wrap {
    display: flex;
    flex: 0 1 auto;
  }

  /* the top results: their tab stays in place, the references scroll */
  .qa-tabs-top {
    flex: none;
    display: flex;
    max-width: 40%;
  }
  .qa-tabs-top .qa-tab-wrap {
    min-width: 0;
  }
  .qa-tabs-vs {
    flex: none;
    align-self: center;
    margin-top: -4px;
    font-size: 11px;
    font-style: italic;
  }
  /* many tabs scroll sideways: with the mouse wheel, a trackpad, or the keyboard ("r") */
  .qa-tabs {
    display: flex;
    align-items: flex-start;
    gap: 2px;
    min-width: 0;
    /* room for the insertion bar before the first tab and after the last */
    padding: 0 5px;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }
  .qa-tabs[data-overflow~="start"] {
    mask-image: linear-gradient(to right, transparent, black 24px);
  }
  .qa-tabs[data-overflow~="end"] {
    mask-image: linear-gradient(to left, transparent, black 24px);
  }
  .qa-tabs[data-overflow~="start"][data-overflow~="end"] {
    mask-image: linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent);
  }
  .qa-tabs-actions {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    height: ${reference_tabs_height - 4}px;
  }
  .qa-tabs-hint {
    font-size: 11px;
    white-space: nowrap;
  }
  /* while dragging a tab: where it would go, in words. It floats below the tabs: taking room would move them */
  .qa-tabs-drop-hint {
    position: absolute;
    top: calc(100% + 4px);
    right: 12px;
    z-index: 1;
    max-width: 420px;
    padding: 2px 8px;
    border-radius: 3px;
    background: var(--qa-surface);
    box-shadow: 0 0 0 1px var(--qa-border), 0 2px 6px rgba(17, 20, 24, 0.15);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--qa-text);
    pointer-events: none;
  }
  .qa-tabs-drop-hint strong {
    font-weight: 600;
  }
  .qa-tabs-hint kbd {
    display: inline-block;
    min-width: 16px;
    padding: 0 4px;
    margin: 0 1px;
    border-radius: 3px;
    box-shadow: inset 0 0 0 1px var(--qa-border);
    font: inherit;
    font-size: 10px;
    line-height: 16px;
    text-align: center;
  }
  @container (max-width: 1000px) {
    .qa-tabs-hint {
      display: none;
    }
  }
  /* narrow pages: names only, the rest is on hover */
  @container (max-width: 560px) {
    .qa-tabs .qa-tab-details, .qa-tabs-top .qa-tab-details {
      display: none;
    }
  }
`;

const Tab = styled.div`
  --side-color: ${props => props.$color};
  position: relative;
  flex: 0 1 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 360px;
  height: ${reference_tabs_height - 4}px;
  padding: 0 4px 0 10px;
  border-radius: 0 0 6px 6px;
  color: var(--qa-text-secondary);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  outline: none;
  transition: background-color 120ms ease, color 120ms ease;

  /* the two tabs in the bars, the top results and the reference shown, are lit: same surface, a line in their color */
  &[data-lit] {
    color: var(--qa-text);
    background: var(--qa-surface);
    box-shadow: 0 1px 2px rgba(17, 20, 24, 0.12), 1px 0 0 var(--qa-border), -1px 0 0 var(--qa-border), 0 1px 0 var(--qa-border);
  }
  &[data-lit]::after {
    content: "";
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--side-color);
  }
  &:not([data-lit]):hover {
    color: var(--qa-text);
    background: var(--qa-surface-alt);
  }
  &:focus-visible {
    box-shadow: inset 0 0 0 2px var(--side-color);
  }
  /* where a dragged tab would go: an insertion bar in the gap between the two tabs, with round ends */
  .qa-drop-marker {
    position: absolute;
    top: 3px;
    bottom: 3px;
    z-index: 1;
    width: 3px;
    border-radius: 2px;
    background: var(--qa-intent-primary);
    pointer-events: none;
  }
  .qa-drop-marker::before, .qa-drop-marker::after {
    content: "";
    position: absolute;
    left: -2px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: inherit;
  }
  .qa-drop-marker::before {
    top: -3px;
  }
  .qa-drop-marker::after {
    bottom: -3px;
  }
  &[data-drop="before"] .qa-drop-marker {
    left: -3.5px;
  }
  &[data-drop="after"] .qa-drop-marker {
    right: -3.5px;
  }
  /* dropped there, they swap */
  &[data-drop="swap"] {
    box-shadow: inset 0 0 0 2px var(--qa-intent-primary);
  }
  &[data-dragging] {
    opacity: 0.4;
  }

  .qa-tab-dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--side-color);
  }
  /* names stay whole, unless very long */
  .qa-tab-name {
    flex: none;
    max-width: 16em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  /* what tells it apart from the other references. It gives way first when there isn't room, one detail at a time:
     those that don't fit wrap to a second line, that is hidden. */
  .qa-tab-details {
    flex: 0 1 auto;
    display: flex;
    flex-wrap: wrap;
    align-content: flex-start;
    column-gap: 8px;
    min-width: 0;
    height: 16px;
    line-height: 16px;
    overflow: hidden;
    color: var(--qa-text-muted);
  }
  .qa-tab-detail {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    max-width: 100%;
    height: 16px;
  }
  .qa-tab-detail > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .qa-tab-detail .bp6-icon {
    flex: none;
  }
  .qa-tab-meta {
    flex: none;
    color: var(--qa-text-muted);
  }
  .qa-tab-menu {
    flex: none;
    opacity: 0;
  }
  &:hover .qa-tab-menu, &[data-lit] .qa-tab-menu, &:focus-within .qa-tab-menu, .qa-tab-menu[aria-expanded="true"] {
    opacity: 1;
  }
  input {
    min-width: 0;
    width: 120px;
    border: none;
    outline: none;
    padding: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-weight: 500;
  }
`;

// With one reference: below its bar, while users hover it
const Handle = styled.div`
  position: fixed;
  z-index: 9;
  left: calc(${sider_width} + 14px);
  opacity: 0;
  transform: translateY(-4px);
  pointer-events: none;
  transition: opacity 120ms ease, transform 120ms ease;
  .qa-ref-bar:hover ~ &, &:hover, &:focus-within, &[data-open] {
    opacity: 1;
    transform: none;
    pointer-events: auto;
  }
  .bp6-button {
    border-radius: 0 0 6px 6px;
    background: var(--qa-surface);
    box-shadow: 0 1px 2px rgba(17, 20, 24, 0.12), 1px 0 0 var(--qa-border), -1px 0 0 var(--qa-border), 0 1px 0 var(--qa-border);
    font-size: 12px;
  }
`;


// The batch a reference shows: the one selected, else the commit's only batch (like the reference's bar)
const reference_batch = reference => reference.commit?.batches ? available_batch(reference.commit, reference.batch) : reference.batch;

// What tells the references apart, next to their names: only what differs between them.
// All on the same branch: no branch. Different commits on the same branch: their commits. Batches and filters when
// they differ, except the default batch and no filter: "night" and "indoor" say what the copies of a reference changed.
// Milestones are told apart by their names: they don't show their branch or commit.
// Returns, for each reference, a list of {key, icon, text}
export const tabs_details = (references, project) => {
  const values = key => references.map(r => key(r));
  const varies = list => new Set(list).size > 1;
  const branches = values(r => r.commit?.branch ?? null);
  const commits = values(r => r.commit_id ?? null);
  const batches = values(r => reference_batch(r));
  const filters = values(r => r.filter ?? '');
  const projects = values(r => r.project);
  const show_branch = varies(branches.filter(Boolean));
  // references on the same branch (or whose branch we don't know yet) with different commits
  const show_commit = index => !!commits[index] && references.some((_, other) => other !== index
    && branches[other] === branches[index] && !!commits[other] && commits[other] !== commits[index]);
  // the most telling first: those that don't fit hide from the end
  return references.map((r, index) => [
    varies(batches) && batches[index] !== 'default' && { key: 'batch', icon: 'layers', text: pretty_label({ label: batches[index] }) },
    varies(filters) && !!filters[index] && { key: 'filter', icon: 'filter', text: filters[index] },
    !r.milestone && show_commit(index) && { key: 'commit', icon: 'git-commit', text: shortId(project, commits[index]) },
    !r.milestone && show_branch && branches[index] && { key: 'branch', icon: 'git-branch', text: branches[index] },
    varies(projects) && { key: 'project', icon: 'git-repo', text: r.project },
  ].filter(Boolean));
};

const Card = styled.div`
  width: 340px;
  max-width: 80vw;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  line-height: 1.4;
  .qa-card-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
  }
  .qa-card-title > span:first-of-type {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .qa-card-dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--side-color);
  }
  .qa-card-status {
    margin-left: auto;
    flex: none;
    font-weight: 400;
  }
  .qa-card-message {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .qa-card-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 10px;
  }
  .qa-card-row > span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .qa-card-hint {
    padding-top: 6px;
    border-top: 1px solid var(--qa-border);
  }
`;

// "120 runs · 3 failed · 2 running", like the reference bar's tags: tags don't read well in tooltips
const runs_text = batch => {
  const { valid_outputs = 0, running_outputs = 0, pending_outputs = 0, failed_outputs = 0 } = batch;
  return [
    `${valid_outputs} run${valid_outputs === 1 ? '' : 's'}`,
    failed_outputs > 0 ? `${failed_outputs} failed` : null,
    running_outputs > 0 ? `${running_outputs} running` : null,
    pending_outputs - running_outputs > 0 ? `${pending_outputs - running_outputs} pending` : null,
  ].filter(Boolean).join(' · ');
};

// Everything about a reference, on hover: what the reference's bar would show
const TabCard = ({ reference, project, batch_counts }) => {
  const { commit } = reference;
  const batch = reference_batch(reference);
  const loaded = !!commit?.batches && !!commit.id;
  const has_batch = !loaded || !!commit.batches[batch];
  const date = commit?.authored_datetime ? DateTime.fromISO(commit.authored_datetime, { zone: 'utc' }) : null;
  return <Card style={{ '--side-color': reference.color.css }}>
    <div className="qa-card-title">
      <span className="qa-card-dot"/>
      <span>{reference.display_label}</span>
      {!!reference.milestone && <Icon icon="star" size={12} title="A milestone"/>}
      <span className={`qa-card-status ${Classes.TEXT_MUTED}`}>
        {reference.is_top ? 'top bar' : reference.is_shown ? 'bottom bar' : `reference ${reference.number}`}
      </span>
    </div>
    {commit?.error
      ? <div className="qa-card-row"><span><Icon icon="error" size={12}/>Could not load it:</span><code>{String(commit.error)}</code></div>
      : <>
        {(commit?.committer_name || date) && <div className={`qa-card-row ${Classes.TEXT_MUTED}`}>
          {commit?.committer_name && <span><CommitAvatar commit={commit} project={reference.project} size="16px"/>{commit.committer_name}</span>}
          {date && <span title={date.toLocal().toLocaleString(DateTime.DATETIME_MED)}>{date.toRelative()}</span>}
        </div>}
        {commit?.message && <div className="qa-card-message">{commit.message}</div>}
        <div className={`qa-card-row ${Classes.TEXT_MUTED}`}>
          {reference.commit_id
            ? <span><Icon icon="git-commit" size={12}/><code>{shortId(project, reference.commit_id)}</code></span>
            : <span><Icon icon="git-commit" size={12}/>the latest commit with results</span>}
          {commit?.branch && <span><Icon icon="git-branch" size={12}/>{commit.branch}</span>}
          {reference.project !== project && <span><Icon icon="git-repo" size={12}/>{reference.project}</span>}
        </div>
      </>}
    <div className="qa-card-row">
      <span><span className={Classes.TEXT_MUTED}>Batch</span> <strong>{pretty_label({ label: batch })}</strong></span>
      {reference.filter && <span><span className={Classes.TEXT_MUTED}>Filter</span> <code>{reference.filter}</code></span>}
    </div>
    <div className="qa-card-row">
      <span><Icon icon="layers" size={12}/>
        {!loaded
          ? <span className={Classes.TEXT_MUTED}>Loading its runs…</span>
          : !has_batch
            ? (Object.keys(commit.batches).length ? 'No runs in this batch' : 'No runs yet')
            : <>{runs_text(batch_counts ?? commit.batches[batch])}{reference.filter && <span className={Classes.TEXT_MUTED}>{batch_counts ? 'match the filter' : 'in the batch, before the filter'}</span>}</>}
      </span>
    </div>
    <div className={`qa-card-hint ${Classes.TEXT_MUTED}`}>
      {reference.is_top
        ? 'The references are compared with it. Drag it on a reference to swap them'
        : reference.is_shown ? 'Compared with the top results. Drag it on them to swap them' : 'Click to compare with it'}
      {' '}· double-click to rename · right-click or ⋯ for more
    </div>
  </Card>;
};


// A tab: the top results (reference.is_top: the first tab, not one of the references), or a reference
const ReferenceTab = ({ reference, project, details, actions, batch_counts, dragging, drop, drag }) => {
  const prefetch = usePrefetchCommitPage(reference.project, reference.commit_id);
  const [renaming, setRenaming] = useState(null);
  const [menu_open, setMenuOpen] = useState(false);
  const element = useRef(null);
  // keep the reference shown in view, e.g. after "r"
  useEffect(() => {
    if (reference.is_shown) element.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [reference.is_shown]);

  // milestones are called by their name, also instead of the names we give, like "ref 2"
  const rename = () => setRenaming(reference.milestone && is_default_name(reference.label) ? '' : reference.label || '');
  const { is_top } = reference;
  const what = is_top ? 'Top' : `Reference ${reference.number}`;
  // Only the two bars swap: the top results with the reference shown. Nothing is replaced or removed.
  const swap = actions.swap && <MenuItem icon="swap-vertical" text="Swap the bars" label={`with ${actions.swap.name}`} disabled={!actions.swap.can} onClick={actions.swap.do}/>;
  const menu = <Menu>
    {!is_top && !reference.is_shown && <MenuItem icon="eye-open" text="Compare with it" onClick={actions.show}/>}
    {swap}
    <MenuItem icon="edit" text="Rename" onClick={rename}/>
    <MenuItem icon="duplicate" text={is_top ? "Add a copy as a reference" : "Duplicate"} label="to change its batch or filter" onClick={actions.duplicate}/>
    {!is_top && <>
      <MenuDivider/>
      <MenuItem icon="arrow-left" text="Move left" disabled={reference.index === 0} onClick={() => actions.move(reference.index - 1)}/>
      <MenuItem icon="arrow-right" text="Move right" disabled={reference.index === actions.count - 1} onClick={() => actions.move(reference.index + 1)}/>
      <MenuDivider/>
      <MenuItem icon="cross" text="Remove" intent={Intent.DANGER} onClick={actions.remove}/>
    </>}
  </Menu>;

  const done = () => {
    const value = renaming.trim();
    setRenaming(null);
    // typing the default name is clearing it
    const label = value === reference.default_label ? '' : value;
    if (label !== (reference.label ?? '')) actions.rename(label);
  };
  // clicks in the menu (in a portal) bubble to the tab through React: only those on the tab itself compare
  const on_tab = event => event.currentTarget.contains(event.target) && !event.target.closest?.('.qa-tab-menu');
  const tab = <Tab
    ref={element}
    role={is_top ? undefined : 'tab'}
    tabIndex={0}
    aria-selected={is_top ? undefined : reference.is_shown}
    aria-label={`${what}: ${[reference.display_label, ...details.map(d => d.text)].join(', ')}`}
    data-lit={reference.is_shown || undefined}
    data-top={is_top || undefined}
    $color={reference.color.css}
    draggable={renaming === null}
    data-dragging={dragging || undefined}
    data-drop={drop}
    {...prefetch}
    {...drag}
    onClick={event => renaming === null && on_tab(event) && actions.show?.()}
    onDoubleClick={event => on_tab(event) && rename()}
    onKeyDown={event => {
      if (renaming !== null || event.target !== event.currentTarget) return;
      if (event.key === 'F2') rename();
      if (is_top) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); actions.show(); }
      else if (event.key === 'Delete' || event.key === 'Backspace') actions.remove();
      else if (event.altKey && event.key === 'ArrowLeft') actions.move(reference.index - 1);
      else if (event.altKey && event.key === 'ArrowRight') actions.move(reference.index + 1);
    }}
  >
    {(drop === 'before' || drop === 'after') && <span className="qa-drop-marker" aria-hidden/>}
    <span className="qa-tab-dot"/>
    {renaming !== null
      ? <input
          autoFocus
          value={renaming}
          placeholder={reference.default_label}
          aria-label={`Rename ${is_top ? 'the top results' : `reference ${reference.number}`}`}
          maxLength={60}
          onChange={e => setRenaming(e.target.value)}
          onFocus={e => e.target.select()}
          onBlur={done}
          onClick={e => e.stopPropagation()}
          onDoubleClick={e => e.stopPropagation()}
          onKeyDown={e => {
            if (e.key === 'Enter') done();
            if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null); }
          }}
        />
      : <>
        <span className="qa-tab-name">{reference.display_label}</span>
        {reference.milestone && <Icon className="qa-tab-meta" icon="star" size={11} title="A milestone"/>}
        {details.length > 0 && <span className="qa-tab-details">
          {details.map(d => <span key={d.key} className="qa-tab-detail" title={`${d.key}: ${d.text}`}><Icon icon={d.icon} size={11}/><span>{d.text}</span></span>)}
        </span>}
      </>}
    <PopoverNext content={menu} placement="bottom-end" isOpen={menu_open} onInteraction={setMenuOpen}>
      <Button
        className="qa-tab-menu"
        size="small"
        variant="minimal"
        icon="more"
        aria-label={`${what}: more`}
        aria-expanded={menu_open}
        // not a drag of the tab
        draggable={false}
        onDragStart={e => { e.preventDefault(); e.stopPropagation(); }}
      />
    </PopoverNext>
  </Tab>;
  return <ContextMenu content={menu} className="qa-tab-wrap">
    <Tooltip
      content={<TabCard reference={reference} project={project} batch_counts={batch_counts}/>}
      disabled={renaming !== null || menu_open}
      hoverOpenDelay={500}
      placement="bottom-start"
      targetProps={{ className: 'qa-tab-wrap' }}
    >
      {tab}
    </Tooltip>
  </ContextMenu>;
};


// Add a commit, a branch's latest commit, or a milestone
const AddReferencePanel = ({ actions, can_duplicate }) => {
  const { docs_root } = useSiteConfig();
  const { project, project_data, references, selected } = useComparison();
  const [text, setText] = useState('');
  const shown = references[selected.ref_index];
  const reference_branch = project_data?.data?.qatools_config?.project?.reference_branch ?? 'master';
  const submit = () => {
    const value = text.trim();
    if (!value) return;
    if (is_commit_id(value)) actions.add({ project, commit_id: value });
    else actions.addBranch(value);
    setText('');
  };
  return <MilestonesPanel
    project={project}
    project_data={project_data}
    docs_root={docs_root}
    selected={{ project: shown.project, commit: shown.commit_id, batch: shown.batch, filter: shown.filter }}
    onSelect={actions.addMilestone}
    before={<>
      <MenuDivider title="Stack a reference"/>
      <li className={Classes.TEXT_MUTED} style={{ fontSize: 12, padding: '0 7px 6px', lineHeight: 1.4 }}>
        Compare with several references, one at a time: the new commit stays, switch references with their tabs or <kbd className={Classes.KEY}>r</kbd>.
      </li>
      <li style={{ padding: '2px 0 6px' }}>
        <InputGroup
          leftIcon="git-commit"
          placeholder="Commit or branch"
          aria-label="Add a commit or a branch as reference"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          rightElement={<Button variant="minimal" icon="plus" aria-label="Add" disabled={!text.trim()} onClick={submit}/>}
        />
      </li>
      <MenuItem text={reference_branch} label="reference branch" icon="git-branch" onClick={() => actions.addBranch(reference_branch)}/>
      {can_duplicate && <MenuItem text="This reference again" label="to change its batch or filter" icon="duplicate" onClick={() => actions.duplicate(selected.ref_index)}/>}
    </>}
  />;
};


// Tabs that don't fit scroll sideways: the mouse wheel scrolls them, the edges fade where there are more
function useSideScroll() {
  const element = useRef(null);
  useEffect(() => {
    const tabs = element.current;
    if (!tabs) return;
    const update = () => {
      const start = tabs.scrollLeft > 1;
      const end = tabs.scrollLeft + tabs.clientWidth < tabs.scrollWidth - 1;
      const value = [start && 'start', end && 'end'].filter(Boolean).join(' ');
      if (value) tabs.setAttribute('data-overflow', value);
      else tabs.removeAttribute('data-overflow');
    };
    const onWheel = event => {
      if (tabs.scrollWidth <= tabs.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      event.preventDefault();
      tabs.scrollLeft += event.deltaY;
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(tabs);
    for (const child of tabs.children) observer?.observe(child);
    tabs.addEventListener('scroll', update, { passive: true });
    tabs.addEventListener('wheel', onWheel, { passive: false });
    update();
    return () => {
      observer?.disconnect();
      tabs.removeEventListener('scroll', update);
      tabs.removeEventListener('wheel', onWheel);
    };
  });
  return element;
}


export const ReferenceTabs = () => {
  const queryClient = useQueryClient();
  const { project, selected, references, new_commit, compared } = useComparison();
  const adding = useAddMenu(state => state.open);
  const setAdding = useAddMenu(state => state.setOpen);
  // dragging: the index of the tab dragged, drop: where it would go
  const [dragging, setDragging] = useState(null);
  const [drop, setDrop] = useState(null);
  const several = references.length > 1;
  const tabs_element = useSideScroll();
  usePrefetchNeighbors(references, selected.ref_index, several && !!compared[1].commit?.is_loaded);
  // the actions need the commits' ids, e.g. the default reference's
  const resolved = { ...selected, references, new_commit_id: selected.new_commit_id || new_commit?.id || null };
  const show = index => updateSelected(show_reference(resolved, (index + references.length) % references.length));
  const add = side => {
    setAdding(false);
    updateSelected(add_reference(resolved, side));
  };
  const addBranch = async branch => {
    try {
      const commit = await queryClient.fetchQuery(commitQuery({ project, branch }));
      queryClient.setQueryData(commitQuery({ project, id: commit.id }).queryKey, commit);
      add({ project, commit_id: commit.id });
    } catch (error) {
      toaster.show({ message: `Could not find the latest commit on ${branch}: ${errorMessage(error)}`, intent: Intent.DANGER });
    }
  };
  const add_actions = {
    add,
    addBranch,
    addMilestone: milestone => {
      // milestones from qaboard.yaml are only a branch, tag or commit
      if (!milestone.commit && milestone.branch) return addBranch(milestone.branch);
      add({ project: results_project(milestone), commit_id: milestone.commit, batch: milestone.batch || 'default', filter: milestone.filter ?? '' });
    },
    duplicate: index => {
      setAdding(false);
      updateSelected(duplicate_reference(resolved, index, references[index].display_label));
    },
  };

  useEffect(() => {
    if (!several) return;
    const onKeyDown = event => {
      if (event.key.toLowerCase() !== 'r' || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || event.repeat) return;
      if (is_typing(event.target)) return;
      event.preventDefault();
      show(selected.ref_index + (event.shiftKey ? -1 : 1));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const strip_top = 2 * commit_bar_height;
  const add_panel = <AddReferencePanel actions={add_actions} can_duplicate={!!references[selected.ref_index]?.commit_id}/>;
  const popover_props = { content: add_panel, isOpen: adding, onInteraction: setAdding, placement: 'bottom-start' };

  if (!several)
    return <Handle style={{ top: strip_top }} data-open={adding || undefined}>
      <PopoverNext {...popover_props}>
        <Tooltip content="Compare with several references, one at a time" hoverOpenDelay={500} placement="right">
          <Button size="small" icon="layers" aria-label="Stack a reference">Stack a reference</Button>
        </Tooltip>
      </PopoverNext>
    </Handle>;

  // The first tab: the top results. The references are compared with them.
  const top = {
    is_top: true,
    is_shown: true,
    key: 'top',
    project: compared[0].project,
    commit: new_commit ?? undefined,
    commit_id: new_commit?.id ?? selected.new_commit_id ?? null,
    batch: selected.selected_batch_new,
    filter: selected.filter_batch_new,
    label: selected.label_new,
    display_label: compared[0].label,
    default_label: compared[0].default_label,
    milestone: compared[0].milestone,
    color: compared[0].color,
  };
  const shown = references[selected.ref_index];
  // the tabs in the bars are loaded with their runs: we know how many match their filters
  const filtered_counts = (side, filter) => filter && side.batch?.filtered?.valid_outputs !== undefined ? side.batch.filtered : undefined;
  // what tells them apart, the top results included
  const [top_details, ...details] = tabs_details([top, ...references], project);
  const swap = index => updateSelected(swap_with_top(resolved, index));
  const can_swap = index => !!references[index]?.commit_id && !!resolved.new_commit_id;

  // Dragging a reference among the others moves it. Dragging it on the top tab, or the top tab on it, swaps them:
  // they go in the bars, the top one in the bottom bar. drop: {index ('top' or a reference's), side: before|after|swap}
  const drag_props = index => ({
    onDragStart: event => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
      setDragging(index);
    },
    onDragOver: event => {
      if (dragging === null || dragging === index) return;
      const swapping = dragging === 'top' || index === 'top';
      if (swapping && !can_swap(index === 'top' ? dragging : index)) return;
      event.preventDefault();
      const { left, width } = event.currentTarget.getBoundingClientRect();
      const side = swapping ? 'swap' : event.clientX < left + width / 2 ? 'before' : 'after';
      if (drop?.index !== index || drop?.side !== side) setDrop({ index, side });
    },
    onDrop: event => {
      event.preventDefault();
      if (dragging !== null && drop) {
        if (drop.side === 'swap') swap(drop.index === 'top' ? dragging : drop.index);
        else {
          const to = drop.index + (drop.side === 'after' ? 1 : 0) - (dragging < drop.index + (drop.side === 'after' ? 1 : 0) ? 1 : 0);
          updateSelected(move_reference(resolved, dragging, to));
        }
      }
      setDragging(null);
      setDrop(null);
    },
    onDragEnd: () => {
      setDragging(null);
      setDrop(null);
    },
  });
  // Where the dragged tab would go, as the gap before a reference: dropping it next to itself doesn't move it
  const drop_gap = drop && drop.side !== 'swap' ? drop.index + (drop.side === 'after' ? 1 : 0) : null;
  const moves_nowhere = drop_gap !== null && (drop_gap === dragging || drop_gap === dragging + 1);
  const drop_on = index => drop?.index === index && dragging !== index && !moves_nowhere ? drop.side : undefined;
  const name = index => <strong>{index === 'top' ? top.display_label : references[index].display_label}</strong>;
  let drop_hint = null;
  if (dragging !== null) {
    if (!drop) drop_hint = dragging === 'top'
      ? <>Drop on a reference to swap it with {name('top')}</>
      : <>Drop between two references to move {name(dragging)}, or on {name('top')} to swap them</>;
    else if (drop.side === 'swap') drop_hint = <>Swap {name(dragging)} with {name(dragging === 'top' ? drop.index : 'top')}</>;
    else if (moves_nowhere) drop_hint = <>{name(dragging)} is already there</>;
    else {
      const others = references.map(r => r.index).filter(i => i !== dragging);
      const left = others.filter(i => i < drop_gap).at(-1);
      const right = others.find(i => i >= drop_gap);
      drop_hint = left === undefined ? <>Move {name(dragging)} first, before {name(right)}</>
        : right === undefined ? <>Move {name(dragging)} last, after {name(left)}</>
        : <>Move {name(dragging)} between {name(left)} and {name(right)}</>;
    }
  }

  return <Strip style={{ top: strip_top }}>
    <div className="qa-tabs-top">
      <ReferenceTab
        reference={top}
        project={project}
        details={top_details}
        batch_counts={filtered_counts(compared[0], selected.filter_batch_new)}
        dragging={dragging === 'top'}
        drop={drop_on('top')}
        drag={drag_props('top')}
        actions={{
          rename: label => updateSelected({ label_new: label }),
          duplicate: () => updateSelected(add_reference(resolved, { project: top.project, commit_id: top.commit_id, batch: top.batch, filter: top.filter, label: top.label || top.milestone ? `${top.display_label} copy` : undefined })),
          swap: { name: shown.display_label, can: can_swap(selected.ref_index), do: () => swap(selected.ref_index) },
        }}
      />
    </div>
    <span className={`qa-tabs-vs ${Classes.TEXT_MUTED}`} aria-hidden>vs</span>
    <div className="qa-tabs" role="tablist" aria-label="References" ref={tabs_element}>
      {references.map(reference => <ReferenceTab
        key={reference.index}
        reference={reference}
        project={project}
        details={details[reference.index]}
        batch_counts={reference.is_shown ? filtered_counts(compared[1], selected.filter_batch_ref) : undefined}
        dragging={dragging === reference.index}
        drop={drop_on(reference.index)}
        drag={drag_props(reference.index)}
        actions={{
          count: references.length,
          show: () => show(reference.index),
          remove: () => updateSelected(remove_reference(resolved, reference.index)),
          rename: label => updateSelected(rename_reference(resolved, reference.index, label)),
          duplicate: () => updateSelected(duplicate_reference(resolved, reference.index, reference.display_label)),
          move: to => updateSelected(move_reference(resolved, reference.index, to)),
          // only the reference in the bottom bar swaps with the top results
          swap: reference.is_shown ? { name: top.display_label, can: can_swap(reference.index), do: () => swap(reference.index) } : undefined,
        }}
      />)}
    </div>
    <div className="qa-tabs-actions">
      <PopoverNext {...popover_props}>
        <Tooltip content="Stack another reference" hoverOpenDelay={300}>
          <Button size="small" variant="minimal" icon="plus" aria-label="Stack a reference"/>
        </Tooltip>
      </PopoverNext>
      <span className={`qa-tabs-hint ${Classes.TEXT_MUTED}`}>
        <kbd>r</kbd> next · <kbd>⇧ r</kbd> previous
      </span>
    </div>
    {drop_hint && <span className="qa-tabs-drop-hint" aria-live="polite">{drop_hint}</span>}
  </Strip>;
};
