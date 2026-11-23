// /<project>/collections: the project's collections, and when there are none yet, what they're for.
import { useState } from "react";
import styled from "styled-components";
import { DateTime } from "luxon";
import { Button, Callout, Card, Classes, Colors, Icon, InputGroup, Intent, NonIdealState, Switch } from "@blueprintjs/core";

import { Link } from "../router";
import { useSelected } from "../selection";
import { errorMessage } from "../api/http";
import { match_query } from "../utils";
import { usePageTitle, join_title, project_name } from "../pageTitle";
import {
  organize_collections, collection_path, collection_ref, inputs_path, pretty_name, creator_name, collection_search_text,
  python_snippet, pin_label,
} from "./api";
import { useCollections } from "./hooks";
import { collection_icon } from "./CollectionsPanel";
import { Page } from "./InputsPage";


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
    <Icon icon="folder-new" size={40} className={Classes.TEXT_MUTED}/>
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
      <pre className={Classes.CODE_BLOCK}>{'hard-cases:\n  inputs:\n    - collection: night/hard-cases@1'}</pre>
      <pre className={Classes.CODE_BLOCK}>{python_snippet('night/hard-cases@1').split('\n').slice(0, 3).join('\n')}</pre>
    </Card>
  </Ways>
  {inherited.length > 0 && <Callout icon="folder-shared" intent={Intent.PRIMARY}>
    <strong>Collections of {inherited[0].project}</strong>, a parent project, are already available here:{' '}
    {inherited.slice(0, 3).map((c, i) => <span key={c.id}>{i > 0 && ', '}<Link to={collection_path(project, c)}><code>{collection_ref(c)}</code></Link></span>)}
    {inherited.length > 3 && ` and ${inherited.length - 3} more`}.
  </Callout>}
</div>;

const relative = date => date ? DateTime.fromISO(date).toRelative() : '';

const Row = ({ project, collection: c }) => <Link to={collection_path(project, c)} className="qa-collection-row">
  {collection_icon(c)}
  <span style={{ minWidth: 0, flex: 1 }}>
    <span className={Classes.MONOSPACE_TEXT} style={{ fontWeight: 600 }}>{pretty_name(c.ref ?? c.name)}</span>
    {c.archived && <span className={Classes.TEXT_MUTED}> · archived</span>}
    {!!c.description && <span className={Classes.TEXT_MUTED} style={{ display: 'block', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.description}</span>}
  </span>
  <span className={Classes.TEXT_MUTED} style={{ fontSize: 12, textAlign: 'right', whiteSpace: 'nowrap' }}>
    @{c.latest_version} · {(c.size ?? 0).toLocaleString()} inputs
    <span style={{ display: 'block' }}>{[(c.pinned_for ?? []).length > 0 && `pinned for ${(c.pinned_for ?? []).map(pin_label).join(', ')}`, creator_name(c), relative(c.updated_at ?? c.created_at)].filter(Boolean).join(' · ')}</span>
  </span>
</Link>;

const List = styled.div`
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 900px;
  h2 {
    margin: 0 0 6px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .qa-collection-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 3px;
    color: inherit;
    text-decoration: none;
  }
  .qa-collection-row:hover, .qa-collection-row:focus-visible {
    background: rgba(143, 153, 168, 0.15);
  }
`;

const CollectionsPage = () => {
  const { project } = useSelected();
  usePageTitle(join_title('Collections', project_name(project)));
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState('');
  const { list, isPending, error, refetch } = useCollections(project, { archived });
  if (error) return <Page><NonIdealState icon="error" title="Could not load the collections" description={errorMessage(error)} action={<Button icon="refresh" text="Retry" onClick={() => refetch()}/>}/></Page>;
  if (isPending) return <Page aria-busy="true"><h1 className={`${Classes.HEADING} ${Classes.SKELETON}`}>Collections</h1><p className={Classes.SKELETON}>Loading the collections</p></Page>;
  const own = list.filter(c => !c.project || c.project === project);
  if (own.length === 0 && !archived) return <Page><EmptyCollections project={project} inherited={list.filter(c => c.project && c.project !== project)}/></Page>;
  const matcher = match_query(search);
  const { pinned, favorites, own: all, ancestors } = organize_collections(list.filter(c => matcher(collection_search_text(c))), project);
  return <Page aria-labelledby="collections-title">
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <h1 id="collections-title" className={Classes.HEADING} style={{ marginRight: 'auto' }}>Collections</h1>
      <Link to={inputs_path(project)}><Button icon="add" intent={Intent.PRIMARY} text="New, from the inputs"/></Link>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <InputGroup type="search" leftIcon="search" placeholder={`Search ${list.length} collections`} aria-label="Search collections" value={search} onChange={e => setSearch(e.target.value)} style={{ minWidth: 280 }}/>
      <Switch checked={archived} onChange={() => setArchived(!archived)} label="Show archived" style={{ margin: 0 }}/>
    </div>
    <List>
      {pinned.length > 0 && <section><h2 className={Classes.TEXT_MUTED}>Pinned</h2>{pinned.map(c => <Row key={c.id} project={project} collection={c}/>)}</section>}
      {favorites.length > 0 && <section><h2 className={Classes.TEXT_MUTED}>Favorites</h2>{favorites.map(c => <Row key={c.id} project={project} collection={c}/>)}</section>}
      {all.length > 0 && <section><h2 className={Classes.TEXT_MUTED}>{project}</h2>{all.map(c => <Row key={c.id} project={project} collection={c}/>)}</section>}
      {ancestors.map(({ project: ancestor, collections }) => <section key={ancestor}><h2 className={Classes.TEXT_MUTED}>From {ancestor}</h2>{collections.map(c => <Row key={c.id} project={project} collection={c}/>)}</section>)}
      {pinned.length + favorites.length + all.length + ancestors.length === 0 && <NonIdealState icon="search" title="No collection matches" description={search ? <>Nothing matches “{search}”</> : undefined}/>}
    </List>
  </Page>;
};

export default CollectionsPage;
