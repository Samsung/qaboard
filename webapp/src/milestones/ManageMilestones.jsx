// Managing milestones: all of a project's milestones in a table, sorted by date or name, to edit, delete, move to
// a group or share several at once, open one, use one as the reference, or compare two.
import { useState } from "react";
import { create } from "zustand";
import styled from "styled-components";
import {
  Alert,
  Button,
  Checkbox,
  Classes,
  Colors,
  ControlGroup,
  Dialog,
  DialogBody,
  DialogFooter,
  HTMLSelect,
  HTMLTable,
  Icon,
  InputGroup,
  Intent,
  NonIdealState,
  SegmentedControl,
  Tooltip,
} from "@blueprintjs/core";

import { history } from "../router";
import { updateSelected, useSelected } from "../selection";
import { useUser } from "../hooks";
import { match_query, pretty_label } from "../utils";
import { copyWithToast } from "../utils/clipboard";
import {
  milestone_name, milestone_url, owner_name, relative_date, results_project, milestone_location,
  milestone_selection_changes, comparison_path, comparison_url, normalize_group,
} from "./api";
import { useMilestones, useMilestoneActions } from "./hooks";
import { openMilestoneDialog } from "./MilestoneDialog";


// One dialog for the whole app, like MilestoneDialog: openManageMilestones({ project })
const useManageStore = create(() => ({ props: null }));
export const openManageMilestones = props => useManageStore.setState({ props: { ...props, opened: Date.now() } });
const closeManageMilestones = () => useManageStore.setState(state => ({ props: state.props && { ...state.props, closed: true } }));

export const ManageMilestonesHost = () => {
  const props = useManageStore(state => state.props);
  if (!props) return null;
  return <ManageMilestones key={props.opened} {...props} isOpen={!props.closed} onClose={closeManageMilestones}/>;
};


const Table = styled(HTMLTable)`
  width: 100%;
  td, th {
    vertical-align: middle !important;
  }
  td {
    font-size: 13px;
  }
  .qa-name {
    font-weight: 500;
  }
  .qa-sub {
    font-size: 12px;
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .qa-actions {
    white-space: nowrap;
    text-align: right;
  }
  tr.qa-checked td {
    background: rgba(45, 114, 210, 0.1);
  }
`;

const search_text = m => [
  m.label, m.group, m.notes, m.branch, m.batch, pretty_label({ label: m.batch || 'default' }), m.filter, m.commit, m.message,
  m.owner?.full_name, m.owner?.user_name, m.shared ? 'shared' : 'personal',
].filter(Boolean).join(' ');

const sorts = {
  updated: { label: 'Last updated', compare: (a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '') },
  created: { label: 'Last created', compare: (a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '') },
  name: { label: 'Name', compare: (a, b) => milestone_name(a).localeCompare(milestone_name(b)) },
  group: { label: 'Group', compare: (a, b) => (a.group || '￿').localeCompare(b.group || '￿') || milestone_name(a).localeCompare(milestone_name(b)) },
};

const scopes = [
  { label: 'All', value: 'all' },
  { label: 'Mine', value: 'mine' },
  { label: 'Shared', value: 'shared' },
  { label: 'Favorites', value: 'favorites' },
];
const in_scope = {
  all: () => true,
  mine: m => m.is_mine,
  shared: m => m.shared,
  favorites: m => m.is_favorite,
};


export const ManageMilestones = ({ isOpen, onClose, project }) => {
  const user = useUser();
  const selected = useSelected();
  const on_commit_page = selected.route.is_commit;
  const { list, isPending } = useMilestones(project);
  const { toggleFavorite, updateMany, removeMany } = useMilestoneActions(project);
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState('all');
  const [sort, setSort] = useState('updated');
  const [checked, setChecked] = useState(() => new Set());
  const [move_to, setMoveTo] = useState('');
  const [confirm_delete, setConfirmDelete] = useState(false);
  // with 2 milestones checked: which one is the reference
  const [swapped, setSwapped] = useState(false);

  const matcher = match_query(search);
  const rows = list.filter(in_scope[scope]).filter(m => matcher(search_text(m))).sort(sorts[sort].compare);
  const chosen = list.filter(m => checked.has(m.id));
  const editable = chosen.filter(m => m.can_edit);
  const not_editable = chosen.length - editable.length;
  const groups = [...new Set(list.filter(m => m.is_mine || m.shared).map(m => m.group).filter(Boolean))].sort();
  const [first, second] = [...chosen].sort(sorts.updated.compare);
  const [compared_new, compared_ref] = swapped ? [second, first] : [first, second];

  const toggle = id => setChecked(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const all_checked = rows.length > 0 && rows.every(m => checked.has(m.id));
  const toggleAll = () => setChecked(all_checked ? new Set() : new Set(rows.map(m => m.id)));

  // On a commit page we keep the other side of the comparison
  const open = m => {
    onClose();
    if (on_commit_page) updateSelected(milestone_selection_changes(m, 'new'));
    else history.push(milestone_location(m));
  };
  const selectAsReference = m => {
    onClose();
    updateSelected(milestone_selection_changes(m, 'ref'));
  };
  const compare = () => {
    onClose();
    history.push(comparison_path(compared_new, compared_ref));
  };
  const done = () => setChecked(new Set());

  return <Dialog
    isOpen={isOpen}
    onClose={onClose}
    title="Milestones"
    icon="properties"
    style={{ width: 1080, maxWidth: 'calc(100vw - 32px)' }}
  >
    <DialogBody style={{ maxHeight: '65vh', overflowY: 'auto', paddingTop: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 1, padding: '12px 0 8px', background: 'inherit' }}>
        <InputGroup
          leftIcon="search"
          placeholder="Search by name, group, notes, branch, batch, owner…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          aria-label="Search milestones"
          style={{ minWidth: 300 }}
        />
        <SegmentedControl options={scopes} value={scope} onValueChange={setScope} size="small"/>
        <span style={{ flex: 1 }}/>
        <label className={Classes.TEXT_MUTED} style={{ fontSize: 13 }}>
          Sort by{' '}
          <HTMLSelect
            value={sort}
            onChange={e => setSort(e.target.value)}
            options={Object.entries(sorts).map(([value, { label }]) => ({ value, label }))}
            aria-label="Sort by"
          />
        </label>
      </div>
      {rows.length === 0
        ? <NonIdealState
            icon={isPending ? 'refresh' : 'search'}
            title={isPending ? 'Loading the milestones' : list.length === 0 ? 'No milestones yet' : 'No milestone matches'}
            description={list.length === 0 && !isPending ? 'Save one with the star next to a commit’s hash.' : undefined}
          />
        : <Table compact interactive>
            <thead>
              <tr>
                <th style={{ width: 28 }}><Checkbox checked={all_checked} indeterminate={!all_checked && rows.some(m => checked.has(m.id))} onChange={toggleAll} aria-label="Select all" style={{ margin: 0 }}/></th>
                <th>Name</th>
                <th>Results</th>
                <th>Commit</th>
                <th>Saved by</th>
                <th>{sort === 'created' ? 'Created' : 'Updated'}</th>
                <th aria-label="Actions"/>
              </tr>
            </thead>
            <tbody>
              {rows.map(m => <tr key={m.id} className={checked.has(m.id) ? 'qa-checked' : undefined}>
                <td><Checkbox checked={checked.has(m.id)} onChange={() => toggle(m.id)} aria-label={`Select ${milestone_name(m)}`} style={{ margin: 0 }}/></td>
                <td>
                  <div className="qa-name">
                    <Icon icon={m.shared ? 'crown' : 'star'} color={Colors.GOLD4} size={12} title={m.shared ? 'Shared with the project' : 'Personal'} style={{ marginRight: 6 }}/>
                    {milestone_name(m)}
                    {m.is_favorite && <Icon icon="heart" color={Colors.RED4} size={12} title="Favorite" style={{ marginLeft: 6 }}/>}
                  </div>
                  {(m.group || m.notes) && <div className={`qa-sub ${Classes.TEXT_MUTED}`} title={m.notes || undefined}>
                    {m.group && <><Icon icon="folder-close" size={10}/> {m.group}</>}{m.group && m.notes ? ' · ' : ''}{m.notes}
                  </div>}
                </td>
                <td>
                  {pretty_label({ label: m.batch || 'default' })}
                  {m.filter && <div className={`qa-sub ${Classes.TEXT_MUTED}`}><Icon icon="filter" size={10}/> {m.filter}</div>}
                </td>
                <td>
                  <code>{m.commit.slice(0, 8)}</code>
                  <div className={`qa-sub ${Classes.TEXT_MUTED}`} title={m.message ?? undefined}>
                    {m.branch}{results_project(m) !== project ? ` · ${results_project(m)}` : ''}
                  </div>
                </td>
                <td>{m.is_mine ? <span className={Classes.TEXT_MUTED}>me</span> : owner_name(m) ?? '—'}</td>
                <td title={`Created ${m.created_at}, updated ${m.updated_at}`}>{relative_date(sort === 'created' ? m.created_at : m.updated_at)}</td>
                <td className="qa-actions">
                  <Button size="small" variant="minimal" icon="arrow-right" text="Open" onClick={() => open(m)} title={on_commit_page ? 'Show as the new results, keep the reference' : 'Open its results'}/>
                  {on_commit_page && <Button size="small" variant="minimal" icon="comparison" text="As reference" onClick={() => selectAsReference(m)} title="Compare the new results with this milestone"/>}
                  {user.is_logged && <Button size="small" variant="minimal" icon={<Icon icon="heart" color={m.is_favorite ? Colors.RED4 : undefined}/>} aria-label={m.is_favorite ? 'Remove from favorites' : 'Add to favorites'} title={m.is_favorite ? 'Remove from favorites' : 'Add to favorites'} onClick={() => toggleFavorite(m).catch(() => {})}/>}
                  <Button size="small" variant="minimal" icon="link" aria-label="Copy the link" title="Copy the link" onClick={() => copyWithToast(milestone_url(m), { what: 'the link to the milestone' })}/>
                  <Button size="small" variant="minimal" icon={m.can_edit ? 'edit' : 'info-sign'} aria-label={m.can_edit ? 'Edit' : 'Details'} title={m.can_edit ? 'Edit' : 'Details'} onClick={() => openMilestoneDialog({ project, milestone: m })}/>
                </td>
              </tr>)}
            </tbody>
          </Table>
      }
    </DialogBody>
    <DialogFooter actions={<Button text="Close" onClick={onClose}/>}>
      {chosen.length === 0
        ? <span className={Classes.TEXT_MUTED}>Select milestones to compare two, or to move, share or delete several.</span>
        : <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong>{chosen.length} selected</strong>
            {chosen.length === 2 && <ControlGroup>
              <Tooltip content={<span>Open <strong>{milestone_name(compared_new)}</strong>, compared with <strong>{milestone_name(compared_ref)}</strong></span>}>
                <Button intent={Intent.PRIMARY} icon="comparison" text={<>Compare <em>{milestone_name(compared_new)}</em> with <em>{milestone_name(compared_ref)}</em></>} onClick={compare}/>
              </Tooltip>
              <Button icon="swap-horizontal" aria-label="Swap new and reference" title="Swap new and reference" onClick={() => setSwapped(!swapped)}/>
              <Button icon="link" aria-label="Copy the link to the comparison" title="Copy the link to the comparison" onClick={() => copyWithToast(comparison_url(compared_new, compared_ref), { what: 'the link to the comparison' })}/>
            </ControlGroup>}
            {editable.length > 0 && <>
              <ControlGroup>
                <InputGroup
                  size="small"
                  leftIcon="folder-close"
                  placeholder="Group"
                  value={move_to}
                  onChange={e => setMoveTo(e.target.value)}
                  list="qa-manage-milestones-groups"
                  aria-label="Move to the group"
                  style={{ width: 160 }}
                />
                <datalist id="qa-manage-milestones-groups">{groups.map(g => <option key={g} value={g}>{g}</option>)}</datalist>
                <Button size="small" text={move_to.trim() ? 'Move' : 'Remove from group'} onClick={() => updateMany(editable, { group: normalize_group(move_to) }, move_to.trim() ? `Moved to ${normalize_group(move_to)}` : 'Removed from their group').then(done)}/>
              </ControlGroup>
              <Button size="small" icon="people" text="Share" onClick={() => updateMany(editable, { shared: true }, 'Shared with the project').then(done)}/>
              <Button size="small" icon="person" text="Make personal" onClick={() => updateMany(editable, { shared: false }, 'Made personal').then(done)}/>
              <Button size="small" icon="trash" intent={Intent.DANGER} text="Delete" onClick={() => setConfirmDelete(true)}/>
            </>}
            {not_editable > 0 && <span className={Classes.TEXT_MUTED}>{not_editable} not yours: only their owner can change them</span>}
            <Button size="small" variant="minimal" text="Clear" onClick={done}/>
          </div>
      }
    </DialogFooter>
    <Alert
      isOpen={confirm_delete}
      icon="trash"
      intent={Intent.DANGER}
      cancelButtonText="Cancel"
      confirmButtonText={`Delete ${editable.length}`}
      canEscapeKeyCancel
      onCancel={() => setConfirmDelete(false)}
      onConfirm={() => { setConfirmDelete(false); removeMany(editable).then(done); }}
    >
      <p>Delete {editable.length === 1 ? 'the milestone' : `${editable.length} milestones`}?</p>
      <ul>{editable.slice(0, 8).map(m => <li key={m.id}>{milestone_name(m)}</li>)}{editable.length > 8 && <li>…</li>}</ul>
      <p className={Classes.TEXT_MUTED}>Their results stay, but the cleanup of old results will be able to delete them. Their links will stop working.</p>
    </Alert>
  </Dialog>;
};
