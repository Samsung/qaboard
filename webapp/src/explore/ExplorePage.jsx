// Explore: every project, as a tree of their paths. Groups collapse, quiet projects fade (see ./tree.js).
// <ExploreList/> is the list alone, for other pages; <ExplorePage/> adds the navbar and the footer.
import { useEffect, useMemo, useState } from "react";
import { Link } from "../router";
import { project_url } from "../selection";

import { DateTime } from 'luxon';

import {
  Classes,
  Colors,
  Card,
  AnchorButton,
  Button,
  Icon,
  Tag,
  Tooltip,
  Intent,
  InputGroup,
  NonIdealState,
  NavbarDivider,
  NavbarGroup,
  NavbarHeading,
  Alignment,
} from "@blueprintjs/core";
import { Container } from "../components/layout";
import { ProjectAvatar } from "../components/avatars";
import { LoadMore } from "../components/LoadMore";
import AuthButton from "../components/authentication/Auth"
import { WrappingNavbar } from "../components/PageShell"
import PrivateContent from "../components/authentication/PrivateContent"
import { WhatsNewLink } from '../releaseNotes/ReleaseNotes'
import { ThemeButton } from '../components/ThemeButton'
import { PaletteButton } from '../palette/CommandPalette'
import Footer, { repository_url } from '../components/Footer'
import { useProjects, useSiteConfig, useUser } from '../hooks'
import { usePrefsStore } from '../stores/prefs'
import { errorMessage } from "../api/http"
import { project_web_url } from "../utils"
import { build_tree, filter_projects, count_projects, is_listed, quiet_tooltip } from "./tree"
import { Sparkline } from "./Sparkline"


const activity_words = { human: 'last used', run: 'last run', commit: 'last commit' };
const activity_titles = {
  human: 'The latest batch started from the web app or a terminal',
  run: 'The latest run (only the CI ran it lately)',
  commit: 'No runs yet: the latest commit',
};

export const LastActivity = ({ activity, className }) => {
  if (!activity?.date) return null;
  const date = DateTime.fromISO(activity.date, { zone: 'utc' });
  return <span className={`${Classes.TEXT_MUTED} ${className ?? ''}`} title={`${activity_titles[activity.kind]}: ${date.toLocal().toLocaleString(DateTime.DATETIME_MED)}`}>
    {activity_words[activity.kind]} {DateTime.now().diff(date, 'minutes').minutes < 1 ? 'just now' : date.toRelative()}
  </span>;
};

export const QuietTag = () => <Tooltip content={quiet_tooltip} placement="top">
  <Tag minimal round icon="moon" style={{ cursor: 'help' }} tabIndex={0} aria-label={`Quiet: ${quiet_tooltip}`}>quiet</Tag>
</Tooltip>;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// As tall as their skeletons. They wrap at phone width.
const card_style = { margin: '0 0 10px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px', minHeight: 84, padding: '12px 16px' };
// what's below a node, slightly indented, with a line on its left
const children_style = { margin: '-4px 0 10px 18px', paddingLeft: 12, borderLeft: '2px solid var(--qa-border)' };

const PinButton = ({ project_id }) => {
  const is_favorite = usePrefsStore(state => !!state.favorites[project_id]);
  const toggleFavorite = usePrefsStore(state => state.toggleFavorite);
  return <Button
    variant="minimal"
    aria-label={is_favorite ? "Unpin" : "Pin"}
    title={is_favorite ? "Pinned on top of the list (only for you). Click to unpin." : "Pin on top of the list (only for you)"}
    icon={<Icon icon={is_favorite ? "star" : "star-empty"} style={{color: Colors.GOLD5}}/>}
    onClick={() => toggleFavorite(project_id)}
  />;
};

// A project, or a group of projects (`node.project` is null). `flat`: in filtered lists, with its full path
const NodeCard = ({ node, expanded, onToggle, flat = false }) => {
  const project = node.project;
  const data = project?.data || {};
  // from qaboard.yaml, else from GitHub/GitLab
  const description = data.qatools_config?.project?.description || data.git?.description;
  const web_url = project ? project_web_url(project) : null;
  const nb_below = node.nb_projects;
  const has_below = node.children.length + node.quiet_children.length > 0;
  const href = project ? project_url(node.id) : undefined;
  const sparkline_label = nb_below ? "Batches with runs per day, last 30 days, with what's below" : undefined;

  return (
    <Card style={card_style} data-testid="explore-node">
      <div style={{flex: '0 0 auto'}}>
        {project
          ? <ProjectAvatar project={node.id} data={data} href={href} size="40px"/>
          : <span style={{display: 'inline-flex', width: 40, height: 40, alignItems: 'center', justifyContent: 'center'}}><Icon icon={expanded ? "folder-open" : "folder-close"} size={24} className={Classes.TEXT_MUTED}/></span>}
      </div>
      <div style={{flex: '1 1 200px', minWidth: 0}}>
        <h5 className={Classes.HEADING} style={{margin: 0, overflowWrap: 'anywhere'}} title={node.id}>
          {project ? <Link to={href}>{node.name}</Link> : node.name}
        </h5>
        {!flat && node.name !== node.id && <div className={`${Classes.TEXT_MUTED} ${Classes.TEXT_SMALL}`} style={{overflowWrap: 'anywhere'}}>{node.id}</div>}
        {description && <p style={{margin: '4px 0 0'}} className={Classes.TEXT_MUTED}>{description}</p>}
      </div>
      <div style={{flex: '0 1 auto', marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: '4px 12px'}}>
        {flat && node.quiet && <QuietTag/>}
        <LastActivity activity={node.last_activity}/>
        <Sparkline activity={node.activity} label={sparkline_label}/>
        {has_below && <Button
          variant="minimal"
          size="small"
          icon={expanded ? "chevron-down" : "chevron-right"}
          text={plural(nb_below, project ? 'subproject' : 'project')}
          aria-expanded={expanded}
          onClick={onToggle}
        />}
        {project && <PinButton project_id={node.id}/>}
        {web_url && <AnchorButton href={web_url} icon="git-repo" variant="minimal" aria-label="Source" className={Classes.TEXT_MUTED} title="The project's repository on your git host"/>}
      </div>
    </Card>
  );
};

// We render projects progressively: sites have hundreds
const page_size = 50;

const PagedNodes = ({ nodes, render }) => {
  const [nb_shown, setNbShown] = useState(page_size);
  return <>
    {nodes.slice(0, nb_shown).map(render)}
    {nb_shown < nodes.length && <LoadMore
      onLoadMore={() => setNbShown(nb => nb + page_size)}
      loaded={nb_shown}
      text={`Show more (${nodes.length - nb_shown})`}
    />}
  </>;
};

// Groups are open, projects show their subprojects on demand. Users' choices are remembered.
const TreeNode = ({ node }) => {
  const stored = usePrefsStore(state => state.exploreGroups[node.id]);
  const setExploreGroup = usePrefsStore(state => state.setExploreGroup);
  const default_expanded = !node.project;
  const expanded = stored ?? default_expanded;
  const has_below = node.children.length + node.quiet_children.length > 0;
  return <>
    <NodeCard node={node} expanded={expanded} onToggle={() => setExploreGroup(node.id, !expanded, default_expanded)}/>
    {expanded && has_below && <div style={children_style}>
      {/* users already asked to see the quiet ones */}
      {node.quiet
        ? <NodeList nodes={node.quiet_children} quiet_nodes={[]} word="subproject"/>
        : <NodeList nodes={node.children} quiet_nodes={node.quiet_children} word="subproject"/>}
    </div>}
  </>;
};

const NodeList = ({ nodes, quiet_nodes, word }) => {
  const [show_quiet, setShowQuiet] = useState(false);
  const nb_quiet = count_projects(quiet_nodes);
  return <>
    <PagedNodes nodes={nodes} render={node => <TreeNode key={node.id} node={node}/>}/>
    {quiet_nodes.length > 0 && <div style={{margin: '0 0 10px'}}>
      <Tooltip content={quiet_tooltip} placement="right" openOnTargetFocus={false}>
        <Button
          variant="minimal"
          icon={show_quiet ? "chevron-down" : "moon"}
          text={`${plural(nb_quiet, `quiet ${word}`)}`}
          aria-expanded={show_quiet}
          className={Classes.TEXT_MUTED}
          onClick={() => setShowQuiet(shown => !shown)}
        />
      </Tooltip>
      {show_quiet && <div style={{...children_style, marginTop: 6, opacity: 0.85}}>
        <PagedNodes nodes={quiet_nodes} render={node => <TreeNode key={node.id} node={node}/>}/>
      </div>}
    </div>}
  </>;
};


const EmptyProjects = ({ docs_root, support_url }) => <div style={{marginTop: '10vh'}}>
  <NonIdealState
    icon="heatmap"
    title="No projects yet"
    description={<p>
      Projects appear here after their first <code>qa run</code> or <code>qa batch</code>.<br/>
      Learn how to <a href={`${docs_root}docs/installation`}>get started</a>{support_url && <>, and <a href={support_url}>ask the maintainers</a> if you run into issues</>}.
    </p>}
  />
</div>;

const NoMatchingProjects = ({ query, onClear }) => <div style={{marginTop: '10vh'}}>
  <NonIdealState
    icon="search"
    title="No matching projects"
    description={<p>No project name matches <strong>{query}</strong>.</p>}
    action={<Button icon="cross" text="Clear the filter" onClick={onClear}/>}
  />
</div>;

// Placeholder cards while the projects load, the page doesn't jump when they arrive
const ProjectCardSkeleton = () => <Card style={card_style}>
  <div className={Classes.SKELETON} style={{width: 40, height: 40, borderRadius: '50%', flex: 'none'}}/>
  <div style={{flex: 1}}>
    <h5 className={`${Classes.HEADING} ${Classes.SKELETON}`} style={{width: '30%'}}>project</h5>
    <p className={Classes.SKELETON} style={{width: '60%', marginBottom: 0}}>description</p>
  </div>
  <div className={Classes.SKELETON} style={{width: 160, height: 24}}/>
</Card>;


export const ExploreList = () => {
  const { data: projects = {}, error, isPending, refetch } = useProjects();
  const { docs_root, support_url } = useSiteConfig();
  const favorites = usePrefsStore(state => state.favorites);
  const [query, setQuery] = useState('');
  // the same "now" while the page is open: what's quiet doesn't change under users' eyes
  const [now] = useState(() => Date.now());

  const listed = useMemo(() => Object.fromEntries(Object.entries(projects).filter(([, details]) => is_listed(details))), [projects]);
  const tree = useMemo(() => build_tree(listed, { favorites, now }), [listed, favorites, now]);
  const matches = useMemo(() => query ? filter_projects(listed, query, { favorites, now }) : [], [listed, query, favorites, now]);
  const nb_projects = Object.keys(listed).length;

  // When a refresh fails, we keep showing the projects we have
  const failed = !!error && Object.keys(projects).length === 0;
  let warnings;
  if (failed)
    warnings = <NonIdealState
      icon="error"
      title="Could not load the projects"
      description={errorMessage(error)}
      action={<Button icon="refresh" text="Retry" onClick={() => refetch()}/>}
    />;
  if (isPending)
    warnings = <div aria-busy="true" aria-label="Loading projects">{[0, 1, 2, 3, 4].map(i => <ProjectCardSkeleton key={i}/>)}</div>;

  let content = null;
  if (!isPending && !failed) {
    if (nb_projects === 0)
      content = <EmptyProjects docs_root={docs_root} support_url={support_url}/>;
    else if (query)
      content = matches.length === 0
        ? <NoMatchingProjects query={query} onClear={() => setQuery('')}/>
        // a new list for each filter: it starts at its first page
        : <div key={query}><PagedNodes nodes={matches} render={node => <NodeCard key={node.id} node={node} flat/>}/></div>;
    else
      content = <NodeList nodes={tree.nodes} quiet_nodes={tree.quiet_nodes} word="project"/>;
  }

  const nb_shown = query ? matches.length : nb_projects;
  return <>
    <div style={{display: "flex", flexWrap: 'wrap', gap: '0 10px', justifyContent: "space-between", alignItems: "baseline", marginTop: '30px', marginBottom: '10px'}}>
      <div style={{width: '300px', maxWidth: '100%'}}>
        <InputGroup
          intent={query ? Intent.PRIMARY : undefined}
          value={query}
          leftIcon="search"
          placeholder="Filter projects..."
          aria-label="Filter projects"
          rightElement={query ? <Button variant="minimal" icon="cross" aria-label="Clear the filter" onClick={() => setQuery('')}/> : undefined}
          onChange={e => setQuery(e.target.value)}
        />
      </div>
      {!isPending && !failed && <Tag intent={query ? Intent.PRIMARY : undefined} minimal>{nb_shown} {query ? 'filtered ' : ''}project{nb_shown === 1 ? '' : 's'}</Tag>}
    </div>
    {warnings}
    {content}
  </>;
};


// Not in a fragment: Blueprint gives icons a className
const github_cat = <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="#fff">
    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
  </svg>

// The bar of the pages about every project: Explore, and the home page
export const SiteNavbar = ({ via = "projects-list" }) => {
  const user = useUser();
  const { docs_root } = useSiteConfig();
  return <WrappingNavbar className={Classes.DARK}>
      <NavbarGroup align={Alignment.LEFT}>
          <NavbarHeading><Link to="/" style={{color: '#fff'}}><b>QA-Board</b></Link></NavbarHeading>
          <NavbarDivider />
          {user.is_logged && <Link to="/projects"><Button className={Classes.MINIMAL} icon={<Icon icon="projects" color="#fff"/>} text="Explore" style={{color : "#fff"}} title="Every project"/></Link>}
          <a href={repository_url}><Button className={Classes.MINIMAL} icon={github_cat} text="GitHub" style={{color : "#fff"}}/></a>
          <a href={`${docs_root}docs/user-guide/overview`}><Button className={Classes.MINIMAL} icon={<Icon icon="help" color="#fff"/>} text="User guide" style={{color : "#fff"}}/></a>
          <WhatsNewLink via={via}><Button className={Classes.MINIMAL} icon={<Icon icon="clean" color="#fff"/>} text="What's new" style={{color : "#fff"}}/></WhatsNewLink>
      </NavbarGroup>
      <NavbarGroup align={Alignment.RIGHT}>
        <PaletteButton dark/>
        <ThemeButton style={{margin: '0 10px 0 6px'}}/>
        {user.is_logged && <Link to="/storage" style={{paddingRight: '15px'}}>
          <Button icon="database" text="Storage usage" style={{color : "#fff"}} title="How much storage your runs use, and deleting what you don't need"/>
        </Link>}
        <AuthButton/>
      </NavbarGroup>
  </WrappingNavbar>;
};

const ExplorePage = () => {
  useEffect(() => {
    document.title = 'Explore - QA-Board';
  }, []);
  return (
    <div style={{minHeight: '100vh', display: 'flex', flexDirection: 'column'}}>
      <SiteNavbar/>
      <Container>
        <PrivateContent>
          <ExploreList/>
        </PrivateContent>
      </Container>
      <Footer/>
    </div>
  );
}

export default ExplorePage;
