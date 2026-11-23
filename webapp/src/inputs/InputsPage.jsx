// /<project>/inputs: every input the project's runs (and its subprojects') used, to find some and save them as a
// collection. The URL says what's shown, so links can be shared:
//   ?q=<search>&folder=<path prefix>&database=<database>&live=0 (also inputs without runs left)&sort=path&input=<id> (the viewer)
//   &add_to=<collection id>: users came from a collection to add inputs to it
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import styled from "styled-components";
import {
  AnchorButton, Button, Callout, Classes, Colors, HTMLSelect, Icon, InputGroup, Intent, NonIdealState, PopoverNext, Switch, Tag, Tooltip,
} from "@blueprintjs/core";

import { Link } from "../router";
import { useSelected, updateSelected } from "../selection";
import { useUrlText, useSiteConfig } from "../hooks";
import { errorMessage } from "../api/http";
import { is_typing } from "../components/HelpSheet";
import { copyWithToast } from "../utils/clipboard";
import { usePageTitle, join_title, project_name } from "../pageTitle";
import {
  inputsQuery, inputQuery, inputs_filters_from_query, inputs_defaults, inputs_sorts, folder_breadcrumb, subfolder_name,
  subfolder_path, database_label, collection_path, pretty_name, collectionQuery,
} from "./api";
import { usePagedInputs } from "./usePaged";
import { InputGrid } from "./InputGrid";
import { InputViewer } from "./InputViewer";
import { SaveCollectionDialog, AddToCollectionDialog } from "./CollectionDialogs";
import { CollectionsPanel } from "./CollectionsPanel";
import { useCollections } from "./hooks";
import { empty_selection, toggle_selection } from "./gridSelection";


// Saving collections needs the collections.write permission: developers and owners of the project
export const who_can_write = project => `Only developers and owners of ${project} can save collections: ask an owner of the project for the developer role.`;
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
    flex: 0 1 220px;
    min-width: 180px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    position: sticky;
    top: 66px;
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
      gap: 8px;
    }
    .qa-database-facet {
      display: none;
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

// The folder's breadcrumb, and its subfolders
const Folders = ({ folder, folders, setFilters, loading }) => {
  const crumbs = folder_breadcrumb(folder);
  return <nav aria-label="Folders">
    <h2 className={`qa-facet-title ${Classes.TEXT_MUTED}`}>Folder</h2>
    <div className="qa-breadcrumb">
      {crumbs.map((crumb, i) => <span key={crumb.folder} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
        {i > 0 && <span className={Classes.TEXT_MUTED} aria-hidden>/</span>}
        {i === crumbs.length - 1
          ? <span aria-current="location" className={i > 0 ? Classes.MONOSPACE_TEXT : undefined}>{crumb.name}</span>
          : <button type="button" className={i > 0 ? Classes.MONOSPACE_TEXT : undefined} onClick={() => setFilters({ folder: crumb.folder })}>{crumb.name}</button>}
      </span>)}
    </div>
    {loading && <p className={Classes.SKELETON}>Loading the folders</p>}
    {!loading && folders.length > 0 && <ul className="qa-facet-list">
      {folders.map(f => <FacetRow
        key={f.folder}
        icon="folder-close"
        name={<span className={Classes.MONOSPACE_TEXT} style={{ fontSize: 12 }}>{f.name || subfolder_name(f.folder, folder)}</span>}
        title={subfolder_path(f.folder, folder)}
        count={f.count}
        onClick={() => setFilters({ folder: subfolder_path(f.folder, folder) })}
      />)}
    </ul>}
    {!loading && folders.length === 0 && folder && <p className={Classes.TEXT_MUTED} style={{ fontSize: 12, margin: 0 }}>No subfolders</p>}
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
    defaults: { ...inputs_defaults, live: '1', input: '' },
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
  const databases = first?.databases ?? [];
  const folders = first?.folders ?? [];
  const collections = useCollections(project);

  const [selection, setSelection] = useState(empty_selection);
  const selected = [...selection.selected.values()];
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

  const filtered = !!(filters.q || filters.folder || filters.database);
  const clearFilters = () => setFilters({ q: '', folder: '', database: '' });
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
        content={<CollectionsPanel project={project} docs_root={docs_root} onPick={() => setCollectionsOpen(false)}/>}
      >
        <Button icon="folder-close" endIcon="caret-down" text={`Collections${collections.list.length ? ` (${collections.list.length})` : ''}`} aria-haspopup="menu" aria-expanded={collections_open}/>
      </PopoverNext>
    </div>

    {add_to !== null && <Callout intent={Intent.PRIMARY} icon="add-to-folder" title={add_to_collection.data ? `Adding inputs to ${pretty_name(add_to_collection.data.name)}` : 'Adding inputs to a collection'}>
      Select inputs, then <strong>Add to {add_to_collection.data ? pretty_name(add_to_collection.data.name) : 'the collection'}</strong>: it saves a new version.{' '}
      {add_to_collection.data && <Link to={collection_path(project, add_to_collection.data)}>Back to the collection</Link>}
    </Callout>}

    {show_guide && <HowItWorks onDismiss={() => setGuideHidden(true)}/>}

    <Layout>
      <aside className="qa-inputs-aside" aria-label="Filters">
        <Folders folder={filters.folder} folders={folders} setFilters={setFilters} loading={isPending}/>
        {databases.length > 1 && <section aria-label="Databases" className="qa-database-facet">
          <h2 className={`qa-facet-title ${Classes.TEXT_MUTED}`}>Database</h2>
          <ul className="qa-facet-list">
            <FacetRow name="All databases" pressed={!filters.database} onClick={() => setFilters({ database: '' })}/>
            {databases.map(d => <FacetRow
              key={d.database}
              icon="database"
              name={database_label(d.database)}
              title={d.database}
              count={d.count}
              pressed={filters.database === d.database}
              onClick={() => setFilters({ database: filters.database === d.database ? '' : d.database })}
            />)}
          </ul>
        </section>}
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
          <HTMLSelect
            aria-label="Database"
            className={`qa-database-select${databases.length > 1 ? ' qa-has-facet' : ''}`}
            value={filters.database}
            onChange={e => setFilters({ database: e.target.value })}
            options={[
              { value: '', label: 'All databases' },
              ...databases.map(d => ({ value: d.database, label: `${database_label(d.database)} (${d.count.toLocaleString()})` })),
              ...(filters.database && !databases.some(d => d.database === filters.database) ? [{ value: filters.database, label: database_label(filters.database) }] : []),
            ]}
          />
          <Tooltip content="Leave out the inputs whose runs were all deleted" placement="bottom">
            <Switch role="switch" aria-checked={filters.live} checked={filters.live} onChange={e => setLive(e.target.checked)} label="Only inputs with runs"/>
          </Tooltip>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, flexWrap: 'wrap' }} aria-live="polite">
          {isPending ? <span className={Classes.SKELETON}>1,000 inputs</span>
            : <span><strong style={{ fontSize: 15 }}>{count.toLocaleString()}</strong> <span className={Classes.TEXT_MUTED}>input{count === 1 ? '' : 's'}{filtered ? ' match' : ''}</span></span>}
          {filters.folder && <Tag minimal icon="folder-close" onRemove={() => setFilters({ folder: '' })} title="Inputs under this folder">{filters.folder}</Tag>}
          {filters.database && <Tag minimal icon="database" onRemove={() => setFilters({ database: '' })} title={filters.database}>{database_label(filters.database)}</Tag>}
          {count > 0 && <Button variant="minimal" size="small" text="Select all loaded" onClick={() => setSelection({ selected: new Map(items.map(i => [i.id, i])), anchor: null })} title={`Selects the ${items.length.toLocaleString()} inputs loaded so far (Ctrl+A in the grid)`}/>}
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
              description={<>No input {filters.q ? <>matches “{filters.q}”</> : 'is there'}{filters.folder ? <> under <code>{filters.folder}</code></> : ''}{filters.database ? <> in {database_label(filters.database)}</> : ''}{filters.live ? ', among those with runs left' : ''}.</>}
              action={<div style={{ display: 'flex', gap: 8 }}>
                <Button icon="filter-remove" text="Clear the filters" onClick={clearFilters}/>
                {filters.live && <Button text="Include inputs without runs" onClick={() => setLive(false)}/>}
              </div>}
            />
          : <NonIdealState
              icon="media"
              title="No inputs yet"
              description={<>Inputs show here once runs of {project} use them, e.g. after <code>qa batch</code>.{filters.live && <> Inputs whose runs were all deleted are hidden.</>}</>}
              action={filters.live ? <Button text="Include inputs without runs" onClick={() => setLive(false)}/> : undefined}
            />)
        : <InputGrid
            label={`Inputs of ${project}`}
            count={isPending ? 24 : count}
            item_at={item_at}
            loadMore={loadMore}
            selection={selection}
            onSelectionChange={setSelection}
            onOpen={openViewer}
          />}

        {selected.length > 0 && <SelectionBar role="region" aria-label="Selection" className={Classes.DARK}>
          <strong>{plural(selected.length, 'input')} selected</strong>
          <Button variant="minimal" text="Clear" onClick={() => setSelection(empty_selection)}/>
          <span style={{ flex: 1 }}/>
          <Button icon="duplicate" text="Copy paths" onClick={() => copyWithToast(selected.map(i => i.path).join('\n'), { what: `${plural(selected.length, 'path')}` })}/>
          {add_to !== null && add_to_collection.data
            ? <>
                <Button icon="add-to-folder" text="Another collection…" onClick={() => setDialog('add')}/>
                <WriteButton allowed={add_to_collection.data.can_edit !== false} who={who_can_write(add_to_collection.data.project ?? project)} intent={Intent.PRIMARY} icon="add" text={`Add to ${pretty_name(add_to_collection.data.name)}`} onClick={() => setDialog('add-to')}/>
              </>
            : <>
                <WriteButton allowed={collections.can_create !== false} who={who_can_write(project)} icon="add-to-folder" text="Add to collection…" onClick={() => setDialog('add')}/>
                <WriteButton allowed={collections.can_create !== false} who={who_can_write(project)} intent={Intent.PRIMARY} icon="floppy-disk" text="Save as collection" onClick={() => setDialog('save')}/>
              </>}
        </SelectionBar>}
      </div>
    </Layout>

    {dialog === 'save' && <SaveCollectionDialog project={project} inputs={selected} isOpen onClose={() => setDialog(null)} onSaved={() => setSelection(empty_selection)}/>}
    {(dialog === 'add' || dialog === 'add-to') && <AddToCollectionDialog project={project} inputs={selected} isOpen initial={dialog === 'add-to' ? add_to : null} onClose={() => setDialog(null)}/>}

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
          onToggleSelected={index => setSelection(toggle_selection(selection, index, item_at))}
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
