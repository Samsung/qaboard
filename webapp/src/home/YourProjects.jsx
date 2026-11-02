// The home page's left column: the projects users work on, then a link to all of them
import { useMemo, useState } from "react";
import { Button, Classes, Colors, Icon } from "@blueprintjs/core";
import styled from "styled-components";

import { Link } from "../router";
import { path_segment } from "../selection";
import { useProjects } from "../hooks";
import { usePrefsStore } from "../stores/prefs";
import { ProjectAvatar } from "../components/avatars";
import { LastActivity } from "../explore/ExplorePage";
import { Sparkline } from "../explore/Sparkline";
import { my_projects, my_projects_days } from "./logic";
import { Empty, LoadError, Section } from "./parts";


const shown_first = 8;

const Item = styled.li`
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  gap: 0 10px;
  align-items: center;
  padding: 7px 0;
  border-bottom: 1px solid var(--qa-border);
  &:last-child { border-bottom: none; }
  .qa-home-project { font-weight: 600; overflow-wrap: anywhere; }
`;

const ProjectItem = ({ project }) => {
  const { id, details, pinned, last_activity } = project;
  const href = `/${path_segment(id)}`;
  // subprojects: their name, under their parent's path
  const slash = id.lastIndexOf('/');
  return <Item>
    {/* one link per project: the name */}
    <ProjectAvatar project={id} data={details.data} size="28px"/>
    <div style={{ minWidth: 0 }}>
      <Link to={href} className="qa-home-project" title={id}>
        {slash > 0 && <span className={Classes.TEXT_MUTED} style={{ fontWeight: 400 }}>{id.slice(0, slash + 1)}</span>}{id.slice(slash + 1)}
      </Link>
      {pinned && <Icon icon="star" size={12} style={{ color: Colors.GOLD5, marginLeft: 6, verticalAlign: 'baseline' }} title="Pinned"/>}
      <div className={Classes.TEXT_SMALL}><LastActivity activity={last_activity}/></div>
    </div>
    <Sparkline activity={details.activity}/>
  </Item>;
};

const SkeletonItems = () => <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-busy="true" aria-label="Loading your projects">
  {[0, 1, 2, 3].map(i => <Item key={i}>
    <span className={Classes.SKELETON} style={{ width: 28, height: 28, borderRadius: '50%' }}/>
    <div>
      <div className={Classes.SKELETON} style={{ width: '60%', height: 14, marginBottom: 4 }}/>
      <div className={Classes.SKELETON} style={{ width: '40%', height: 12 }}/>
    </div>
    <span className={Classes.SKELETON} style={{ width: 90, height: 24 }}/>
  </Item>)}
</ul>;

// `batches`: the user's, the server's projects list may not know yet where they ran (older servers)
export const useMyProjects = batches => {
  const query = useProjects();
  const favorites = usePrefsStore(state => state.favorites);
  // the same "now" while the page is open
  const [now] = useState(() => Date.now());
  const projects = useMemo(() => my_projects(query.data ?? {}, { favorites, batches, now }), [query.data, favorites, batches, now]);
  return { query, projects };
};

export const YourProjects = ({ query, projects }) => {
  const [show_all, setShowAll] = useState(false);
  const shown = show_all ? projects : projects.slice(0, shown_first);
  const failed = !!query.error && !query.data;
  return <Section
    id="projects"
    title="Your projects"
    icon="projects"
  >
    {query.isPending && <SkeletonItems/>}
    {failed && <LoadError what="the projects" error={query.error} onRetry={() => query.refetch()}/>}
    {query.data && projects.length === 0 && <Empty>
      The projects where you ran batches, committed or looked in the last {my_projects_days} days show here, with those you pin in Explore.
    </Empty>}
    {shown.length > 0 && <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Your projects">
      {shown.map(project => <ProjectItem key={project.id} project={project}/>)}
    </ul>}
    {projects.length > shown_first && <Button
      variant="minimal"
      size="small"
      icon={show_all ? "chevron-up" : "chevron-down"}
      text={show_all ? 'Show fewer' : `${projects.length - shown_first} more`}
      aria-expanded={show_all}
      onClick={() => setShowAll(s => !s)}
      style={{ marginTop: 4 }}
    />}
    <p style={{ margin: '10px 0 2px' }}>
      <Link to="/projects">Explore all projects <Icon icon="arrow-right" size={12}/></Link>
    </p>
  </Section>;
};
