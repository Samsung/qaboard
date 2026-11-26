// /<project>/collections, "Collections" in the sidebar, next to "Inputs": the collections the project can use (its own and
// its parent projects'), to search and open. Pinned and favorites first, then by group ("night/hard" is in "night"),
// like milestones. Collections are made from inputs: "New collection" says how, and links to the Inputs page.
// When the project has none yet: what they're for.
import { useState } from "react";
import styled from "styled-components";
import { DateTime } from "luxon";
import { Button, Callout, Card, Classes, Colors, Icon, InputGroup, Intent, NonIdealState, Switch, Tag } from "@blueprintjs/core";

import { Link } from "../router";
import { CodeBlock } from "../components/CodeBlock";
import { useSelected } from "../selection";
import { useUser } from "../hooks";
import { errorMessage } from "../api/http";
import { match_query } from "../utils";
import { usePageTitle, join_title, project_name } from "../pageTitle";
import { usePrefsStore } from "../stores/prefs";
import {
  organize_collections, collections_tree, collection_path, collection_ref, inputs_path, pretty_name, short_name,
  creator_name, collection_search_text, python_snippet, yaml_snippet, pin_label, is_pinned,
} from "./api";
import { useCollections, useCollectionActions } from "./hooks";
import { collection_icon } from "./CollectionsPanel";
import { collections_icon } from "./icons";
import { Page, who_can_create } from "./InputsPage";


const Ways = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
  gap: 14px;
  .${Classes.CARD} {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  h2 {
    margin: 0;
    font-size: 15px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  pre {
    margin: 0;
    overflow-x: auto;
  }
`;

const Step = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 11px;
  background: ${props => props.$primary ? Colors.BLUE3 : Colors.GRAY3};
  color: ${Colors.WHITE};
  font-size: 12px;
  font-weight: 600;
`;

// No collections yet: what they are for, and how to make one
export const EmptyCollections = ({ project, inherited = [] }) => <div style={{ maxWidth: 980, width: '100%', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
  <div style={{ textAlign: 'center', padding: '24px 0 4px' }}>
    <Icon icon={collections_icon} size={40} className={Classes.TEXT_MUTED}/>
    <h1 className={Classes.HEADING} style={{ margin: '12px 0 8px' }}>No collections in {project} yet</h1>
    <p className={Classes.TEXT_MUTED} style={{ maxWidth: 640, margin: '0 auto' }}>
      A collection is a named, versioned set of inputs. Save one once, then every batch, script and teammate uses exactly
      the same inputs. Changing it makes a new version: older ones never change.
    </p>
  </div>
  <Ways>
    <Card>
      <h2><Step $primary>1</Step>In the web app</h2>
      <p className={Classes.TEXT_MUTED} style={{ margin: 0 }}>Search or pick a folder on the Inputs page, select inputs, then <strong>Save as collection</strong>.</p>
      <div style={{ marginTop: 'auto' }}><Link to={inputs_path(project)}><Button intent={Intent.PRIMARY} icon="media" text="Browse inputs"/></Link></div>
    </Card>
    <Card>
      <h2><Step>2</Step>Then use it</h2>
      <p className={Classes.TEXT_MUTED} style={{ margin: 0 }}>In a batch file, or from Python:</p>
      <CodeBlock language="yaml" code={yaml_snippet('night/hard-cases@1', 'night/hard-cases')}/>
      <CodeBlock language="python" code={python_snippet('night/hard-cases@1')}/>
    </Card>
  </Ways>
  {inherited.length > 0 && <Callout icon="folder-shared" intent={Intent.PRIMARY}>
    <strong>Collections of {inherited[0].project}</strong>, a parent project, are already available here:{' '}
    {inherited.slice(0, 3).map((c, i) => <span key={c.id}>{i > 0 && ', '}<Link to={collection_path(project, c)}><code>{collection_ref(c)}</code></Link></span>)}
    {inherited.length > 3 && ` and ${inherited.length - 3} more`}.
  </Callout>}
</div>;

const relative = date => date ? DateTime.fromISO(date).toRelative() : '';
// who saved the latest version, else who created it
const updater_name = c => c?.updated_by?.full_name || c?.updated_by?.user_name || creator_name(c);
const is_inherited = (c, project) => c.inherited ?? (!!c.project && c.project !== project);

const Row = ({ project, collection: c, full_name, depth = 0, is_logged, toggleFavorite }) => {
  const inherited = is_inherited(c, project);
  const updated = [updater_name(c) && `by ${updater_name(c)}`, relative(c.updated_at ?? c.created_at)].filter(Boolean).join(' ');
  return <li className="qa-collection-row" style={{ paddingLeft: 10 + 22 * depth }}>
    {collection_icon(c)}
    <span style={{ minWidth: 0, flex: 1 }}>
      <Link to={collection_path(project, c)} className="qa-collection-link" title={c.ref ?? c.name}>
        {full_name ? pretty_name(c.ref ?? c.name) : short_name(c.name)}
      </Link>
      {inherited && <Tag minimal round icon="folder-shared" style={{ marginLeft: 8 }} title={`A collection of ${c.project}, a parent project: this project can use it`}>from {c.project}</Tag>}
      {c.archived && <Tag minimal round style={{ marginLeft: 8 }}>archived</Tag>}
      {c.shared === false && <Tag minimal round icon="person" style={{ marginLeft: 8 }} title="Only you see it">personal</Tag>}
      {!!c.description && <span className={`qa-description ${Classes.TEXT_MUTED}`}>{c.description}</span>}
    </span>
    <span className={`qa-meta ${Classes.TEXT_MUTED}`}>
      <span><span title="The latest version">@{c.latest_version}</span> · {(c.size ?? 0).toLocaleString()} input{c.size === 1 ? '' : 's'}</span>
      <span style={{ display: 'block' }}>{[is_pinned(c) && `pinned for ${(c.pinned_for ?? []).map(pin_label).join(', ') || 'your team'}`, updated && `updated ${updated}`].filter(Boolean).join(' · ')}</span>
    </span>
    {is_logged && <Button
      variant="minimal"
      size="small"
      icon={<Icon icon="heart" color={c.favorite ? Colors.RED4 : undefined}/>}
      aria-label={c.favorite ? `Remove ${pretty_name(c.name)} from favorites` : `Add ${pretty_name(c.name)} to favorites`}
      aria-pressed={!!c.favorite}
      className={c.favorite ? 'qa-is-favorite' : 'qa-favorite'}
      onClick={() => toggleFavorite(c).catch(() => {})}
    />}
  </li>;
};

// A group of collections by name prefix ("night" for "night/hard"), folded like the milestones' groups (remembered)
const Group = ({ node, depth, expand, ...props }) => {
  const collapsed = usePrefsStore(state => state.milestoneGroupsCollapsed);
  const toggle = usePrefsStore(state => state.toggleMilestoneGroup);
  const is_open = expand || !collapsed[node.path];
  return <li>
    <button type="button" className="qa-group" style={{ paddingLeft: 10 + 22 * depth }} aria-expanded={is_open} onClick={() => toggle(node.path)}>
      <Icon icon={is_open ? 'chevron-down' : 'chevron-right'} size={12}/>
      <Icon icon={is_open ? 'folder-open' : 'folder-close'} className={Classes.TEXT_MUTED}/>
      <span style={{ fontWeight: 600 }}>{node.name}</span>
      <span className={Classes.TEXT_MUTED}>{node.count}</span>
    </button>
    {is_open && <ul aria-label={node.name}><Tree node={node} depth={depth + 1} expand={expand} {...props}/></ul>}
  </li>;
};

const Tree = ({ node, depth = 0, expand, ...props }) => <>
  {node.groups.map(group => <Group key={group.path} node={group} depth={depth} expand={expand} {...props}/>)}
  {node.collections.map(c => <Row key={c.id} collection={c} depth={depth} {...props}/>)}
</>;

const Section = ({ title, count, children }) => <section aria-label={typeof title === 'string' ? title : undefined}>
  <h2 className={Classes.TEXT_MUTED}>{title}{count > 1 && <span style={{ fontWeight: 400, marginLeft: 6 }}>{count}</span>}</h2>
  <ul>{children}</ul>
</section>;

const List = styled.div`
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 980px;
  h2 {
    margin: 0 0 6px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .qa-collection-row, .qa-group {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border-radius: 3px;
  }
  .qa-collection-row:hover, .qa-collection-row:focus-within, .qa-group:hover, .qa-group:focus-visible {
    background: rgba(143, 153, 168, 0.15);
  }
  .qa-group {
    width: 100%;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .qa-collection-link {
    font-weight: 600;
    color: inherit;
  }
  .qa-description {
    display: block;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .qa-meta {
    font-size: 12px;
    text-align: right;
    white-space: nowrap;
  }
  .qa-favorite {
    opacity: 0;
  }
  .qa-collection-row:hover .qa-favorite, .qa-favorite:focus-visible {
    opacity: 1;
  }
`;

// Collections are made from inputs: how, with a link to the Inputs page
const NewCollection = ({ project, can_create, onClose }) => <Callout intent={Intent.PRIMARY} icon="info-sign" title="New collection" role="region" aria-label="New collection">
  <p>
    A collection is made from inputs: on the <strong>Inputs</strong> page, search or pick a folder, select inputs, then <strong>Save as collection</strong>.
    {' '}To change one, open it and add or remove inputs: that saves a new version.
  </p>
  {can_create === false && <p>{who_can_create}</p>}
  <div style={{ display: 'flex', gap: 8 }}>
    <Link to={inputs_path(project)}><Button intent={Intent.PRIMARY} icon="media" text="Select inputs"/></Link>
    <Button variant="minimal" text="Close" onClick={onClose}/>
  </div>
</Callout>;

const CollectionsPage = () => {
  const { project } = useSelected();
  const user = useUser();
  usePageTitle(join_title('Collections', project_name(project)));
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState('');
  const [explain_new, setExplainNew] = useState(false);
  const { list, isPending, error, refetch, can_create, archived_count } = useCollections(project, { archived });
  const { toggleFavorite } = useCollectionActions(project);
  if (error) return <Page><NonIdealState icon="error" title="Could not load the collections" description={errorMessage(error)} action={<Button icon="refresh" text="Retry" onClick={() => refetch()}/>}/></Page>;
  if (isPending) return <Page aria-busy="true"><h1 className={`${Classes.HEADING} ${Classes.SKELETON}`}>Collections</h1><p className={Classes.SKELETON}>Loading the collections</p></Page>;
  const own = list.filter(c => !is_inherited(c, project));
  if (own.length === 0 && !archived) return <Page><EmptyCollections project={project} inherited={list.filter(c => is_inherited(c, project))}/></Page>;
  const matcher = match_query(search);
  const is_searching = search.trim().length > 0;
  const { pinned, favorites, own: all, ancestors } = organize_collections(list.filter(c => matcher(collection_search_text(c))), project);
  const props = { project, is_logged: !!user?.is_logged, toggleFavorite };
  return <Page aria-labelledby="collections-title">
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
      <div style={{ marginRight: 'auto', maxWidth: 720 }}>
        <h1 id="collections-title" className={Classes.HEADING} style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Icon icon={collections_icon} size={20}/>Collections</h1>
        <p className={`qa-lede ${Classes.TEXT_MUTED}`} style={{ margin: '6px 0 0' }}>
          Named, versioned sets of inputs that batches and scripts run on: those of {project} and of its parent projects.
          {' '}The inputs themselves are on the <Link to={inputs_path(project)}>Inputs</Link> page.
        </p>
      </div>
      <Button icon="add" intent={Intent.PRIMARY} text="New collection" aria-expanded={explain_new} onClick={() => setExplainNew(!explain_new)}/>
    </div>
    {explain_new && <NewCollection project={project} can_create={can_create} onClose={() => setExplainNew(false)}/>}
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <InputGroup type="search" leftIcon="search" placeholder={`Search ${list.length} collections`} aria-label="Search collections" value={search} onChange={e => setSearch(e.target.value)} style={{ minWidth: 280 }}/>
      {(archived || archived_count === null || archived_count > 0) && <Switch role="switch" aria-checked={archived} checked={archived} onChange={() => setArchived(!archived)} label={archived_count ? `Show the ${archived_count} archived` : 'Show archived'} style={{ margin: 0 }}/>}
    </div>
    <List>
      {pinned.length > 0 && <Section title="Pinned" count={pinned.length}>{pinned.map(c => <Row key={c.id} collection={c} full_name {...props}/>)}</Section>}
      {favorites.length > 0 && <Section title="Favorites" count={favorites.length}>{favorites.map(c => <Row key={c.id} collection={c} full_name {...props}/>)}</Section>}
      {all.length > 0 && <Section title={pinned.length + favorites.length > 0 ? `All of ${project}` : project} count={all.length}>
        <Tree node={collections_tree(all, `collections/${project}`)} expand={is_searching} {...props}/>
      </Section>}
      {ancestors.map(({ project: ancestor, collections }) => <Section key={ancestor} title={`From ${ancestor}`} count={collections.length}>
        <Tree node={collections_tree(collections, `collections/${ancestor}`)} expand={is_searching} {...props}/>
      </Section>)}
      {pinned.length + favorites.length + all.length + ancestors.length === 0 && <NonIdealState icon="search" title="No collection matches" description={search ? <>Nothing matches “{search}”</> : undefined}/>}
    </List>
  </Page>;
};

export default CollectionsPage;
