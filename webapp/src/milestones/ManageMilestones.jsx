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
  Tag,
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
  milestone_search_text, runs_matches, dataset_label,
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
  .qa-notes {
    all: unset;
    cursor: pointer;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    overflow: hidden;
    white-space: pre-wrap;
    max-width: 280px;
    font-size: 13px;
  }
  .qa-notes.qa-expanded {
    -webkit-line-clamp: unset;
  }
  .qa-notes:focus-visible {
    outline: 2px solid #2d72d2;
  }
  .qa-runs {
    display: grid;
    gap: 3px;
    font-size: 12px;
  }
  .qa-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    max-width: 220px;
  }
  tr.qa-checked td {
    background: rgba(45, 114, 210, 0.1);
  }
`;

// A dataset or qa batch, as the Dataset filter's value: "dataset:/data/indoor", "qa-batch:nightly"
const facet_matches = facet => m => !facet
  || (facet.startsWith('dataset:') && (m.runs?.databases ?? []).some(d => `dataset:${d.name}` === facet))
  || (facet.startsWith('qa-batch:') && (m.runs?.batches ?? []).some(b => `qa-batch:${b.name}` === facet));

// The datasets and qa batches of the milestones, with how many milestones use each
const facets = list => {
  const count = (values, prefix) => {
    const counts = {};
    for (const m of list)
      for (const name of new Set((values(m) ?? []).map(v => v.name))) counts[name] = (counts[name] ?? 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, n]) => ({ value: `${prefix}:${name}`, name, n }));
  };
  return { datasets: count(m => m.runs?.databases, 'dataset'), batches: count(m => m.runs?.batches, 'qa-batch') };
};

// What a milestone's runs used: their number, datasets and qa batches. `matched`: highlighted, they matched the search
const RunsCell = ({ runs, matched }) => {
  if (!runs) return <span className={Classes.TEXT_MUTED} title="Described the next time the milestones load">…</span>;
  if (!runs.count) return <span className={Classes.TEXT_MUTED} title="No runs were found for this milestone's batch and filter">no runs</span>;
  const is_matched = (kind, name) => matched.some(v => v.kind === kind && v.name === name);
  const chips = [
    ...runs.databases.map(d => ({ kind: 'dataset', name: d.name, label: dataset_label(d.name), runs: d.runs, icon: 'database' })),
    ...runs.batches.map(b => ({ kind: 'qa batch', name: b.name, label: b.name, runs: b.runs, icon: 'layout-skew-grid' })),
  ];
  // what matched first, then the biggest
  chips.sort((a, b) => Number(is_matched(b.kind, b.name)) - Number(is_matched(a.kind, a.name)));
  const shown = chips.slice(0, 3);
  return <div className="qa-runs">
    <span className={Classes.TEXT_MUTED}>{runs.count} run{runs.count > 1 ? 's' : ''}{runs.failed ? `, ${runs.failed} failed` : ''}</span>
    <div className="qa-chips">
      {shown.map(c => <Tag key={`${c.kind}-${c.name}`} minimal round icon={c.icon} intent={is_matched(c.kind, c.name) ? Intent.PRIMARY : undefined} title={`${c.kind}: ${c.name} (${c.runs} runs)`}>{c.label}</Tag>)}
      {chips.length > shown.length && <Tooltip content={<div style={{ maxWidth: 320 }}>{chips.slice(3).map(c => <div key={`${c.kind}-${c.name}`}>{c.kind}: {c.name} ({c.runs} runs)</div>)}</div>}>
        <Tag minimal round>+{chips.length - shown.length}</Tag>
      </Tooltip>}
    </div>
  </div>;
};

// Notes can be long: 3 lines, click for all of it
const NotesCell = ({ notes }) => {
  const [expanded, setExpanded] = useState(false);
  if (!notes) return <span className={Classes.TEXT_MUTED}>—</span>;
  return <button type="button" className={`qa-notes${expanded ? ' qa-expanded' : ''}`} onClick={() => setExpanded(!expanded)} title={expanded ? 'Show less' : notes} aria-expanded={expanded}>
    {notes}
  </button>;
};

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
  // a dataset or qa batch the milestones' runs used
  const [facet, setFacet] = useState('');

  const matcher = match_query(search);
  const rows = list.filter(in_scope[scope]).filter(facet_matches(facet)).filter(m => matcher(milestone_search_text(m))).sort(sorts[sort].compare);
  const { datasets, batches } = facets(list);
  const not_described = list.filter(m => !m.runs).length;
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
    style={{ width: 1280, maxWidth: 'calc(100vw - 32px)' }}
  >
    <DialogBody style={{ maxHeight: '65vh', overflowY: 'auto', paddingTop: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 1, padding: '12px 0 8px', background: 'inherit' }}>
        <InputGroup
          leftIcon="search"
          placeholder="Search by name, notes, dataset, branch, owner…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          aria-label="Search milestones"
          style={{ minWidth: 300 }}
        />
        <SegmentedControl options={scopes} value={scope} onValueChange={setScope} size="small"/>
        {datasets.length + batches.length > 0 && <HTMLSelect
          value={facet}
          onChange={e => setFacet(e.target.value)}
          aria-label="Dataset"
          title={not_described ? `${not_described} milestones aren't described yet: they will be the next time the milestones load` : 'The datasets and qa batches the milestones’ runs used'}
        >
          <option value="">Any dataset</option>
          {datasets.length > 0 && <optgroup label="Datasets">{datasets.map(f => <option key={f.value} value={f.value}>{dataset_label(f.name)} ({f.n})</option>)}</optgroup>}
          {batches.length > 0 && <optgroup label="qa batches">{batches.map(f => <option key={f.value} value={f.value}>{f.name} ({f.n})</option>)}</optgroup>}
        </HTMLSelect>}
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
            description={list.length === 0 && !isPending ? 'Save one with the star next to a commit’s hash.'
              : facet ? <>None of the milestones {scope === 'all' ? '' : `(${scope}) `}that match used {facet.replace(':', ' ')}. <Button size="small" variant="minimal" text="Any dataset" onClick={() => setFacet('')}/></> : undefined}
          />
        : <Table compact interactive>
            <thead>
              <tr>
                <th style={{ width: 28 }}><Checkbox checked={all_checked} indeterminate={!all_checked && rows.some(m => checked.has(m.id))} onChange={toggleAll} aria-label="Select all" style={{ margin: 0 }}/></th>
                <th>Name</th>
                <th>Notes</th>
                <th>Results</th>
                <th>Runs</th>
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
                  {m.group && <div className={`qa-sub ${Classes.TEXT_MUTED}`}><Icon icon="folder-close" size={10}/> {m.group}</div>}
                </td>
                <td><NotesCell notes={m.notes}/></td>
                <td>
                  {pretty_label({ label: m.batch || 'default' })}
                  {m.filter && <div className={`qa-sub ${Classes.TEXT_MUTED}`}><Icon icon="filter" size={10}/> {m.filter}</div>}
                </td>
                <td><RunsCell runs={m.runs} matched={[...runs_matches(m, search), ...(facet ? [{ kind: facet.startsWith('dataset:') ? 'dataset' : 'qa batch', name: facet.slice(facet.indexOf(':') + 1) }] : [])]}/></td>
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
