// The list of a project's collections, to open one quickly from the Inputs page (the Collections page lists them all).
// Pinned for the user's groups or everyone first, then their favorites, then all of them by group ("night/hard" is
// in "night"), then those of the ancestor projects, which the project can use too.
import { useState } from "react";
import styled from "styled-components";
import { Button, Classes, Colors, Icon, InputGroup, Menu, MenuDivider, MenuItem, Tooltip } from "@blueprintjs/core";

import { useUser } from "../hooks";
import { usePrefsStore } from "../stores/prefs";
import { match_query } from "../utils";
import { useLinkClickHandler } from "../router";
import {
  organize_collections, collections_tree, collection_search_text, collection_path, pretty_name, short_name, pin_label,
  inputs_path, creator_name, is_pinned, collections_index_path,
} from "./api";
import { collections_icon } from "./icons";
import { useCollections, useCollectionActions } from "./hooks";


const Panel = styled(Menu)`
  width: 380px;
  max-width: calc(100vw - 32px);
  max-height: min(560px, 75vh);
  overflow-y: auto;
  padding-top: 0;

  .qa-collections-search {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 6px 0;
    background: inherit;
  }
  .qa-collection-name {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .qa-collection-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .qa-collection-actions .${Classes.BUTTON}:not(.qa-is-favorite) {
    opacity: 0;
  }
  .${Classes.MENU_ITEM}:hover .qa-collection-actions .${Classes.BUTTON},
  .${Classes.MENU_ITEM}:focus-visible .qa-collection-actions .${Classes.BUTTON},
  .qa-collection-actions .${Classes.BUTTON}:focus-visible {
    opacity: 1;
  }
`;

const SectionTitle = ({ title, count }) => <li className={Classes.MENU_HEADER}>
  <h6 className={Classes.HEADING} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
    {title}
    {count > 2 && <span className={Classes.TEXT_MUTED} style={{ fontWeight: 400 }}>{count}</span>}
  </h6>
</li>;

const stop = action => event => {
  event.preventDefault();
  event.stopPropagation();
  action();
};

export const collection_icon = c => is_pinned(c)
  ? <Icon icon="pin" color={Colors.BLUE4} title={`Pinned for ${(c.pinned_for ?? []).map(pin_label).join(', ')}`}/>
  : c.favorite ? <Icon icon="heart" color={Colors.RED4} title="Your favorite"/>
  : <Icon icon="folder-close" className={Classes.TEXT_MUTED}/>;

const CollectionItem = ({ collection: c, project, full_name, depth = 0, is_logged, toggleFavorite, current, onPick }) => {
  const to = collection_path(project, c);
  const navigate = useLinkClickHandler(to);
  return <MenuItem
    href={to}
    onClick={event => { navigate(event); onPick?.(c); }}
    active={current === c.id}
    aria-current={current === c.id ? 'page' : undefined}
    style={{ paddingLeft: 7 + 16 * depth }}
    icon={collection_icon(c)}
    title={[c.ref ?? c.name, c.description, creator_name(c) && `by ${creator_name(c)}`].filter(Boolean).join('\n')}
    text={<span className="qa-collection-name">{full_name ? pretty_name(c.ref ?? c.name) : short_name(c.name)}</span>}
    labelElement={<span className="qa-collection-actions">
      {c.archived && <span className={Classes.TEXT_MUTED}>archived</span>}
      <span className={Classes.TEXT_MUTED} title={`Version ${c.latest_version}, ${c.size ?? '?'} inputs`}>@{c.latest_version}</span>
      {is_logged && <Button
        variant="minimal"
        size="small"
        className={c.favorite ? 'qa-is-favorite' : undefined}
        icon={<Icon icon="heart" color={c.favorite ? Colors.RED4 : undefined}/>}
        aria-label={c.favorite ? `Remove ${pretty_name(c.name)} from favorites` : `Add ${pretty_name(c.name)} to favorites`}
        aria-pressed={!!c.favorite}
        onClick={stop(() => toggleFavorite(c).catch(() => {}))}
      />}
    </span>}
  />;
};

const GroupItem = ({ node, depth, expand, ...props }) => {
  const collapsed = usePrefsStore(state => state.milestoneGroupsCollapsed);
  const toggle = usePrefsStore(state => state.toggleMilestoneGroup);
  const is_open = expand || !collapsed[node.path];
  return <>
    <MenuItem
      shouldDismissPopover={false}
      icon={<Icon icon={is_open ? 'folder-open' : 'folder-close'} className={Classes.TEXT_MUTED}/>}
      text={<span style={{ fontWeight: 500 }}>{node.name}</span>}
      labelElement={<span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className={Classes.TEXT_MUTED}>{node.count}</span>
        <Icon icon={is_open ? 'chevron-down' : 'chevron-right'} size={12}/>
      </span>}
      onClick={() => toggle(node.path)}
      aria-expanded={is_open}
      style={{ paddingLeft: 7 + 16 * depth }}
    />
    {is_open && <Tree node={node} depth={depth + 1} expand={expand} {...props}/>}
  </>;
};

const Tree = ({ node, depth = 0, expand, ...props }) => <>
  {node.groups.map(group => <GroupItem key={group.path} node={group} depth={depth} expand={expand} {...props}/>)}
  {node.collections.map(c => <CollectionItem key={c.id} collection={c} depth={depth} {...props}/>)}
</>;


// `current`: the id of the collection shown. `onPick`: told when one is opened (e.g. to close a popover).
// `on_inputs_page`: opened from the Inputs page, which needs no link to itself.
export const CollectionsPanel = ({ project, current, onPick, docs_root = '/', on_inputs_page = false }) => {
  const user = useUser();
  const [search, setSearch] = useState('');
  const { list, isPending, error, archived_count } = useCollections(project);
  const { toggleFavorite } = useCollectionActions(project);
  const browse = inputs_path(project);
  const browseClick = useLinkClickHandler(browse);
  const index = collections_index_path(project);
  const indexClick = useLinkClickHandler(index);
  const matcher = match_query(search);
  const is_searching = search.trim().length > 0;
  const matching = list.filter(c => matcher(collection_search_text(c)));
  const { pinned, favorites, own, ancestors } = organize_collections(matching, project);
  const props = { project, is_logged: user.is_logged, toggleFavorite, current, onPick };

  return <Panel aria-label="Collections">
    {list.length > 4 && <div className="qa-collections-search">
      <InputGroup
        placeholder={`Search ${list.length} collections`}
        leftIcon="search"
        value={search}
        onChange={e => setSearch(e.target.value)}
        aria-label="Search collections"
        autoFocus
        rightElement={search ? <Button variant="minimal" icon="cross" aria-label="Clear the search" onClick={() => setSearch('')}/> : undefined}
      />
    </div>}
    {!!error && <MenuItem disabled icon="error" multiline text={`Could not load the collections: ${error.message}`}/>}
    {isPending && !error && <MenuItem disabled text={<span className={Classes.SKELETON}>Loading the collections</span>}/>}

    {pinned.length > 0 && <>
      <SectionTitle title="Pinned" count={pinned.length}/>
      {pinned.map(c => <CollectionItem key={`p-${c.id}`} collection={c} full_name {...props}/>)}
    </>}
    {favorites.length > 0 && <>
      <SectionTitle title="Favorites" count={favorites.length}/>
      {favorites.map(c => <CollectionItem key={`f-${c.id}`} collection={c} full_name {...props}/>)}
    </>}
    {own.length > 0 && <>
      <SectionTitle title={pinned.length + favorites.length > 0 ? 'All' : project.split('/').at(-1)} count={own.length}/>
      <Tree node={collections_tree(own, `collections/${project}`)} expand={is_searching} {...props}/>
    </>}
    {ancestors.map(({ project: ancestor, collections }) => <div key={ancestor} role="presentation">
      <SectionTitle title={<Tooltip content="Collections of a parent project: this project can use them" placement="top"><span>From {ancestor}</span></Tooltip>} count={collections.length}/>
      <Tree node={collections_tree(collections, `collections/${ancestor}`)} expand={is_searching} {...props}/>
    </div>)}

    {!isPending && !error && list.length === 0 && <MenuItem disabled multiline icon="info-sign" text={<span className={Classes.TEXT_MUTED}>
      {archived_count
        ? <>No collections in use: {archived_count} archived, on the Collections page.</>
        : <>No collections yet. A collection is a named, versioned set of inputs that batches and scripts run on. {on_inputs_page ? 'Select inputs on this page' : 'Select inputs on the Inputs page'}, then <strong>Save as collection</strong>.</>}
    </span>}/>}
    {is_searching && matching.length === 0 && list.length > 0 && <MenuItem disabled icon="search" text={<>No collection matches “{search}”</>}/>}

    <MenuDivider/>
    {(list.length > 0 || archived_count > 0) && <MenuItem icon={collections_icon} text="All the collections" label={archived_count ? `${archived_count} archived` : undefined} href={index} onClick={event => { indexClick(event); onPick?.(null); }}/>}
    {!on_inputs_page && <MenuItem icon="media" text="Browse the inputs" href={browse} onClick={event => { browseClick(event); onPick?.(null); }}/>}
    {/* the archived ones are on the Collections page ("Show archived"), not here */}
    <MenuItem icon="manual" text="Learn about collections" href={`${docs_root}docs/user-guide/inputs-and-collections`} target="_blank" rel="noopener noreferrer"/>
  </Panel>;
};
