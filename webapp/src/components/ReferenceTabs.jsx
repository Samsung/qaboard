// Users can stack several references and compare the new commit with one at a time (src/selection.js).
// The references hang below the commit bars as tabs, so that the new and reference bars stay alike:
//   - with one reference, hovering its bar shows a handle below it: "Stack a reference"
//   - with several, tabs in their colors: click one to compare with it, drag them to reorder, double-click to rename,
//     right-click or "⋯" for the rest. "r" shows the next reference, "Shift r" the previous one.
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

import { MilestonesPanel } from "../milestones/MilestonesPanel";
import { milestone_name, results_project } from "../milestones/api";
import { commitQuery, nb_outputs } from "../api/queries";
import { errorMessage } from "../api/http";
import { useComparison, useSiteConfig, updateSelected, usePrefetchCommitPage } from "../hooks";
import {
  add_reference, duplicate_reference, move_reference, remove_reference, rename_reference, same_side, show_as_new, show_reference,
} from "../selection";
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

// What a tab calls a reference: what users called it, else its milestone, its branch, its commit
const tab_name = (reference, project) => (reference.milestone ? milestone_name(reference.milestone) : reference.label)
  || reference.commit?.branch
  || (reference.commit_id ? shortId(project, reference.commit_id) : 'Latest on the reference branch');


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

  /* the tabs' wrappers (context menu, tooltip) */
  .qa-tab-wrap {
    display: flex;
    flex: 0 1 auto;
    min-width: 0;
  }

  .qa-tabs {
    display: flex;
    align-items: flex-start;
    gap: 2px;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
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
  @container (max-width: 700px) {
    .qa-tabs-hint {
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
  min-width: 96px;
  max-width: 240px;
  height: ${reference_tabs_height - 4}px;
  padding: 0 4px 0 10px;
  border-radius: 0 0 6px 6px;
  color: var(--qa-text-secondary);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  outline: none;
  transition: background-color 120ms ease, color 120ms ease;

  /* the tab of the reference shown hangs from its bar: same surface, a line in its color */
  &[aria-selected="true"] {
    color: var(--qa-text);
    background: var(--qa-surface);
    box-shadow: 0 1px 2px rgba(17, 20, 24, 0.12), 1px 0 0 var(--qa-border), -1px 0 0 var(--qa-border), 0 1px 0 var(--qa-border);
  }
  &[aria-selected="true"]::after {
    content: "";
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--side-color);
  }
  &[aria-selected="false"]:hover {
    color: var(--qa-text);
    background: var(--qa-surface-alt);
  }
  &:focus-visible {
    box-shadow: inset 0 0 0 2px var(--side-color);
  }
  /* where a dragged tab would go */
  &[data-drop="before"]::before, &[data-drop="after"]::before {
    content: "";
    position: absolute;
    top: 4px;
    bottom: 4px;
    width: 2px;
    border-radius: 1px;
    background: var(--qa-intent-primary);
  }
  &[data-drop="before"]::before {
    left: -2px;
  }
  &[data-drop="after"]::before {
    right: -2px;
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
  .qa-tab-number {
    flex: none;
    font-variant-numeric: tabular-nums;
    color: var(--qa-text-muted);
  }
  .qa-tab-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .qa-tab-meta {
    flex: none;
    color: var(--qa-text-muted);
  }
  .qa-tab-menu {
    flex: none;
    opacity: 0;
  }
  &:hover .qa-tab-menu, &[aria-selected="true"] .qa-tab-menu, &:focus-within .qa-tab-menu {
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


// Everything about a reference, on hover
const TabTooltip = ({ reference, project, same_as_new }) => <div style={{ maxWidth: 360 }}>
  <div><strong>{reference.display_label}</strong>{reference.milestone && <> · milestone</>}</div>
  {reference.commit?.message && <div style={{ marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{reference.commit.message}</div>}
  <div className={Classes.TEXT_MUTED} style={{ marginTop: 4 }}>
    {[
      reference.commit_id ? shortId(project, reference.commit_id) : null,
      reference.commit?.branch,
      reference.batch !== 'default' ? `batch: ${pretty_label({ label: reference.batch })}` : null,
      reference.filter ? `filter: ${reference.filter}` : null,
      reference.project !== project ? reference.project : null,
    ].filter(Boolean).join(' · ')}
  </div>
  {same_as_new && <div style={{ marginTop: 4 }}>The same results as new: nothing to compare.</div>}
</div>;


const ReferenceTab = ({ reference, project, actions, same_as_new, dragging, drop, drag }) => {
  const prefetch = usePrefetchCommitPage(reference.project, reference.commit_id);
  const [renaming, setRenaming] = useState(null);
  const element = useRef(null);
  const can_rename = !reference.milestone;
  // keep the reference shown in view, e.g. after "r"
  useEffect(() => {
    if (reference.is_shown) element.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [reference.is_shown]);

  const menu = <Menu>
    {!reference.is_shown && <MenuItem icon="eye-open" text="Compare with it" onClick={actions.show}/>}
    <MenuItem icon="edit" text="Rename" disabled={!can_rename} title={can_rename ? undefined : "Milestones are named after themselves"} onClick={() => setRenaming(reference.label || '')}/>
    <MenuItem icon="duplicate" text="Duplicate" label="to change its batch or filter" onClick={actions.duplicate}/>
    <MenuItem icon="chevron-up" text="Show as the new results" disabled={!actions.can_show_as_new} onClick={actions.show_as_new}/>
    <MenuDivider/>
    <MenuItem icon="arrow-left" text="Move left" disabled={reference.index === 0} onClick={() => actions.move(reference.index - 1)}/>
    <MenuItem icon="arrow-right" text="Move right" disabled={reference.index === actions.count - 1} onClick={() => actions.move(reference.index + 1)}/>
    <MenuDivider/>
    <MenuItem icon="cross" text="Remove" intent={Intent.DANGER} onClick={actions.remove}/>
  </Menu>;

  const done = () => {
    const value = renaming.trim();
    setRenaming(null);
    if (value !== (reference.label ?? '')) actions.rename(value);
  };
  const tab = <Tab
    ref={element}
    role="tab"
    tabIndex={0}
    aria-selected={reference.is_shown}
    aria-label={`Reference ${reference.number}: ${tab_name(reference, project)}`}
    $color={reference.color.css}
    draggable={renaming === null}
    data-dragging={dragging || undefined}
    data-drop={drop}
    {...prefetch}
    {...drag}
    onClick={() => renaming === null && actions.show()}
    onDoubleClick={() => can_rename && setRenaming(reference.label || '')}
    onKeyDown={event => {
      if (renaming !== null || event.target !== event.currentTarget) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); actions.show(); }
      else if (event.key === 'F2' && can_rename) setRenaming(reference.label || '');
      else if (event.key === 'Delete' || event.key === 'Backspace') actions.remove();
      else if (event.altKey && event.key === 'ArrowLeft') actions.move(reference.index - 1);
      else if (event.altKey && event.key === 'ArrowRight') actions.move(reference.index + 1);
    }}
  >
    <span className="qa-tab-dot"/>
    <span className="qa-tab-number">{reference.number}</span>
    {renaming !== null
      ? <input
          autoFocus
          value={renaming}
          placeholder={tab_name({ ...reference, label: '' }, project)}
          aria-label={`Rename reference ${reference.number}`}
          maxLength={60}
          onChange={e => setRenaming(e.target.value)}
          onFocus={e => e.target.select()}
          onBlur={done}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => {
            if (e.key === 'Enter') done();
            if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null); }
          }}
        />
      : <span className="qa-tab-name">{tab_name(reference, project)}</span>}
    {!!reference.milestone && <Icon className="qa-tab-meta" icon="star" size={11} title="A milestone"/>}
    {same_as_new && <span className="qa-tab-meta" title="The same results as new">= new</span>}
    <PopoverNext content={menu} placement="bottom-end">
      <Button className="qa-tab-menu" size="small" variant="minimal" icon="more" aria-label={`Reference ${reference.number}: more`} onClick={e => e.stopPropagation()}/>
    </PopoverNext>
  </Tab>;
  return <ContextMenu content={menu} className="qa-tab-wrap">
    <Tooltip
      content={<TabTooltip reference={reference} project={project} same_as_new={same_as_new}/>}
      disabled={renaming !== null}
      hoverOpenDelay={600}
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


export const ReferenceTabs = () => {
  const queryClient = useQueryClient();
  const { project, selected, references, new_commit, compared } = useComparison();
  const adding = useAddMenu(state => state.open);
  const setAdding = useAddMenu(state => state.setOpen);
  // dragging: the index of the tab dragged, drop: where it would go
  const [dragging, setDragging] = useState(null);
  const [drop, setDrop] = useState(null);
  const several = references.length > 1;
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
      updateSelected(duplicate_reference(resolved, index));
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

  const top = 2 * commit_bar_height;
  const add_panel = <AddReferencePanel actions={add_actions} can_duplicate={!!references[selected.ref_index]?.commit_id}/>;
  const popover_props = { content: add_panel, isOpen: adding, onInteraction: setAdding, placement: 'bottom-start' };

  if (!several)
    return <Handle style={{ top }} data-open={adding || undefined}>
      <PopoverNext {...popover_props}>
        <Tooltip content="Compare with several references, one at a time" hoverOpenDelay={500} placement="right">
          <Button size="small" icon="layers" aria-label="Stack a reference">Stack a reference</Button>
        </Tooltip>
      </PopoverNext>
    </Handle>;

  const new_side = { project: compared[0].project, commit_id: new_commit?.id ?? selected.new_commit_id, batch: compared[0].batch?.label ?? selected.selected_batch_new, filter: selected.filter_batch_new };
  const drag_props = index => ({
    onDragStart: event => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
      setDragging(index);
    },
    onDragOver: event => {
      if (dragging === null) return;
      event.preventDefault();
      const { left, width } = event.currentTarget.getBoundingClientRect();
      const side = event.clientX < left + width / 2 ? 'before' : 'after';
      if (drop?.index !== index || drop?.side !== side) setDrop({ index, side });
    },
    onDrop: event => {
      event.preventDefault();
      if (dragging !== null && drop) {
        const to = drop.index + (drop.side === 'after' ? 1 : 0) - (dragging < drop.index + (drop.side === 'after' ? 1 : 0) ? 1 : 0);
        updateSelected(move_reference(resolved, dragging, to));
      }
      setDragging(null);
      setDrop(null);
    },
    onDragEnd: () => {
      setDragging(null);
      setDrop(null);
    },
  });

  return <Strip style={{ top }}>
    <div className="qa-tabs" role="tablist" aria-label="References">
      {references.map(reference => <ReferenceTab
        key={reference.index}
        reference={reference}
        project={project}
        same_as_new={same_side(reference, new_side)}
        dragging={dragging === reference.index}
        drop={drop?.index === reference.index && dragging !== reference.index ? drop.side : undefined}
        drag={drag_props(reference.index)}
        actions={{
          count: references.length,
          show: () => show(reference.index),
          remove: () => updateSelected(remove_reference(resolved, reference.index)),
          rename: label => updateSelected(rename_reference(resolved, reference.index, label)),
          duplicate: () => updateSelected(duplicate_reference(resolved, reference.index)),
          move: to => updateSelected(move_reference(resolved, reference.index, to)),
          can_show_as_new: !!reference.commit_id && !!resolved.new_commit_id,
          show_as_new: () => updateSelected(show_as_new(resolved, reference.index)),
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
  </Strip>;
};
