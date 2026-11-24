// /<project>/collections/<id>: a collection's inputs, its versions, and how to use it from Python and batch files.
//   ?version=<n>: an older version (the latest by default), ?tab=python|yaml, ?q=<search>, ?input=<id>: the viewer
// Editing removes inputs, or adds some from the Inputs page (?add_to=<id>), then saves the next version: older
// versions never change. When someone saved meanwhile, the server answers 409: users reload, or save anyway.
import { Fragment, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import styled from "styled-components";
import { DateTime } from "luxon";
import {
  Alert, AnchorButton, Button, Callout, Classes, Colors, Icon, InputGroup, Intent, Menu, MenuDivider, MenuItem,
  NonIdealState, PopoverNext, SegmentedControl, Tab, Tabs, Tag, TextArea, Tooltip,
} from "@blueprintjs/core";

import { Link, history, useRouter } from "../router";
import { useSelected, updateSelected } from "../selection";
import { useUrlText, useUser } from "../hooks";
import { errorMessage } from "../api/http";
import { copyWithToast, copyLink } from "../utils/clipboard";
import { usePageTitle, join_title, project_name } from "../pageTitle";
import { toaster } from "../toaster";
import {
  collectionQuery, collectionInputsQuery, collection_ref, collection_path, inputs_path, pretty_name, python_snippet,
  yaml_snippet, batch_name, export_yaml_url, fetchMemberIds, next_members, is_conflict, pin_label, pin_key, is_pinned_for, creator_name,
  name_parts, collections_index_path, conflict_data,
} from "./api";
import { useCollections, useCollectionActions } from "./hooks";
import { collections_icon } from "./icons";
import { usePagedInputs } from "./usePaged";
import { InputGrid } from "./InputGrid";
import { InputViewer } from "./InputViewer";
import { Page } from "./InputsPage";
import { empty_selection } from "./gridSelection";


const Columns = styled.div`
  display: flex;
  gap: 24px;
  align-items: flex-start;
  flex-wrap: wrap;
  .qa-collection-main {
    flex: 999 1 560px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .qa-collection-aside {
    flex: 1 1 260px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .qa-section-title {
    margin: 0 0 6px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .qa-versions {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .qa-versions a {
    display: block;
    padding: 6px 8px;
    border-radius: 3px;
    color: inherit;
    text-decoration: none;
  }
  .qa-versions a:hover, .qa-versions a:focus-visible {
    background: rgba(143, 153, 168, 0.15);
  }
  .qa-versions a[aria-current] {
    background: rgba(45, 114, 210, 0.15);
  }
  .qa-collection-search {
    flex: 0 1 260px;
    min-width: 0;
  }
  .${Classes.TAB_LIST} {
    flex-wrap: wrap;
    row-gap: 4px;
  }
  .qa-code {
    display: flex;
    gap: 6px;
    align-items: flex-start;
  }
  .qa-code pre {
    flex: 1;
    min-width: 0;
    margin: 0;
    overflow-x: auto;
  }
`;

const Header = styled.header`
  display: flex;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
  .qa-title {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    min-width: 0;
  }
  h1 {
    margin: 0;
    font-size: clamp(22px, 5vw, 32px);
    line-height: 1.2;
    overflow-wrap: break-word;
  }
  h1 .qa-owner {
    display: block;
    font-size: 14px;
    font-weight: 400;
    line-height: 1.6;
  }
  h1 .qa-sep {
    font-weight: 400;
    opacity: 0.6;
  }
  .qa-meta {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 6px;
    font-size: 13px;
  }
  .qa-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-left: auto;
  }
`;

// The editing bar, at the bottom of the screen
const EditBar = styled.div`
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

const full_date = date => date ? DateTime.fromISO(date).toLocaleString(DateTime.DATETIME_MED) : '';
const relative = date => date ? DateTime.fromISO(date).toRelative() : '';
const plural = (n, word) => `${Number(n ?? 0).toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

// Code to copy
const Code = ({ code, what, label }) => <div className="qa-code">
  <pre className={Classes.CODE_BLOCK} aria-label={label}>{code}</pre>
  <Tooltip content={`Copy ${what}`}>
    <Button icon="duplicate" aria-label={`Copy ${what}`} onClick={() => copyWithToast(code, { what })}/>
  </Tooltip>
</div>;

// Which version code uses: the one shown (pinned: always the same inputs) or the latest when it runs
const RefChoice = ({ collection, version, value, onChange }) => <SegmentedControl
  size="small"
  value={value}
  onValueChange={onChange}
  options={[
    { value: 'pinned', label: `This version, ${collection_ref(collection, version)}` },
    { value: 'latest', label: `The latest, ${collection_ref(collection)}` },
  ]}
  aria-label="Version used"
/>;

const PythonTab = ({ collection, version, project }) => {
  const [which, setWhich] = useState('pinned');
  const ref = which === 'pinned' ? collection_ref(collection, version) : collection_ref(collection);
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <p style={{ margin: 0 }}>List its inputs from Python, with the server and credentials <code>qa</code> uses (<code>qa auth login</code>).</p>
    <RefChoice collection={collection} version={version} value={which} onChange={setWhich}/>
    <Code code={python_snippet(ref)} what="the Python code" label="Python"/>
    <p className={Classes.TEXT_MUTED} style={{ margin: 0, fontSize: 13 }}>
      Outside of {project} and its subprojects, name the project: <code>collections.get("{collection_ref(collection, which === 'pinned' ? version : undefined)}", project="{collection.project ?? project}")</code>.
      From the shell: <code>qa collections show {ref}</code>.
    </p>
  </div>;
};

const YamlTab = ({ collection, version }) => {
  const [which, setWhich] = useState('pinned');
  const ref = which === 'pinned' ? collection_ref(collection, version) : collection_ref(collection);
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <p style={{ margin: 0 }}>Run a batch on it: add it to a batch file (one that qaboard.yaml lists in <code>inputs.batches</code>), then <code>qa batch {batch_name(collection.name)}</code>.</p>
    <RefChoice collection={collection} version={version} value={which} onChange={setWhich}/>
    <Code code={yaml_snippet(ref, collection.name)} what="the YAML" label="qa/batches.yaml"/>
    <p className={Classes.TEXT_MUTED} style={{ margin: 0, fontSize: 13 }}>
      {which === 'pinned'
        ? <>With <code>@{version}</code>, batches always run on the same inputs. Without it, on the latest version when the batch starts.</>
        : <>Batches run on the latest version when they start, and record which one in their runs.</>}
      {' '}Its inputs, as a file: <a href={export_yaml_url(collection, version)} download>{collection_ref(collection, version)}.yaml</a>
    </p>
  </div>;
};

// Pin for the user's groups, or everyone on the project (owners)
const PinMenu = ({ collection, my_groups, can_pin_everyone, togglePin }) => {
  const pinned = collection.pinned_for ?? [];
  // groups pinned for, that the server didn't list as the user's
  const others = pinned.filter(g => pin_key(g) !== 'everyone' && !my_groups.some(m => pin_key(m) === pin_key(g)));
  const check = group => is_pinned_for(collection, group) ? 'tick' : 'blank';
  return <Menu aria-label="Pin">
    <MenuItem
      icon={check(null)}
      text="Everyone on the project"
      label={can_pin_everyone === false ? 'owners' : undefined}
      disabled={can_pin_everyone === false}
      title="Pinned collections are listed first in the sidebar"
      onClick={() => togglePin(collection, null).catch(() => {})}
    />
    {my_groups.length > 0 && <MenuDivider title="My groups"/>}
    {my_groups.map(group => <MenuItem key={pin_key(group)} icon={check(group)} text={pin_label(group)} onClick={() => togglePin(collection, group).catch(() => {})}/>)}
    {others.length > 0 && <MenuDivider title="Also pinned for"/>}
    {others.map(group => <MenuItem key={pin_key(group)} icon="tick" text={pin_label(group)} onClick={() => togglePin(collection, group).catch(() => {})}/>)}
  </Menu>;
};

// Why we can't show a collection
const Problem = ({ error, project }) => {
  const status = error?.response?.status;
  return <NonIdealState
    icon={status === 403 ? 'lock' : status === 404 ? 'folder-close' : 'error'}
    title={status === 404 ? "This collection doesn't exist" : status === 403 ? "You can't see this collection" : 'Could not load the collection'}
    description={status === 404 ? 'The link may be wrong, or it was in another project.' : errorMessage(error)}
    action={<Link to={collections_index_path(project)}><Button icon={collections_icon} text="All the collections"/></Link>}
  />;
};


const CollectionPage = () => {
  const { project, query } = useSelected();
  const { match } = useRouter();
  const user = useUser();
  const queryClient = useQueryClient();
  const id = Number(match.params.collection_id);
  const version_param = /^\d+$/.test(query.version ?? '') ? Number(query.version) : null;
  const tab = ['python', 'yaml'].includes(query.tab) ? query.tab : 'inputs';
  const set = (changes, options) => updateSelected(changes, { defaults: { tab: 'inputs', q: '', input: '', version: '' }, ...options });
  const [search, onSearch] = useUrlText(typeof query.q === 'string' ? query.q : '', q => set({ q }, { replace: true }), 300);

  const { data: collection, error, isPending } = useQuery(collectionQuery(id, version_param, project));
  const { my_groups } = useCollections(project);
  const actions = useCollectionActions(project);
  const version = version_param ?? collection?.version?.version ?? collection?.latest_version;
  const paged = usePagedInputs(collectionInputsQuery(id, version_param, { q: typeof query.q === 'string' ? query.q : '', project }));
  usePageTitle(join_title(collection ? pretty_name(collection.name) : 'Collection', project_name(project)));

  const [editing, setEditing] = useState(null);
  const [selection, setSelection] = useState(empty_selection);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(null);

  if (Number.isNaN(id)) return <Page><Problem error={{ response: { status: 404 } }} project={project}/></Page>;
  if (error) return <Page><Problem error={error} project={project}/></Page>;
  if (isPending || !collection) return <Page aria-busy="true">
    <h1 className={`${Classes.HEADING} ${Classes.SKELETON}`}>Loading the collection</h1>
    <p className={Classes.SKELETON}>Its versions and inputs</p>
    <InputGrid count={12} item_at={() => undefined} label="Loading the inputs" selectable={false}/>
  </Page>;

  const latest = collection.latest_version;
  const is_latest = version === latest;
  const versions = [...(collection.versions ?? [])].sort((a, b) => b.version - a.version);
  const shown_version = collection.version ?? versions.find(v => v.version === version) ?? {};
  const is_other_project = collection.inherited ?? (!!collection.project && collection.project !== project);
  const can_write = user.is_logged && collection.can_edit !== false;
  const removed = editing?.removed ?? new Set();
  const selected = [...selection.selected.values()];

  const startEditing = () => {
    setEditing({ removed: new Set(), notes: '', base_version: latest });
    setSelection(empty_selection);
  };
  const removeSelected = () => {
    setEditing({ ...editing, removed: new Set([...removed, ...selection.selected.keys()]) });
    setSelection(empty_selection);
  };
  const restoreSelected = () => {
    const next = new Set(removed);
    for (const key of selection.selected.keys()) next.delete(key);
    setEditing({ ...editing, removed: next });
    setSelection(empty_selection);
  };
  const save = async base_version => {
    setSaving(true);
    try {
      const members = await fetchMemberIds(collection.id, version, { project });
      const inputs = next_members(members, { removed: [...removed] });
      const saved = await actions.save(collection, { inputs, base_version, notes: editing.notes });
      const new_version = saved?.latest_version ?? base_version + 1;
      toaster.show({ message: `Saved ${pretty_name(collection.name)}@${new_version}, with ${plural(inputs.length, 'input')}`, intent: Intent.SUCCESS, icon: 'floppy-disk', timeout: 5000 });
      setEditing(null);
      setConflict(null);
      set({ version: '' });
    } catch (err) {
      if (is_conflict(err)) {
        const fresh = await queryClient.fetchQuery({ ...collectionQuery(collection.id, null, project), staleTime: 0 }).catch(() => null);
        setConflict({ latest: conflict_data(err).latest_version ?? fresh?.latest_version ?? null, by: creator_name(fresh?.version ?? fresh) });
      }
    } finally {
      setSaving(false);
    }
  };
  const reload = () => {
    setConflict(null);
    setEditing(null);
    queryClient.invalidateQueries({ queryKey: ['collection', collection.id] });
    queryClient.invalidateQueries({ queryKey: ['collection-inputs', collection.id] });
    set({ version: '' });
  };

  // the viewer: ?input=<id>
  const viewed_id = query.input !== undefined && query.input !== '' ? String(query.input) : null;
  const viewed_index = viewed_id === null ? -1 : paged.items.findIndex(i => String(i.id) === viewed_id);
  const openViewer = index => {
    const input = paged.item_at(index);
    if (input) set({ input: String(input.id) }, { replace: true });
  };

  const name = pretty_name(collection.name);
  const project_part = is_other_project ? collection.project : project;
  return <Page aria-labelledby="collection-title">
    <nav aria-label="Breadcrumb" className={Classes.TEXT_MUTED} style={{ fontSize: 13, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {/* collections have their own page, apart from the inputs */}
      <Link to={collections_index_path(project)}><Icon icon={collections_icon} size={12} style={{ marginRight: 4, verticalAlign: 'text-top' }}/>Collections</Link>
      <span aria-hidden>›</span>
      <span aria-current="page">{name}</span>
    </nav>

    <Header>
      <div style={{ minWidth: 0, flex: '1 1 360px' }}>
        <div className="qa-title">
          <h1 id="collection-title" className={Classes.HEADING}>
            {/* the project only when it's another's: the sidebar and breadcrumb say which project this is */}
            {is_other_project && <span className={`qa-owner ${Classes.TEXT_MUTED}`}>{project_part}:</span>}
            {name_parts(collection.name).map((part, i) => <Fragment key={i}>{i > 0 && <span className="qa-sep"> / <wbr/></span>}{part}</Fragment>)}
          </h1>
          <PopoverNext placement="bottom-start" content={<Menu aria-label="Versions">
            {versions.map(v => <MenuItem
              key={v.version}
              icon={v.version === version ? 'tick' : 'blank'}
              text={<>@{v.version}{v.version === latest && <span className={Classes.TEXT_MUTED}> · latest</span>}</>}
              label={`${plural(v.size, 'input')} · ${relative(v.created_at)}`}
              title={[v.notes, creator_name(v) && `by ${creator_name(v)}`].filter(Boolean).join('\n')}
              onClick={() => set({ version: v.version === latest ? '' : String(v.version), input: '' })}
            />)}
          </Menu>}>
            <Button size="small" endIcon="caret-down" text={<>@{version}{is_latest ? ' · latest' : ''}</>} aria-label={`Version ${version}${is_latest ? ', the latest' : ''}: pick another`}/>
          </PopoverNext>
          {collection.archived && <Tag intent={Intent.WARNING} icon="archive">archived</Tag>}
          {collection.shared === false && <Tag minimal icon="person" title="Only you see it, in your lists and your batches">personal</Tag>}
        </div>
        <div className={`qa-meta ${Classes.TEXT_MUTED}`}>
          <Tag minimal icon="media">{plural(shown_version.size ?? collection.size, 'input')}</Tag>
          {(collection.pinned_for ?? []).map(g => <Tag key={pin_key(g)} minimal icon="pin" intent={Intent.PRIMARY}>{pin_label(g)}</Tag>)}
          <span title={full_date(shown_version.created_at ?? collection.created_at)}>
            {is_latest && versions.length > 1 ? 'Saved' : 'Created'} by <strong>{creator_name(shown_version) ?? creator_name(collection) ?? 'someone'}</strong> {relative(shown_version.created_at ?? collection.created_at)}
          </span>
          {is_other_project && <span>· from the parent project <strong>{collection.project}</strong></span>}
        </div>
        {!!collection.description && <p style={{ margin: '8px 0 0', maxWidth: 760, whiteSpace: 'pre-wrap' }}>{collection.description}</p>}
      </div>
      <div className="qa-actions">
        {user.is_logged && <Button
          icon={<Icon icon="heart" color={collection.favorite ? Colors.RED4 : undefined}/>}
          text={collection.favorite ? 'Favorite' : 'Add to favorites'}
          aria-pressed={!!collection.favorite}
          onClick={() => actions.toggleFavorite(collection).catch(() => {})}
        />}
        {can_write && collection.shared !== false && <PopoverNext placement="bottom-end" content={<PinMenu collection={collection} my_groups={my_groups} can_pin_everyone={collection.can_pin_everyone} togglePin={actions.togglePin}/>}>
          <Button icon="pin" endIcon="caret-down" text="Pin" title="Pin it for a group, or everyone: it's listed first in their sidebar"/>
        </PopoverNext>}
        {can_write && !editing && <Button icon="edit" text="Edit" onClick={startEditing} title="Remove or add inputs, then save a new version"/>}
        <PopoverNext placement="bottom-end" content={<Menu>
          <MenuItem icon="link" text="Copy the link" onClick={() => copyLink({ url: `${window.location.origin}${collection_path(project, collection, is_latest ? null : version)}`, text: `${collection_ref(collection, is_latest ? undefined : version)}`, details: collection.description?.split('\n')[0] }, { what: 'the link to the collection' })}/>
          <MenuItem icon="duplicate" text="Copy its name" label={<code>{collection_ref(collection, version)}</code>} onClick={() => copyWithToast(collection_ref(collection, version), { what: 'the name' })}/>
          <MenuItem icon="download" text="Download the YAML" href={export_yaml_url(collection, version)} download/>
          {can_write && <MenuDivider/>}
          {/* who sees it: its creator decides, sharing needs the developer role (the server says so if not) */}
          {collection.mine && <MenuItem
            icon={collection.shared === false ? 'people' : 'person'}
            text={collection.shared === false ? 'Share with the project' : 'Make personal'}
            title={collection.shared === false ? 'Everyone on the project sees it, in lists and in their batches' : 'Only you will see it: batches of others that use it will fail'}
            onClick={() => actions.setShared(collection, collection.shared === false).catch(() => {})}
          />}
          {can_write && <MenuItem
            icon={collection.archived ? 'unarchive' : 'archive'}
            text={collection.archived ? 'Unarchive' : 'Archive'}
            title={collection.archived ? 'List it again' : 'Hide it from lists: it keeps working in code and batch files'}
            onClick={() => actions.setArchived(collection, !collection.archived).catch(() => {})}
          />}
        </Menu>}>
          <Button icon="more" aria-label="More actions"/>
        </PopoverNext>
      </div>
    </Header>

    {collection.archived && <Callout intent={Intent.WARNING} icon="archive" compact>
      Archived: it's hidden from lists, and still works in code and batch files.{' '}
      {can_write && <Button size="small" variant="minimal" text="Unarchive" onClick={() => actions.setArchived(collection, false).catch(() => {})}/>}
    </Callout>}
    {!is_latest && <Callout intent={Intent.PRIMARY} icon="history" compact>
      You're looking at <strong>@{version}</strong>. The latest version is <Link to={collection_path(project, collection)} onClick={() => setEditing(null)}>@{latest}</Link>.
      {editing && <> Saving makes <strong>@{latest + 1}</strong> from @{version}'s inputs.</>}
    </Callout>}

    <Columns>
      <div className="qa-collection-main">
        <Tabs id="collection-tabs" selectedTabId={tab} onChange={value => set({ tab: value }, { replace: true })} large={false}>
          <Tab id="inputs" icon="media" title="Inputs"/>
          <Tab id="python" icon="code" title="Python"/>
          <Tab id="yaml" icon="document" title="Batch file"/>
        </Tabs>

        {tab === 'python' && <PythonTab collection={collection} version={version} project={project}/>}
        {tab === 'yaml' && <YamlTab collection={collection} version={version}/>}
        {tab === 'inputs' && <>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <InputGroup
              type="search"
              leftIcon="search"
              placeholder="Search its inputs"
              aria-label="Search the collection's inputs"
              value={search}
              onChange={onSearch}
              fill
              style={{ minWidth: 0 }}
              className="qa-collection-search"
            />
            <span className={Classes.TEXT_MUTED} style={{ fontSize: 13 }} aria-live="polite">
              {paged.isPending ? '' : search ? `${plural(paged.count, 'input')} match` : plural(paged.count, 'input')}
            </span>
          </div>
          {paged.error ? <NonIdealState icon="error" title="Could not load its inputs" description={errorMessage(paged.error)} action={<Button icon="refresh" text="Retry" onClick={() => paged.refetch()}/>}/>
            : !paged.isPending && paged.count === 0
              ? <NonIdealState
                  icon={search ? 'search' : 'folder-close'}
                  title={search ? 'No inputs match' : 'This version has no inputs'}
                  action={can_write && !search ? <Link to={inputs_path(project, { add_to: collection.id })}><Button icon="add" text="Add inputs"/></Link> : undefined}
                />
              : <InputGrid
                  label={`Inputs of ${name}@${version}`}
                  count={paged.isPending ? 12 : paged.count}
                  item_at={paged.item_at}
                  loadMore={paged.loadMore}
                  selectable={!!editing}
                  selection={selection}
                  onSelectionChange={setSelection}
                  onOpen={openViewer}
                  removed={removed}
                />}
        </>}

        {editing && <EditBar role="region" aria-label="Editing" className={Classes.DARK}>
          <strong>Editing</strong>
          <span className={Classes.TEXT_MUTED}>
            {selected.length > 0 ? `${plural(selected.length, 'input')} selected` : 'Select inputs to remove them'}
            {removed.size > 0 && ` · ${removed.size.toLocaleString()} to remove`}
          </span>
          {selected.length > 0 && !selected.every(i => removed.has(i.id)) && <Button intent={Intent.DANGER} icon="remove" text={`Remove ${selected.length}`} onClick={removeSelected}/>}
          {selected.some(i => removed.has(i.id)) && <Button icon="undo" text="Keep them" onClick={restoreSelected}/>}
          <AnchorButton icon="add" text="Add inputs" href={inputs_path(project, { add_to: collection.id })} onClick={event => { event.preventDefault(); history.push(inputs_path(project, { add_to: collection.id })); }} title="Pick inputs on the Inputs page: they're added as a new version"/>
          <span style={{ flex: 1 }}/>
          <TextArea
            aria-label="Notes for the new version"
            placeholder="What changed, and why"
            value={editing.notes}
            onChange={e => setEditing({ ...editing, notes: e.target.value })}
            rows={1}
            style={{ minWidth: 220, resize: 'vertical' }}
          />
          <Button text="Cancel" onClick={() => { setEditing(null); setSelection(empty_selection); }}/>
          <Button intent={Intent.PRIMARY} icon="floppy-disk" text={`Save version ${latest + 1}`} loading={saving} disabled={removed.size === 0} onClick={() => save(editing.base_version)} title={removed.size === 0 ? 'Remove inputs first, or add some from the Inputs page' : undefined}/>
        </EditBar>}
      </div>

      <aside className="qa-collection-aside" aria-label="About this collection">
        <section>
          <h2 className={`qa-section-title ${Classes.TEXT_MUTED}`}>Versions</h2>
          <ul className="qa-versions">
            {versions.map(v => <li key={v.version}>
              <Link to={collection_path(project, collection, v.version === latest ? null : v.version)} aria-current={v.version === version ? 'page' : undefined}>
                <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13 }}>
                  <strong className={Classes.MONOSPACE_TEXT}>@{v.version}</strong>
                  <span style={{ whiteSpace: 'nowrap' }}>{plural(v.size, 'input')}</span>
                  {v.version === latest && <span className={Classes.TEXT_MUTED} style={{ marginLeft: 'auto', fontSize: 12 }}>latest</span>}
                </span>
                <span className={Classes.TEXT_MUTED} style={{ display: 'block', fontSize: 12 }} title={full_date(v.created_at)}>{relative(v.created_at)}{creator_name(v) ? ` · ${creator_name(v)}` : ''}</span>
                {!!v.notes && <span style={{ display: 'block', fontSize: 12, marginTop: 2, whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>{v.notes}</span>}
              </Link>
            </li>)}
          </ul>
        </section>
        <section>
          <h2 className={`qa-section-title ${Classes.TEXT_MUTED}`}>Use it</h2>
          <p style={{ margin: 0, fontSize: 13 }}>
            <code>{collection_ref(collection, version)}</code> in batch files and Python: see the tabs.
            Without <code>@{version}</code>, the latest version.
          </p>
        </section>
      </aside>
    </Columns>

    <Alert
      isOpen={!!conflict}
      icon="warning-sign"
      intent={Intent.WARNING}
      cancelButtonText="Reload"
      confirmButtonText={`Save anyway, as @${(conflict?.latest ?? latest) + 1}`}
      onCancel={reload}
      onConfirm={() => conflict?.latest && save(conflict.latest)}
      canEscapeKeyCancel={false}
    >
      <p><strong>Someone saved {conflict?.latest ? `@${conflict.latest}` : 'a new version'}{conflict?.by ? ` (${conflict.by})` : ''} while you were editing.</strong></p>
      <p>Reload to see it and start over, or save anyway: your version is made from @{version}'s inputs, without what changed in @{conflict?.latest ?? 'theirs'}.</p>
    </Alert>

    {viewed_index >= 0 && <InputViewer
      project={project}
      count={paged.count}
      item_at={paged.item_at}
      loadMore={paged.loadMore}
      index={viewed_index}
      onIndexChange={openViewer}
      onClose={() => set({ input: '' }, { replace: true })}
      context={`${name}@${version}`}
    />}
  </Page>;
};

export default CollectionPage;
