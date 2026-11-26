// /<project>/inputs: every input the project's runs (and its subprojects') used, to find some and save them as a
// collection. The URL says what's shown, so links can be shared:
//   ?q=<search>&folder=<folder of the full paths>&meta=<{key: [values]}, JSON>&database=<database>&live=0 (also inputs
//   whose runs were all deleted)&sort=path&input=<id> (the viewer)
// Users see full paths (database/path joined): the folders start at the deepest one every input is in.
//   &add_to=<collection id>: users came from a collection to add inputs to it
// Selecting: by hand in the grid, "Select all loaded", or "Select all N matching" (the ids of every match, up to what a
// collection holds, from GET /inputs?fields=id: the dialogs work from ids, without every Input loaded).
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import styled from "styled-components";
import {
  AnchorButton, Button, Callout, Classes, Colors, HTMLSelect, Icon, InputGroup, Intent,
  NonIdealState, PopoverNext, Switch, Tag, Tooltip,
} from "@blueprintjs/core";

import { Link } from "../router";
import { useSelected, updateSelected } from "../selection";
import { useUrlText, useSiteConfig } from "../hooks";
import { errorMessage } from "../api/http";
import { is_typing } from "../components/HelpSheet";
import { usePageTitle, join_title, project_name } from "../pageTitle";
import {
  inputsQuery, inputQuery, inputs_filters_from_query, inputs_defaults, inputs_sorts, folder_breadcrumb, folder_from,
  database_label, collection_path, pretty_name, collectionQuery, fetchMatchingIds, filters_key, full_path,
  max_collection_inputs, selection_provenance, stringify_meta, describe_meta,
} from "./api";
import { Metadata } from "./Metadata";
import { default_input_meta } from "./InputGrid";
import { usePagedInputs } from "./usePaged";
import { InputGrid } from "./InputGrid";
import { CopyPathButtons, copyPaths } from "./CopyPaths";
import { InputViewer } from "./InputViewer";
import { SaveCollectionDialog, AddToCollectionDialog } from "./CollectionDialogs";
import { CollectionsPanel } from "./CollectionsPanel";
import { collections_icon } from "./icons";
import { useCollections } from "./hooks";
import { empty_selection, toggle_selection, select_matching, selected_inputs } from "./gridSelection";
import { toaster } from "../toaster";


// Saving collections needs the collections.write permission: developers and owners of the project
export const who_can_write = project => `Only developers and owners of ${project} can change its shared collections: ask an owner of the project for the developer role.`;
export const who_can_create = 'Sign in to save collections.';
// A button that needs it: disabled with a tooltip that says who can. AnchorButton: disabled Buttons don't show tooltips.
export const WriteButton = ({ allowed, who, ...props }) => allowed
  ? <Button {...props}/>
  : <Tooltip content={who} placement="top"><AnchorButton {...props} onClick={undefined} disabled/></Tooltip>;


// Below the fixed navbar, like the project's other pages
export const Page = styled.main`
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 66px clamp(16px, 3%, 32px) 96px;
  display: flex;
  flex-direction: column;
  gap: 16px;

  h1.${Classes.HEADING} {
    margin: 0;
  }
  .qa-lede {
    margin: 4px 0 0;
    max-width: 720px;
  }
`;

const Layout = styled.div`
  display: flex;
  gap: 24px;
  align-items: flex-start;
  flex-wrap: wrap;
  /* its width, not the window's: the sidebar may take half of a phone's */
  container: inputs / inline-size;

  .qa-inputs-aside {
    flex: 0 1 260px;
    min-width: 200px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    position: sticky;
    top: 66px;
    max-height: calc(100vh - 82px);
    overflow-y: auto;
    padding-right: 4px;
  }
  .qa-inputs-main {
    flex: 999 1 520px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .qa-facet-title {
    margin: 0 0 6px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .qa-breadcrumb {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px;
    margin-bottom: 4px;
    font-size: 12px;
  }
  .qa-breadcrumb button {
    font: inherit;
    border: 0;
    padding: 1px 3px;
    border-radius: 2px;
    background: transparent;
    color: ${Colors.BLUE3};
    cursor: pointer;
  }
  .${Classes.DARK} & .qa-breadcrumb button {
    color: ${Colors.BLUE5};
  }
  .qa-breadcrumb button:hover {
    text-decoration: underline;
  }
  .qa-breadcrumb [aria-current] {
    font-weight: 600;
    padding: 1px 3px;
  }
  .qa-facet-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .qa-facet-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 4px 6px;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .qa-facet-row:hover, .qa-facet-row:focus-visible {
    background: rgba(143, 153, 168, 0.15);
  }
  .qa-facet-row[aria-pressed="true"] {
    background: rgba(45, 114, 210, 0.15);
    font-weight: 600;
  }
  .qa-facet-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .qa-facet-count {
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .qa-folder-list-long {
    max-height: 300px;
    overflow-y: auto;
    box-shadow: inset 0 -8px 8px -8px rgba(17, 20, 24, 0.25);
  }
  .qa-facet-note {
    margin: 4px 6px 0;
    font-size: 12px;
  }
  .qa-crumb {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .qa-meta-list {
    display: flex;
    flex-direction: column;
  }
  .qa-meta-toggle {
    display: none;
    margin-left: 6px;
    border: 0;
    padding: 0;
    background: transparent;
    color: ${Colors.BLUE3};
    font: inherit;
    text-transform: none;
    letter-spacing: 0;
    cursor: pointer;
  }
  .qa-meta-values {
    list-style: none;
    margin: 0 0 6px;
    padding: 0 0 0 22px;
  }
  .qa-meta-values .${Classes.CHECKBOX} {
    margin: 2px 0;
    font-size: 13px;
  }
  .qa-meta-value {
    display: inline-flex;
    gap: 6px;
    width: calc(100% - 26px);
    vertical-align: top;
  }
  .qa-toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .qa-toolbar .${Classes.SWITCH} {
    margin: 0;
  }
  .qa-key-hint {
    margin: 5px 12px 5px 5px;
  }
  @media (hover: none) {
    .qa-key-hint {
      display: none;
    }
  }
  /* wide: the databases are a list with counts on the side, the select would say the same */
  @container inputs (min-width: 641px) {
    .qa-database-select.qa-has-facet {
      display: none;
    }
  }
  /* narrow: the folders are chips above the grid, the databases only the select */
  @container inputs (max-width: 640px) {
    .qa-inputs-aside {
      flex: 1 1 100%;
      min-width: 0;
      position: static;
      max-height: none;
      gap: 8px;
    }
    /* narrow: the metadata is behind its title, the grid stays in view */
    .qa-meta-list {
      display: none;
    }
    .qa-meta-open .qa-meta-list {
      display: flex;
    }
    .qa-meta-toggle {
      display: inline;
    }
    .qa-database-facet {
      display: none;
    }
    .qa-folder-list-long {
      max-height: 120px;
    }
    .qa-facet-list {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .qa-facet-row {
      width: auto;
      max-width: 100%;
      padding: 2px 8px;
      border-radius: 12px;
      box-shadow: inset 0 0 0 1px rgba(143, 153, 168, 0.35);
    }
  }
`;

// At the bottom of the screen while inputs are selected
const SelectionBar = styled.div`
  position: sticky;
  bottom: 16px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-radius: 6px;
  background: ${Colors.DARK_GRAY2};
  color: ${Colors.LIGHT_GRAY5};
  box-shadow: 0 0 0 1px rgba(17, 20, 24, 0.4), 0 8px 24px rgba(17, 20, 24, 0.35);
`;

// Above the grid when every loaded input is selected: like mail apps, offers every match
const MatchingBanner = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 12px;
  border-radius: 4px;
  background: rgba(45, 114, 210, 0.1);
  font-size: 13px;
  text-align: center;
`;

const Guide = styled.section`
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  padding: 14px 16px;
  border-radius: 4px;
  box-shadow: inset 0 0 0 1px rgba(45, 114, 210, 0.35);
  background: rgba(45, 114, 210, 0.05);
  .qa-step {
    display: flex;
    gap: 10px;
    flex: 1 1 220px;
    min-width: 0;
    font-size: 13px;
  }
  .qa-step-number {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 11px;
    background: ${Colors.BLUE3};
    color: ${Colors.WHITE};
    font-size: 12px;
    font-weight: 600;
  }
`;

// "2024/night/cam0/scene_040" => "2024/nig…cam0/scene_040": the end of a path tells inputs apart
const middle = (text, max) => text.length <= max ? text : `${text.slice(0, Math.floor(max / 3))}…${text.slice(text.length - Math.ceil(max * 2 / 3) + 1)}`;
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

// The first time: what collections are for, in three steps
const HowItWorks = ({ onDismiss }) => <Guide aria-label="How collections work">
  <div className="qa-step"><span className="qa-step-number">1</span><div><strong>Find</strong><div className={Classes.TEXT_MUTED}>Search, or pick a folder. Press <kbd className={Classes.KEY}>/</kbd> to search, double-click an input to see it full size.</div></div></div>
  <div className="qa-step"><span className="qa-step-number">2</span><div><strong>Select</strong><div className={Classes.TEXT_MUTED}>Click, <kbd className={Classes.KEY}>Shift</kbd>+click for a range, <kbd className={Classes.KEY}>Ctrl</kbd>+click to add, then <strong>Save as collection</strong>.</div></div></div>
  <div className="qa-step"><span className="qa-step-number">3</span><div><strong>Use it</strong><div className={Classes.TEXT_MUTED}>One line in a batch file, one call in Python: everyone runs on the same inputs.</div></div></div>
  <Button variant="minimal" icon="cross" aria-label="Hide how collections work" onClick={onDismiss} style={{ alignSelf: 'flex-start', marginLeft: 'auto' }}/>
</Guide>;

const FacetRow = ({ name, count, pressed, onClick, icon, title }) => <li>
  <button type="button" className="qa-facet-row" aria-pressed={pressed} onClick={onClick} title={title}>
    {icon && <Icon icon={icon} size={12} className={Classes.TEXT_MUTED}/>}
    <span className="qa-facet-name">{name}</span>
    {count !== undefined && <span className={`qa-facet-count ${Classes.TEXT_MUTED}`}>{count.toLocaleString()}</span>}
  </button>
</li>;

// Where the inputs are: a breadcrumb from the folder every input is in (one crumb, its full path) to the folder shown,
// and its subfolders. Chains of single folders are skipped by the server: users don't click through /mnt, /mnt/data...
const many_folders = 12;
const Folders = ({ root, location, here, folders, setFilters, loading }) => {
  const all_crumbs = folder_breadcrumb(root ?? '', location ?? '');
  const current = all_crumbs.at(-1);
  // deep folders: the root, "…", and the last ones
  const [expanded, setExpanded] = useState(false);
  const hidden = !expanded && all_crumbs.length > 5 ? all_crumbs.slice(1, -3) : [];
  const crumbs = hidden.length ? [all_crumbs[0], { name: '…', more: true }, ...all_crumbs.slice(-3)] : all_crumbs;
  // many folders: a filter, and a list that scrolls, so the metadata stays in view below
  const [folder_search, setFolderSearch] = useState('');
  const shown_folders = folder_search.trim()
    ? folders.filter(f => f.name.toLowerCase().includes(folder_search.trim().toLowerCase()))
    : folders;
  return <nav aria-label="Folders">
    <h2 className={`qa-facet-title ${Classes.TEXT_MUTED}`}>Folder</h2>
    {loading
      ? <p className={Classes.SKELETON}>/data/project/folder</p>
      : <div className="qa-breadcrumb">
          {crumbs.map((crumb, i) => <span key={`${i}-${crumb.folder}`} className="qa-crumb">
            {i > 0 && crumbs[i - 1].name !== '/' && <span className={Classes.TEXT_MUTED} aria-hidden>/</span>}
            {crumb.more
              ? <button type="button" onClick={() => setExpanded(true)} title={hidden.map(c => c.name).join('/')} aria-label="Show the whole path">…</button>
              : crumb === current
              ? <span aria-current="location" className={Classes.MONOSPACE_TEXT}>{crumb.name}</span>
              : <button type="button" className={Classes.MONOSPACE_TEXT} onClick={() => setFilters({ folder: crumb.folder })} title={i === 0 ? 'Every folder' : crumb.folder}>{crumb.name}</button>}
          </span>)}
          {!!(location ?? root) && <Button
            variant="minimal" size="small" icon="duplicate" className="qa-copy-folder"
            aria-label="Copy the folder's path" title={`Copy ${location || root}`}
            onClick={() => copyPaths([location || root], { what: 'the folder' })}
          />}
        </div>}
    {!loading && folders.length > many_folders && <InputGroup
      small type="search" leftIcon="filter" placeholder={`Filter ${folders.length.toLocaleString()} folders`}
      aria-label="Filter the folders" value={folder_search} onChange={e => setFolderSearch(e.target.value)}
      style={{ margin: '4px 0' }}
    />}
    {!loading && shown_folders.length > 0 && <ul className={`qa-facet-list${folders.length > many_folders ? ' qa-folder-list-long' : ''}`}>
      {shown_folders.map(f => <FacetRow
        key={f.folder}
        icon="folder-close"
        name={<span className={Classes.MONOSPACE_TEXT} style={{ fontSize: 12 }}>{f.name}</span>}
        title={f.folder}
        count={f.count}
        onClick={() => setFilters({ folder: f.folder })}
      />)}
    </ul>}
    {!loading && folder_search && shown_folders.length === 0 && <p className={`qa-facet-note ${Classes.TEXT_MUTED}`}>No folder matches “{folder_search}”</p>}
    {!loading && folders.length > 0 && here > 0 && <p className={`qa-facet-note ${Classes.TEXT_MUTED}`}>and {plural(here, 'input')} right in this folder</p>}
    {!loading && folders.length >= 1000 && <p className={`qa-facet-note ${Classes.TEXT_MUTED}`}>The first 1,000 folders: search to find the others.</p>}
    {!loading && folders.length === 0 && !!current?.folder && <p className={`qa-facet-note ${Classes.TEXT_MUTED}`}>No subfolders</p>}
  </nav>;
};

// The input to show in the viewer when it's not in the list (e.g. a shared link with other filters)
const useViewed = (project, id, items) => {
  const index = id === null ? -1 : items.findIndex(i => String(i.id) === String(id));
  const alone = useQuery({ ...inputQuery(project, id), enabled: id !== null && index < 0 && !!project });
  return { index, alone: alone.data, alone_error: alone.error };
};


const InputsPage = () => {
  const { project, query } = useSelected();
  const { docs_root } = useSiteConfig();
  usePageTitle(join_title('Inputs', project_name(project)));
  const filters = inputs_filters_from_query(query);
  const setFilters = (changes, { replace = false } = {}) => updateSelected(changes, {
    replace,
    defaults: { ...inputs_defaults, meta: '', live: '1', input: '' },
  });
  // the switch: live=0 when off
  const setLive = live => setFilters({ live: live ? '1' : '0' });
  const [search, onSearch] = useUrlText(filters.q, q => setFilters({ q }, { replace: true }), 300);
  const search_box = useRef(null);
  useEffect(() => {
    const onKeyDown = event => {
      if (event.key !== '/' || is_typing(event.target) || event.metaKey || event.ctrlKey || document.body.classList.contains(Classes.OVERLAY_OPEN)) return;
      event.preventDefault();
      search_box.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const paged = usePagedInputs(inputsQuery(project, filters));
  const { first, count, items, item_at, loadMore, isPending, error, refetch } = paged;
  const folders = first?.folders ?? [];
  const metadata = first?.metadata ?? [];
  // the folder shown: the server's, deeper than the filter when it skipped single folders
  const location = first?.location ?? filters.folder;
  const collections = useCollections(project);

  const [selection, setSelection] = useState(empty_selection);
  const loaded_by_id = new Map(items.map(i => [i.id, i]));
  const selected_ids = [...selection.selected.keys()];
  const selected = selected_inputs(selection, loaded_by_id);
  const selected_count = selected_ids.length;
  // the filters the list shows: "Select all matching" selects the inputs they match
  const key = filters_key(filters);
  const current_key = useRef(key);
  useEffect(() => { current_key.current = key; }, [key]);
  const matching_now = { key, filters: { q: filters.q, folder: filters.folder, database: filters.database, meta: filters.meta, live: filters.live } };
  const all_loaded = !isPending && count > 0 && items.length >= count;
  // A selection of every input the filters match, whichever way users made it (Ctrl+A when all are loaded): says so
  const changeSelection = next => {
    if (!next.matching && all_loaded && next.selected.size === count && items.every(i => next.selected.has(i.id))) {
      return setSelection({ ...next, matching: { ...matching_now, count } });
    }
    setSelection(next);
  };
  const all_matching_selected = !!selection.matching && selection.matching.key === key && selection.matching.count === count && selected_count === count;
  const every_loaded_selected = selected_count > 0 && items.length > 0 && items.every(i => selection.selected.has(i.id));
  const too_many = count > max_collection_inputs;
  const [selecting_all, setSelectingAll] = useState(false);
  const selectAllMatching = async () => {
    const asked = key;
    setSelectingAll(true);
    try {
      const { ids, too_many: over, max } = await fetchMatchingIds(project, filters);
      // the filters changed meanwhile: that answer is for the old ones
      if (current_key.current !== asked) return;
      if (over) {
        toaster.show({ message: `These filters match more than ${max.toLocaleString()} inputs, the most a collection holds: narrow them.`, intent: Intent.WARNING, icon: 'filter', timeout: 6000 });
        return;
      }
      setSelection(select_matching(ids, loaded_by_id, matching_now));
    } catch (error) {
      toaster.show({ message: <>Could not select every matching input: {errorMessage(error)}</>, intent: Intent.DANGER, icon: 'error' });
    } finally {
      setSelectingAll(false);
    }
  };
  // what the dialogs prefill as the version's notes
  const provenance = selection_provenance({ count: selected_count, filters: matching_now.filters, matching: selection.matching });
  const paths_known = selected.length === selected_count;
  const [dialog, setDialog] = useState(null);
  const [guide_hidden, setGuideHidden] = useState(false);
  const [collections_open, setCollectionsOpen] = useState(false);

  const add_to = query.add_to !== undefined ? Number(query.add_to) : null;
  const add_to_collection = useQuery({ ...collectionQuery(add_to, null, project), enabled: add_to !== null && !Number.isNaN(add_to) });

  // the viewer: ?input=<id>
  const viewed_id = query.input !== undefined && query.input !== '' ? String(query.input) : null;
  const { index: viewed_index, alone } = useViewed(project, viewed_id, items);
  const openViewer = index => {
    const input = item_at(index);
    if (input) setFilters({ input: String(input.id) }, { replace: true });
  };
  const closeViewer = () => {
    const id = viewed_id;
    setFilters({ input: '' }, { replace: true });
    // back to where users were in the grid
    requestAnimationFrame(() => document.querySelector(`[role="gridcell"][data-index="${items.findIndex(i => String(i.id) === id)}"]`)?.focus());
  };

  const meta_filters = Object.entries(filters.meta);
  const filtered = !!(filters.q || filters.folder || filters.database || meta_filters.length);
  const clearFilters = () => setFilters({ q: '', folder: '', database: '', meta: '' });
  // on the tiles: where the input is, from the folder shown
  const tile_meta = input => [middle(folder_from(full_path(input), location), 36), default_input_meta({ ...input, database: undefined })].filter(Boolean).join(' · ');
  const show_guide = !guide_hidden && !collections.isPending && collections.list.length === 0 && count > 0;

  return <Page aria-labelledby="inputs-title">
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 420px', minWidth: 0 }}>
        <h1 id="inputs-title" className={Classes.HEADING}>Inputs</h1>
        <p className={`qa-lede ${Classes.TEXT_MUTED}`}>
          Every input the runs of <strong>{project}</strong> and its subprojects used. Find the ones you need, save them as a collection, and run on it from a batch file or Python.
        </p>
      </div>
      <PopoverNext
        isOpen={collections_open}
        onInteraction={setCollectionsOpen}
        placement="bottom-end"
        content={<CollectionsPanel project={project} docs_root={docs_root} on_inputs_page onPick={() => setCollectionsOpen(false)}/>}
      >
        <Button
          icon={collections_icon}
          endIcon="caret-down"
          text={collections.list.length ? `Open a collection (${collections.list.length})` : 'Collections'}
          title={collections.list.length ? 'The collections of the project: named, versioned sets of inputs' : 'No collections yet: select inputs, then “Save as collection”'}
          aria-haspopup="menu"
          aria-expanded={collections_open}
        />
      </PopoverNext>
    </div>

    {add_to !== null && <Callout intent={Intent.PRIMARY} icon="add-to-folder" title={add_to_collection.data ? `Adding inputs to ${pretty_name(add_to_collection.data.name)}` : 'Adding inputs to a collection'}>
      Select inputs, then <strong>Add to {add_to_collection.data ? pretty_name(add_to_collection.data.name) : 'the collection'}</strong>: it saves a new version.{' '}
      {add_to_collection.data && <Link to={collection_path(project, add_to_collection.data)}>Back to the collection</Link>}
    </Callout>}

    {show_guide && <HowItWorks onDismiss={() => setGuideHidden(true)}/>}

    <Layout>
      <aside className="qa-inputs-aside" aria-label="Filters">
        <Folders root={first?.root} location={location} here={first?.here ?? 0} folders={folders} setFilters={setFilters} loading={isPending}/>
        <Metadata metadata={metadata} project={project} filters={filters} setFilters={setFilters} loading={isPending} docs_root={docs_root}/>
      </aside>

      <div className="qa-inputs-main">
        <div className="qa-toolbar">
          <InputGroup
            inputRef={search_box}
            type="search"
            leftIcon="search"
            placeholder="Search paths, e.g. night street"
            aria-label="Search inputs"
            value={search}
            onChange={onSearch}
            rightElement={search ? <Button variant="minimal" icon="cross" aria-label="Clear the search" onClick={() => onSearch('')}/> : <kbd className={`${Classes.KEY} qa-key-hint`} aria-hidden>/</kbd>}
            style={{ minWidth: 0 }}
            fill
            className="qa-inputs-search"
          />
          <Tooltip content="Leave out the inputs whose runs were all deleted" placement="bottom">
            <Switch role="switch" aria-checked={filters.live} checked={filters.live} onChange={e => setLive(e.target.checked)} label="Hide inputs whose runs were deleted"/>
          </Tooltip>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, flexWrap: 'wrap' }} aria-live="polite">
          {isPending ? <span className={Classes.SKELETON}>1,000 inputs</span>
            : <span><strong style={{ fontSize: 15 }}>{count.toLocaleString()}</strong> <span className={Classes.TEXT_MUTED}>input{count === 1 ? '' : 's'}{filtered ? ' match' : ''}</span></span>}
          {filters.database && <Tag minimal icon="database" onRemove={() => setFilters({ database: '' })} title={filters.database}>{database_label(filters.database)}</Tag>}
          {meta_filters.map(([key, filter]) => <Tag key={key} minimal icon="tag" onRemove={() => setFilters({ meta: stringify_meta({ ...filters.meta, [key]: [] }) })} title={describe_meta(key, filter)}>{describe_meta(key, filter)}</Tag>)}
          {filtered && <Button variant="minimal" size="small" icon="filter-remove" text="Clear filters" onClick={clearFilters}/>}
          {count > 0 && <Button variant="minimal" size="small" text={all_loaded ? 'Select all' : `Select the ${items.length.toLocaleString()} shown`} onClick={() => changeSelection({ selected: new Map(items.map(i => [i.id, i])), anchor: null })} title={all_loaded ? `Selects the ${count.toLocaleString()} inputs (Ctrl+A in the grid)` : `Selects the ${items.length.toLocaleString()} inputs loaded so far (Ctrl+A in the grid)`}/>}
          {count > 0 && !all_loaded && !isPending && (too_many
            ? <Tooltip content={`A collection holds at most ${max_collection_inputs.toLocaleString()} inputs: narrow the filters to select every match.`} placement="bottom">
                <AnchorButton variant="minimal" size="small" text={`Select all ${count.toLocaleString()} matching`} disabled/>
              </Tooltip>
            : <Button variant="minimal" size="small" text={`Select all ${count.toLocaleString()} matching`} loading={selecting_all} disabled={all_matching_selected} onClick={selectAllMatching} title="Selects every input these filters match, also those not loaded yet"/>)}
          <span style={{ marginLeft: 'auto' }} className={Classes.TEXT_MUTED}>Sort</span>
          <HTMLSelect
            aria-label="Sort by"
            minimal
            value={filters.sort}
            onChange={e => setFilters({ sort: e.target.value })}
            options={inputs_sorts.map(({ value, label }) => ({ value, label }))}
          />
        </div>

        {error ? <NonIdealState
          icon="error"
          title="Could not load the inputs"
          description={errorMessage(error)}
          action={<Button icon="refresh" text="Retry" onClick={() => refetch()}/>}
        /> : !isPending && count === 0 ? (filtered || filters.live === false
          ? <NonIdealState
              icon="search"
              title="No inputs match"
              description={<>No input {filters.q ? <>matches “{filters.q}”</> : 'is there'}{filters.folder ? <> under <code>{filters.folder}</code></> : ''}{filters.database ? <> in {database_label(filters.database)}</> : ''}{meta_filters.length ? <> with {meta_filters.map(([key, filter]) => describe_meta(key, filter)).join(', ')}</> : ''}{filters.live ? ', among those with runs left' : ''}.</>}
              action={<div style={{ display: 'flex', gap: 8 }}>
                <Button icon="filter-remove" text="Clear the filters" onClick={clearFilters}/>
                {filters.live && <Button text="Show inputs whose runs were deleted" onClick={() => setLive(false)}/>}
              </div>}
            />
          : <NonIdealState
              icon="media"
              title="No inputs yet"
              description={<>Inputs show here once runs of {project} use them, e.g. after <code>qa batch</code>, or once you add them before any run: <code>qa inputs add &lt;batch or paths&gt;</code>.{filters.live && <> Inputs whose runs were all deleted are hidden.</>}</>}
              action={filters.live ? <Button text="Show inputs whose runs were deleted" onClick={() => setLive(false)}/> : undefined}
            />)
        : <>
            {count > 0 && !all_loaded && (every_loaded_selected || all_matching_selected) && <MatchingBanner role="status">
              {all_matching_selected
                ? <><span>All <strong>{count.toLocaleString()}</strong> matching inputs are selected.</span>
                    <Button variant="minimal" size="small" intent={Intent.PRIMARY} text="Clear selection" onClick={() => setSelection(empty_selection)}/></>
                : too_many
                  ? <span>All {plural(items.length, 'loaded input')} {items.length === 1 ? 'is' : 'are'} selected. These filters match {count.toLocaleString()}, more than a collection holds ({max_collection_inputs.toLocaleString()}): narrow them to select every match.</span>
                  : <><span>All {plural(items.length, 'loaded input')} {items.length === 1 ? 'is' : 'are'} selected.</span>
                      <Button variant="minimal" size="small" intent={Intent.PRIMARY} loading={selecting_all} text={`Select all ${count.toLocaleString()} matching`} onClick={selectAllMatching}/></>}
            </MatchingBanner>}
            <InputGrid
              label={`Inputs of ${project}`}
              count={isPending ? 24 : count}
              item_at={item_at}
              loadMore={loadMore}
              selection={selection}
              onSelectionChange={changeSelection}
              onOpen={openViewer}
              meta={tile_meta}
            />
          </>}

        {selected_count > 0 && <SelectionBar role="region" aria-label="Selection" className={Classes.DARK}>
          <strong>{plural(selected_count, 'input')} selected</strong>
          <Button variant="minimal" text="Clear" onClick={() => setSelection(empty_selection)}/>
          <span style={{ flex: 1 }}/>
          {paths_known
            ? <CopyPathButtons paths={selected.map(full_path)} text={selected.length === 1 ? 'Copy path' : 'Copy paths'}/>
            : <Tooltip content="Only the paths of the inputs loaded are known here: save them as a collection, then copy its paths with qa collections show." placement="top">
                <AnchorButton icon="duplicate" text="Copy paths" disabled/>
              </Tooltip>}
          {add_to !== null && add_to_collection.data
            ? <>
                <Button icon="add-to-folder" text="Another collection…" onClick={() => setDialog('add')}/>
                <WriteButton allowed={add_to_collection.data.can_edit !== false} who={who_can_write(add_to_collection.data.project ?? project)} intent={Intent.PRIMARY} icon="add" text={`Add to ${pretty_name(add_to_collection.data.name)}`} onClick={() => setDialog('add-to')}/>
              </>
            : <>
                <WriteButton allowed={collections.can_create !== false} who={who_can_create} icon="add-to-folder" text="Add to collection…" onClick={() => setDialog('add')}/>
                <WriteButton allowed={collections.can_create !== false} who={who_can_create} intent={Intent.PRIMARY} icon="floppy-disk" text="Save as collection" onClick={() => setDialog('save')}/>
              </>}
        </SelectionBar>}
      </div>
    </Layout>

    {dialog === 'save' && <SaveCollectionDialog project={project} ids={selected_ids} inputs={selected} notes={provenance} isOpen onClose={() => setDialog(null)} onSaved={() => setSelection(empty_selection)}/>}
    {(dialog === 'add' || dialog === 'add-to') && <AddToCollectionDialog project={project} ids={selected_ids} inputs={selected} notes={provenance} isOpen initial={dialog === 'add-to' ? add_to : null} onClose={() => setDialog(null)}/>}

    {viewed_id !== null && (viewed_index >= 0
      ? <InputViewer
          project={project}
          count={count}
          item_at={item_at}
          loadMore={loadMore}
          index={viewed_index}
          onIndexChange={index => openViewer(index)}
          onClose={closeViewer}
          selected={selection.selected.has(item_at(viewed_index)?.id)}
          onToggleSelected={index => changeSelection(toggle_selection(selection, index, item_at))}
          context={filters.folder || undefined}
        />
      : (alone || isPending) && <InputViewer
          project={project}
          count={1}
          item_at={() => alone}
          index={0}
          onIndexChange={() => {}}
          onClose={closeViewer}
        />)}
  </Page>;
};

export default InputsPage;
