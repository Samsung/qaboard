// /storage: how much storage runs use, by project, batch, commit, branch and folder, and deleting their files.
// Everything the page shows is in its URL (?scope=&project=&folder=...), so it can be shared and bookmarked.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Breadcrumbs, Button, Callout, Card, Checkbox, Classes, HTMLSelect, HTMLTable, Icon, InputGroup, Intent,
  ButtonGroup, NonIdealState, SegmentedControl, Tab, Tabs, Tag, Tooltip,
} from "@blueprintjs/core";
import { useLocation } from "react-router";
import styled from "styled-components";

import { history, Link, useRouter } from "../router";
import { PageShell, RequireLogin, ScrollingTabs } from "../components/PageShell";
import { Time } from "../settings/format";
import { Loading, QueryError } from "../settings/states";
import { overviewQuery, itemsQuery, foldersQuery, items_page_size } from "./api";
import { path_segment } from "../selection";
import { formatBytes, formatNumber, plural, SizeBar, Path, Ellipsis } from "./format";
import { DeleteDialog } from "./DeleteDialog";
import { Deletions } from "./Deletions";
import { QuotaHelp } from "./QuotaHelp";
import { Rules } from "./Rules";
import { ExportsView } from "./Exports";
import { UntrackedView } from "./Untracked";
import { UsersView } from "./Users";


export const views = [
  { id: 'projects', title: 'Projects', icon: 'projects' },
  { id: 'users', title: 'Users', icon: 'people' },
  { id: 'batches', title: 'Batches', icon: 'layers', group: 'batch' },
  { id: 'commits', title: 'Commits', icon: 'git-commit', group: 'commit' },
  { id: 'branches', title: 'Branches', icon: 'git-branch', group: 'branch' },
  { id: 'folders', title: 'Folders', icon: 'folder-close' },
  { id: 'exports', title: 'Exports', icon: 'export' },
  { id: 'untracked', title: 'Not tracked', icon: 'search' },
];

const filter_keys = ['scope', 'user', 'project', 'folder', 'branch', 'older', 'search', 'sort', 'page', 'path'];
export const readFilters = search => {
  const params = new URLSearchParams(search);
  return Object.fromEntries(filter_keys.map(key => [key, params.get(key) ?? '']));
};
export const storageUrl = (view, filters) => {
  const params = new URLSearchParams(Object.entries(filters).filter(([key, value]) => value && filter_keys.includes(key) && !(key === 'scope' && value === 'me')));
  const query = params.toString();
  return `/storage/${view}${query ? `?${query}` : ''}`;
};

const older_options = [
  { value: '', label: 'Any age' },
  { value: '7', label: 'No runs for 1 week' },
  { value: '30', label: 'No runs for 1 month' },
  { value: '90', label: 'No runs for 3 months' },
  { value: '180', label: 'No runs for 6 months' },
  { value: '365', label: 'No runs for 1 year' },
];
const sort_options = [
  { value: 'size', label: 'Biggest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'newest', label: 'Newest first' },
  { value: 'runs', label: 'Most runs first' },
];

const Summary = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 12px;
  margin-bottom: 20px;
  > * { min-width: 0; }
  .value { font-size: 26px; font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums; }
`;

// The main cell of batches, commits and branches: what they are, then their commit, then where they are
const ItemCell = styled.td`
  && { max-width: 480px; min-width: 240px; }
  .line { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
  .commit { margin-top: 2px; font-size: 13px; }
  .meta { margin-top: 2px; font-size: 12px; display: flex; flex-wrap: wrap; align-items: center; column-gap: 6px; row-gap: 2px; }
  .meta > :not(:last-child)::after { content: '·'; margin-left: 6px; opacity: 0.6; }
`;

// Inline, in muted text: clicking adds a filter
const FilterButton = styled.button`
  all: unset;
  cursor: pointer;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-radius: 2px;
  &:hover { text-decoration: underline; color: var(--qa-text, inherit); }
  &:focus-visible { outline: 2px solid #4c90f0; }
`;

const Toolbar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
`;

// The bar at the bottom of the screen while something is selected
const SelectionBar = styled.div`
  position: sticky;
  bottom: 12px;
  z-index: 10;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  padding: 10px 16px;
  border-radius: 6px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.25);
`;

// Text filters apply a moment after users stop typing
const useDebounced = (value, onChange, delay = 400) => {
  const [text, setText] = useState(value);
  const [previous, setPrevious] = useState(value);
  if (value !== previous) {
    setPrevious(value);
    setText(value);
  }
  useEffect(() => {
    if (text === value) return;
    const timer = setTimeout(() => onChange(text), delay);
    return () => clearTimeout(timer);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  return [text, setText];
};

const commitUrl = item => `/${item.project_id}/commit/${item.hexsha}${item.batch_label ? `?batch=${encodeURIComponent(item.batch_label)}` : ''}`;
const branchUrl = item => `/${path_segment(item.project_id)}/commits${item.branch ? `/${path_segment(item.branch)}` : ''}`;

// The commit's message (its first line, the whole message on hover), author and date
const CommitLine = ({ item, link = false }) => {
  const commit = item.commit ?? {};
  const sha = <code>{item.hexsha?.slice(0, 8)}</code>;
  return <div className="line commit">
    {link ? <Link to={commitUrl(item)} title="Open the commit">{sha}</Link> : <span className={Classes.TEXT_MUTED}>{sha}</span>}
    {commit.message
      ? <Ellipsis title={commit.details ?? commit.message} style={{ flex: 1 }}>{commit.message}</Ellipsis>
      : <span className={Classes.TEXT_MUTED} style={{ fontStyle: 'italic' }}>no commit message</span>}
  </div>;
};

const CommitAuthor = ({ commit }) => commit?.author || commit?.authored_at
  ? <span title="The commit's author, and when they wrote it">
    <Icon icon="person" size={11} style={{ marginRight: 3, verticalAlign: 'baseline' }}/>{commit.author || 'unknown'}{commit.authored_at && <>, <Time iso={commit.authored_at}/></>}
  </span>
  : null;


const ProjectsView = ({ overview, filters, go, setFilters }) => {
  const projects = overview?.projects ?? [];
  const only = filters.project && <Callout icon="filter" style={{ marginBottom: 12 }}>
    Only <strong>{filters.project}</strong> is shown.{' '}
    <Button intent={Intent.PRIMARY} variant="minimal" icon="projects" text="Show all projects" onClick={() => setFilters({ project: '', page: '' })}/>
  </Callout>;
  if (projects.length === 0) return <>{only}<NonIdealState icon="database" title="No runs" description={filters.scope === 'me' || !filters.scope ? "QA-Board doesn't know runs of yours that take storage." : "No runs take storage here."}/></>;
  const max = projects[0]?.bytes ?? 0;
  return <div style={{ overflowX: 'auto' }}>
    {only}
    <HTMLTable compact interactive style={{ width: '100%' }} aria-label="Projects">
      <thead><tr><th>Project</th><th>Size</th><th>Runs</th><th>Batches</th><th>Commits</th><th>Latest run</th></tr></thead>
      <tbody>
        {projects.map(p => <tr key={p.project_id} onClick={event => { if (!event.target.closest('a')) go('batches', { project: p.project_id, page: '' }); }} style={{ cursor: 'pointer' }}>
          {/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the link has its text */}
          <td><Link to={storageUrl('batches', { ...filters, project: p.project_id, page: '' })}><strong>{p.project_id}</strong></Link></td>
          <td><SizeBar bytes={p.bytes} max={max}/></td>
          <td>{formatNumber(p.runs)}</td>
          <td>{formatNumber(p.batches)}</td>
          <td>{formatNumber(p.commits)}</td>
          <td><Time iso={p.last_run_at}/></td>
        </tr>)}
      </tbody>
    </HTMLTable>
    <p className={Classes.TEXT_MUTED} style={{ marginTop: 8 }}>Click a project to see its biggest batches, and delete what you don't need.</p>
  </div>;
};


const itemKey = key => JSON.stringify(key);

const PartialTag = () => <Tooltip content="Only some of its runs are in this folder: only those are deleted">
  <Tag minimal intent={Intent.WARNING}>Partly in the folder</Tag>
</Tooltip>;

// Projects can be long paths: the end matters most
const ProjectFilter = ({ item, filters, setFilters }) => filters.project === item.project_id
  ? <Ellipsis title={item.project_id} style={{ maxWidth: 300, direction: 'rtl' }}>&lrm;{item.project_id}&lrm;</Ellipsis>
  : <FilterButton type="button" title={`Only ${item.project_id}`} aria-label={item.project_id} onClick={() => setFilters({ project: item.project_id, page: '' })} style={{ maxWidth: 300, direction: 'rtl' }}>&lrm;{item.project_id}&lrm;</FilterButton>;

const BranchFilter = ({ item, filters, setFilters }) => !item.branch
  ? <span>no branch</span>
  : <span>
    <Icon icon="git-branch" size={11} style={{ marginRight: 3, verticalAlign: 'baseline' }}/>
    {filters.branch === item.branch
      ? item.branch
      : <FilterButton type="button" title={`Only the branch ${item.branch}`} onClick={() => setFilters({ branch: item.branch, page: '' })}>{item.branch}</FilterButton>}
  </span>;

const ItemsView = ({ group, filters, setFilters, selection, setSelection }) => {
  const sort = filters.sort || 'size';
  const offset = Math.max(0, (parseInt(filters.page || '1', 10) - 1) * items_page_size);
  const { data, isPending, error, refetch, isFetching } = useQuery(itemsQuery(group, filters, { sort, offset }));
  if (isPending) return <Loading label="Loading"/>;
  if (error) return <QueryError error={error} refetch={refetch} what="the storage usage"/>;
  const items = data.items;
  const max = Math.max(0, ...items.map(i => i.bytes));
  const selectable = item => !item.milestone;
  const selected = item => selection.all || selection.keys.has(itemKey(item.key));
  const toggle = item => setSelection(current => {
    const keys = new Map(current.keys);
    if (keys.has(itemKey(item.key))) keys.delete(itemKey(item.key));
    else keys.set(itemKey(item.key), item);
    return { all: false, keys };
  });
  const page_selectable = items.filter(selectable);
  const all_on_page = page_selectable.length > 0 && page_selectable.every(selected);
  const togglePage = () => setSelection(current => {
    const keys = new Map(current.all ? [] : current.keys);
    if (all_on_page) page_selectable.forEach(item => keys.delete(itemKey(item.key)));
    else page_selectable.forEach(item => keys.set(itemKey(item.key), item));
    return { all: false, keys };
  });
  const pages = Math.max(1, Math.ceil(data.total / items_page_size));
  const page = Math.floor(offset / items_page_size) + 1;
  const show_users = filters.scope === 'all' || filters.scope === 'user';

  if (items.length === 0)
    return <NonIdealState icon="search" title="Nothing here" description="No runs match the filters."/>;
  return <>
    {all_on_page && !selection.all && data.total > items.length && <Callout icon="info-sign" style={{ marginBottom: 8 }}>
      All {items.length} on this page are selected.{' '}
      <Button variant="minimal" intent={Intent.PRIMARY} text={`Select all ${formatNumber(data.total)} that match the filters`} onClick={() => setSelection({ all: true, keys: new Map(), total: data.total, totals: data.totals })}/>
    </Callout>}
    {selection.all && <Callout icon="tick" intent={Intent.PRIMARY} style={{ marginBottom: 8 }}>
      All {formatNumber(data.total)} {group === 'batch' ? 'batches' : group === 'commit' ? 'commits' : 'branches'} that match the filters are selected ({formatBytes(data.totals.bytes)}).{' '}
      <Button variant="minimal" text="Clear the selection" onClick={() => setSelection({ all: false, keys: new Map() })}/>
    </Callout>}
    <div style={{ overflowX: 'auto', opacity: isFetching ? 0.7 : 1 }}>
      <HTMLTable compact style={{ width: '100%' }} aria-label={`${group === 'batch' ? 'Batches' : group === 'commit' ? 'Commits' : 'Branches'}`}>
        <thead>
          <tr>
            <th style={{ width: 30 }}><Checkbox checked={all_on_page || selection.all} indeterminate={!all_on_page && page_selectable.some(selected)} onChange={togglePage} aria-label="Select this page" style={{ margin: 0 }}/></th>
            <th>Size</th>
            <th>{group === 'branch' ? 'Branch' : group === 'commit' ? 'Commit' : 'Batch'}</th>
            {group !== 'branch' && <th>Folder</th>}
            <th>Runs</th>
            {show_users && <th>Run by</th>}
            <th>Latest run</th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => <tr key={itemKey(item.key)} data-testid="storage-item"
            onClick={event => { if (selectable(item) && !selection.all && !event.target.closest('a, button, input, label')) toggle(item); }}
            style={{ cursor: selectable(item) && !selection.all ? 'pointer' : undefined, ...(selected(item) && selectable(item) ? { background: 'rgba(45, 114, 210, 0.12)' } : {}) }}>
            <td>
              {selectable(item)
                ? <Checkbox checked={selected(item)} onChange={() => toggle(item)} disabled={selection.all} aria-label={`Select ${item.batch_label ?? item.hexsha?.slice(0, 8) ?? item.branch}`} style={{ margin: 0 }}/>
                : <Tooltip content="This batch is a milestone: its runs are kept. Delete the milestone first if you don't need it." hoverOpenDelay={200}><Icon icon="lock" className={Classes.TEXT_MUTED} aria-label="Milestone: kept"/></Tooltip>}
            </td>
            <td><SizeBar bytes={item.bytes} max={max}/></td>
            <ItemCell>
              {group === 'branch' && <>
                <div className="line">
                  <Icon icon="git-branch" size={14} className={Classes.TEXT_MUTED}/>
                  <Link to={branchUrl(item)} title="Its commits"><strong>{item.branch || '(no branch)'}</strong></Link>
                  {item.partial && <PartialTag/>}
                </div>
                <CommitLine item={item} link/>
                <div className={`meta ${Classes.TEXT_MUTED}`}>
                  <ProjectFilter item={item} filters={filters} setFilters={setFilters}/>
                  <span>{plural(item.commits, 'commit')}, {plural(item.batches, 'batch', 'batches')}</span>
                  <span title="The commit with the latest runs">latest: <CommitAuthor commit={item.commit}/></span>
                </div>
              </>}
              {group === 'batch' && <>
                <div className="line">
                  <Link to={commitUrl(item)} title="Open its results"><strong>{item.batch_label}</strong></Link>
                  {item.milestone && <Tag minimal icon="lock">Milestone</Tag>}
                  {item.partial && <PartialTag/>}
                </div>
                <CommitLine item={item}/>
                <div className={`meta ${Classes.TEXT_MUTED}`}>
                  <ProjectFilter item={item} filters={filters} setFilters={setFilters}/>
                  <BranchFilter item={item} filters={filters} setFilters={setFilters}/>
                  <CommitAuthor commit={item.commit}/>
                </div>
              </>}
              {group === 'commit' && <>
                <CommitLine item={item} link/>
                <div className={`meta ${Classes.TEXT_MUTED}`}>
                  <ProjectFilter item={item} filters={filters} setFilters={setFilters}/>
                  <BranchFilter item={item} filters={filters} setFilters={setFilters}/>
                  <CommitAuthor commit={item.commit}/>
                </div>
                <div className="line" style={{ marginTop: 4, flexWrap: 'wrap' }}>
                  {(item.labels ?? []).map(label => <Link key={label} to={commitUrl({ ...item, batch_label: label })}><Tag minimal round interactive>{label}</Tag></Link>)}
                  {item.batches > (item.labels ?? []).length && <span className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>+{item.batches - item.labels.length} more</span>}
                  {item.milestones?.length > 0 && <Tooltip content={`Milestone batches, kept: ${item.milestones.join(', ')}`}><Tag minimal icon="lock">{item.milestones.length} milestone{item.milestones.length > 1 ? 's' : ''}</Tag></Tooltip>}
                  {item.partial && <PartialTag/>}
                </div>
              </>}
            </ItemCell>
            {group !== 'branch' && <td><Path path={item.folder} style={{ maxWidth: 280 }}/></td>}
            <td>{formatNumber(item.runs)}</td>
            {show_users && <td style={{ fontSize: 12, maxWidth: 160 }}>
              {(item.users ?? []).map((u, i) => <div key={u} style={{ display: 'flex' }}>
                <FilterButton type="button" title={`Only ${u || 'unknown'}'s runs`} onClick={() => setFilters({ scope: 'user', user: u, page: '' })}>{u || 'unknown'}</FilterButton>
                {i === item.users.length - 1 && item.nb_users > item.users.length && <span className={Classes.TEXT_MUTED} style={{ marginLeft: 4, whiteSpace: 'nowrap' }}>+{item.nb_users - item.users.length}</span>}
              </div>)}
            </td>}
            <td><Time iso={item.last_run_at}/></td>
          </tr>)}
        </tbody>
      </HTMLTable>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
      <span className={Classes.TEXT_MUTED}>{formatNumber(offset + 1)}–{formatNumber(offset + items.length)} of {formatNumber(data.total)}</span>
      <Button icon="chevron-left" text="Previous" disabled={page <= 1} onClick={() => setFilters({ page: String(page - 1) })}/>
      <Button endIcon="chevron-right" text="Next" disabled={page >= pages} onClick={() => setFilters({ page: String(page + 1) })}/>
    </div>
  </>;
};


const FoldersView = ({ filters, setFilters, go, overview, onDelete }) => {
  const path = filters.path || '';
  const [text, setText] = useState(path);
  const [previous, setPrevious] = useState(path);
  if (path !== previous) {
    setPrevious(path);
    setText(path);
  }
  const { data, isPending, error, refetch, isFetching } = useQuery(foldersQuery(path, filters));
  const open = folder => setFilters({ path: folder });
  const parts = (data?.path ?? '/').split('/').filter(Boolean);
  const crumbs = [{ text: '/', onClick: () => open('/') }, ...parts.map((part, i) => ({ text: part, onClick: () => open(`/${parts.slice(0, i + 1).join('/')}`) }))];
  const max = Math.max(0, ...(data?.children ?? []).map(c => c.bytes));
  const total = (data?.children ?? []).reduce((sum, c) => sum + c.bytes, 0) + (data?.here?.bytes ?? 0);
  const top = overview?.top_folders ?? [];
  return <>
    <form onSubmit={e => { e.preventDefault(); open(text.trim()); }} style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
      <InputGroup
        leftIcon="folder-open"
        placeholder="Paste a folder, e.g. from a quota alert: /algo/project/outputs/alice"
        aria-label="Folder"
        value={text}
        onChange={e => setText(e.target.value)}
        className={Classes.MONOSPACE_TEXT}
        style={{ minWidth: 'min(520px, 80vw)' }}
        spellCheck={false}
      />
      <Button type="submit" text="Open"/>
    </form>
    {!path && top.length > 0 && <div style={{ marginBottom: 16 }}>
      <span className={Classes.TEXT_MUTED}>Your biggest folders: </span>
      {top.map(f => <Tag key={f.path} interactive minimal round onClick={() => open(f.path)} style={{ margin: '2px 4px' }}>
        <code>{f.path}</code> · {formatBytes(f.bytes)}
      </Tag>)}
    </div>}
    {isPending && <Loading label="Loading the folders"/>}
    {error && <QueryError error={error} refetch={refetch} what="the folders"/>}
    {data && <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        <Breadcrumbs items={crumbs}/>
        {data.skipped && <Tooltip content="The folders above only lead here: nothing else in them has runs." hoverOpenDelay={200}>
          <Tag minimal icon="double-chevron-down">Started where the runs are</Tag>
        </Tooltip>}
        <span style={{ marginLeft: 'auto' }}/>
        {data.path !== '/' && <>
          <span><strong>{formatBytes(total)}</strong> <span className={Classes.TEXT_MUTED}>known to QA-Board here</span></span>
          <Button icon="th-list" text="Show these runs" onClick={() => go('batches', { folder: data.path, page: '' })}/>
          <Button icon="trash" intent={Intent.DANGER} variant="outlined" text="Delete the files of these runs…" disabled={!total && !data.partial.runs}
            onClick={() => onDelete({ group: 'batch', keys: null, filters: { ...filters, folder: data.path }, label: `Runs in ${data.path}` })}/>
        </>}
      </div>
      {data.partial.runs > 0 && <Callout icon="info-sign" style={{ marginBottom: 8 }}>
        {plural(data.partial.batches, 'batch', 'batches')} ({formatBytes(data.partial.bytes)}) have runs here and elsewhere: only their runs in this folder would be deleted.
      </Callout>}
      {data.children.length === 0 && !data.here.runs
        ? <NonIdealState icon="folder-close" title="QA-Board knows no runs here" description={<>If IT says this folder is big, the files aren't QA-Board runs: see <em>Why does IT's quota say something else?</em></>}/>
        : <div style={{ overflowX: 'auto', opacity: isFetching ? 0.7 : 1 }}>
          <HTMLTable compact interactive style={{ width: '100%' }} aria-label="Folders">
            <thead><tr><th>Folder</th><th>Size</th><th>Runs</th><th>Batches</th></tr></thead>
            <tbody>
              {data.here.runs > 0 && <tr>
                <td className={Classes.TEXT_MUTED}>Runs right in this folder</td>
                <td><SizeBar bytes={data.here.bytes} max={Math.max(max, data.here.bytes)}/></td>
                <td>{formatNumber(data.here.runs)}</td><td>{formatNumber(data.here.batches)}</td>
              </tr>}
              {data.children.map(c => <tr key={c.path} onClick={event => { if (!event.target.closest('a')) open(c.path); }} style={{ cursor: 'pointer' }}>
                <td><Icon icon="folder-close" className={Classes.TEXT_MUTED} style={{ marginRight: 6 }}/><Link to={storageUrl('folders', { ...filters, path: c.path })} title={c.name.includes('/') ? `${c.path}: the folders on the way only lead there` : c.path}>
                  {c.name.includes('/') ? <><span className={Classes.TEXT_MUTED}>{c.name.slice(0, c.name.lastIndexOf('/') + 1)}</span>{c.name.slice(c.name.lastIndexOf('/') + 1)}</> : c.name}
                </Link></td>
                <td><SizeBar bytes={c.bytes} max={Math.max(max, data.here.bytes)}/></td>
                <td>{formatNumber(c.runs)}</td>
                <td>{formatNumber(c.batches)}</td>
              </tr>)}
            </tbody>
          </HTMLTable>
        </div>}
    </>}
  </>;
};


// The filters, as removable tags
const ActiveFilters = ({ filters, setFilters }) => {
  const tags = [
    filters.project && { key: 'project', text: <>Project: {filters.project}</> },
    filters.folder && { key: 'folder', text: <>Folder: <code>{filters.folder}</code></> },
    filters.branch && { key: 'branch', text: <>Branch: {filters.branch}</> },
    filters.older && { key: 'older', text: older_options.find(o => o.value === filters.older)?.label ?? `No runs for ${filters.older} days` },
  ].filter(Boolean);
  if (!tags.length) return null;
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
    {tags.map(tag => <Tag key={tag.key} large minimal onRemove={() => setFilters({ [tag.key]: '', page: '' })}>{tag.text}</Tag>)}
    <Button variant="minimal" size="small" text="Clear all" onClick={() => setFilters({ project: '', folder: '', branch: '', older: '', search: '', page: '' })}/>
  </div>;
};


export const StorageUsage = ({ me, view, filters }) => {
  const [selection, setSelection] = useState({ all: false, keys: new Map() });
  const [deleting, setDeleting] = useState(null);
  const [help, setHelp] = useState(false);
  const selected_view = views.find(v => v.id === view) ?? views[0];
  const go = (new_view, changes = {}) => {
    setSelection({ all: false, keys: new Map() });
    history.push(storageUrl(new_view, { ...filters, ...changes }));
  };
  const setFilters = changes => {
    if (!('page' in changes && Object.keys(changes).length === 1)) setSelection({ all: false, keys: new Map() });
    history.replace(storageUrl(view, { ...filters, ...changes }));
  };
  const [search, setSearch] = useDebounced(filters.search, search => setFilters({ search, page: '' }));
  const [branch, setBranch] = useDebounced(filters.branch, branch => setFilters({ branch, page: '' }));

  const { data: overview, isPending, error, refetch } = useQuery(overviewQuery(filters));
  const scope = filters.scope || 'me';
  const can_see_others = overview?.can_see_others ?? 'all';
  const selected_items = [...selection.keys.values()];
  const selected_bytes = selection.all ? selection.totals?.bytes ?? 0 : selected_items.reduce((sum, item) => sum + item.bytes, 0);
  const selected_count = selection.all ? selection.total : selected_items.length;
  const group = selected_view.group;
  const group_words = { batch: ['batch', 'batches'], commit: ['commit', 'commits'], branch: ['branch', 'branches'] }[group] ?? ['item', 'items'];

  return <>
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 16 }}>
      {can_see_others !== 'none' && <SegmentedControl
        aria-label="Whose runs"
        options={[{ label: 'Your runs', value: 'me' }, { label: "Everyone's", value: 'all' }]}
        value={scope === 'user' ? 'all' : scope}
        onValueChange={value => setFilters({ scope: value, user: '', page: '' })}
      />}
      {scope !== 'me' && can_see_others === 'some' && <Tooltip content="Only admins see everyone's usage everywhere: you see it in the projects where you're a developer or an owner." hoverOpenDelay={200}>
        <Tag minimal icon="info-sign">In your projects</Tag>
      </Tooltip>}
      {scope === 'user' && <Tag large minimal icon="person" onRemove={() => setFilters({ scope: 'all', user: '' })}>Runs of {filters.user}</Tag>}
      {filters.project
        ? <ButtonGroup>
          <Tag large minimal icon="projects" title={filters.project} style={{ maxWidth: 360 }} onRemove={() => setFilters({ project: '', page: '' })}>{filters.project}</Tag>
          <Button variant="outlined" icon="projects" text="All projects" onClick={() => setFilters({ project: '', page: '' })}/>
        </ButtonGroup>
        : null}
      {overview?.updated_at && <Tooltip content="Each run's size is measured when it ends. The numbers are updated every few minutes, and right away when you delete from QA-Board." hoverOpenDelay={200}>
        <span className={Classes.TEXT_MUTED}>Updated <Time iso={overview.updated_at}/></span>
      </Tooltip>}
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button icon="help" variant="minimal" text="Why does IT's quota say something else?" onClick={() => setHelp(true)}/>
      </span>
    </div>

    {overview?.building && <Callout intent={Intent.PRIMARY} icon="time" title="Computing the storage usage" style={{ marginBottom: 16 }}>
      QA-Board is adding up the size of every run, for the first time or for a nightly update. The numbers may be incomplete for a few minutes.
    </Callout>}
    {!overview?.building && overview && !overview.updated_at && <Callout intent={Intent.WARNING} title="The storage usage isn't computed yet" style={{ marginBottom: 16 }}>
      A worker computes it in the background. If this lasts, ask an admin to check Admin → Storage.
    </Callout>}

    {isPending && <Loading label="Loading the storage usage"/>}
    {error && <QueryError error={error} refetch={refetch} what="the storage usage"/>}
    {overview && <Summary>
      <Card compact>
        <div className="value" data-testid="total">{formatBytes(overview.totals.bytes)}</div>
        <Ellipsis className={Classes.TEXT_MUTED}>{scope === 'me' ? 'used by your runs' : scope === 'user' ? `used by ${filters.user}'s runs` : "used by everyone's runs"}</Ellipsis>
        {filters.project && <Ellipsis className={Classes.TEXT_MUTED} title={filters.project} style={{ direction: 'rtl', textAlign: 'left' }}>&lrm;in {filters.project}&lrm;</Ellipsis>}
      </Card>
      <Card compact><div className="value">{formatNumber(overview.totals.runs)}</div><div className={Classes.TEXT_MUTED}>runs, in {plural(overview.totals.batches, 'batch', 'batches')}</div></Card>
      <Card compact data-testid="projects-total">
        <div className="value">{formatNumber(overview.totals.projects)}</div>
        <div className={Classes.TEXT_MUTED}>{overview.totals.projects === 1 ? 'project' : 'projects'}{overview.projects[0] && overview.totals.projects > 1 ? ', the biggest:' : ''}</div>
        {overview.projects[0] && overview.totals.projects > 1 && <div style={{ display: 'flex', gap: 6, minWidth: 0 }}>
          <Ellipsis title={overview.projects[0].project_id} style={{ direction: 'rtl', textAlign: 'left', flex: 1 }}>
            &lrm;<Link to={storageUrl('batches', { ...filters, project: overview.projects[0].project_id, page: '' })}>{overview.projects[0].project_id}</Link>&lrm;
          </Ellipsis>
          <span className={Classes.TEXT_MUTED} style={{ whiteSpace: 'nowrap' }}>{formatBytes(overview.projects[0].bytes)}</span>
        </div>}
      </Card>
      {overview.totals.deleted?.runs > 0 && <Tooltip
        content={<span style={{ display: 'block', maxWidth: 340 }}>
          Deleting runs deletes the files their manifest lists, and keeps the manifest. Files written after the run ended stay too.
          Admins remove what's left with a schedule: see below.{overview.totals.deleted.unmeasured > 0 ? ` ${plural(overview.totals.deleted.unmeasured, 'deleted run')} weren't measured yet.` : ''}
        </span>}
        hoverOpenDelay={200}
        targetTagName="div"
      >
        <Card compact data-testid="deleted-leftovers">
          <div className="value">{formatBytes(overview.totals.deleted.bytes)}</div>
          <div className={Classes.TEXT_MUTED}>left by {plural(overview.totals.deleted.runs, 'deleted run')}{overview.totals.deleted.unmeasured > 0 ? ' (some not measured yet)' : ''}</div>
        </Card>
      </Tooltip>}
      {overview.exports?.count > 0 && <Card compact interactive onClick={() => go('exports')} data-testid="exports-total">
        <div className="value">{formatBytes(overview.exports.bytes)}</div>
        <div className={Classes.TEXT_MUTED}>in {plural(overview.exports.count, 'export')}{overview.exports.linked_bytes > 0 ? `, ${formatBytes(overview.exports.linked_bytes)} linked to runs` : ''}</div>
      </Card>}
      {overview.users?.length > 0 && scope !== 'me' && view !== 'users' && <Card compact data-testid="top-users">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
          <span className={Classes.TEXT_MUTED}>Who uses the most</span>
          <Link to={storageUrl('users', { ...filters, page: '' })} style={{ whiteSpace: 'nowrap' }}>See all</Link>
        </div>
        {overview.users.slice(0, 3).map(u => <div key={u.user_name} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, minWidth: 0 }}>
          <Ellipsis title={u.user_name || 'unknown'}><Link to={storageUrl(view, { ...filters, scope: 'user', user: u.user_name, page: '' })}>{u.user_name || 'unknown'}</Link></Ellipsis>
          <span style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{formatBytes(u.bytes)}</span>
        </div>)}
      </Card>}
    </Summary>}

    <Deletions/>
    {overview && <Rules project={filters.project}/>}

    <ScrollingTabs>
      <Tabs id="storage-views" selectedTabId={selected_view.id} onChange={id => go(id, { page: '' })} size="large">
        {views.filter(v => v.id !== 'users' || can_see_others !== 'none' || view === 'users').map(v => <Tab key={v.id} id={v.id} title={v.title} icon={v.icon}/>)}
      </Tabs>
    </ScrollingTabs>
    <div style={{ marginTop: 16 }}>
      {group && <Toolbar>
        <InputGroup leftIcon="search" placeholder="Search projects, branches, batches, commits…" aria-label="Search" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 280 }}/>
        <InputGroup leftIcon="git-branch" placeholder="Branch" aria-label="Branch" value={branch} onChange={e => setBranch(e.target.value)} style={{ width: 160 }}/>
        <HTMLSelect aria-label="Age" options={older_options} value={filters.older} onChange={e => setFilters({ older: e.target.value, page: '' })}/>
        <HTMLSelect aria-label="Sort" options={sort_options} value={filters.sort || 'size'} onChange={e => setFilters({ sort: e.target.value, page: '' })}/>
        {filters.project && <Button variant="minimal" icon="trash" intent={Intent.DANGER} text={`Delete all ${scope === 'me' ? 'your ' : ''}runs that match…`}
          onClick={() => setDeleting({ group: group ?? 'batch', keys: null, filters, label: `Everything that matches the filters in ${filters.project}` })}/>}
      </Toolbar>}
      <ActiveFilters filters={filters} setFilters={setFilters}/>
      {selected_view.id === 'projects' && <ProjectsView overview={overview} filters={filters} go={go} setFilters={setFilters}/>}
      {selected_view.id === 'users' && <UsersView me={me} filters={filters} storageUrl={storageUrl} openUser={user => go('batches', { scope: 'user', user: user.user_name, page: '' })}/>}
      {group && <ItemsView group={group} filters={filters} setFilters={setFilters} selection={selection} setSelection={setSelection}/>}
      {selected_view.id === 'folders' && <FoldersView filters={filters} setFilters={setFilters} go={go} overview={overview} onDelete={setDeleting}/>}
      {selected_view.id === 'exports' && <ExportsView filters={filters} me={me}/>}
      {selected_view.id === 'untracked' && <UntrackedView me={me}/>}
    </div>

    {group && (selection.all || selection.keys.size > 0) && <SelectionBar as="section" className={`${Classes.CARD} ${Classes.ELEVATION_3}`} aria-label="Selection">
      <Icon icon="tick-circle" intent={Intent.PRIMARY}/>
      <span><strong>{plural(selected_count, ...group_words)}</strong> selected · <strong>{formatBytes(selected_bytes)}</strong></span>
      <Button variant="minimal" text="Clear" onClick={() => setSelection({ all: false, keys: new Map() })}/>
      <span style={{ marginLeft: 'auto' }}/>
      <Button intent={Intent.DANGER} icon="trash" text="Delete the files…" onClick={() => setDeleting({
        group,
        keys: selection.all ? null : selected_items.map(item => item.key),
        filters,
        label: selection.all ? `All the ${group_words[1]} that match the filters` : `${plural(selected_count, ...group_words)} you selected`,
      })}/>
    </SelectionBar>}

    {deleting && <DeleteDialog selection={deleting} onClose={() => setDeleting(null)} onDeleted={() => setSelection({ all: false, keys: new Map() })}/>}
    {help && <QuotaHelp isOpen onClose={() => setHelp(false)} user_name={me.user_name} folder={filters.folder || filters.path || overview?.top_folders?.[0]?.path}/>}
  </>;
};


export const StoragePage = () => {
  const { match } = useRouter();
  const location = useLocation();
  const filters = readFilters(location.search);
  return <PageShell title="Storage usage" wide>
    <RequireLogin what="see your storage usage">
      {me => <StorageUsage me={me} view={match.params?.view ?? 'projects'} filters={filters}/>}
    </RequireLogin>
  </PageShell>;
};

export default StoragePage;
