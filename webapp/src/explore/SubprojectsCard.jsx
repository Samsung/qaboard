// On a project's page, its subprojects: a repository has one landing page. Quiet ones come last (see ./tree.js).
import { useMemo, useState } from "react";
import { Link } from "../router";

import { Button, Card, Classes, Collapse, Icon } from "@blueprintjs/core";

import { useProjects } from "../hooks";
import { usePrefsStore } from "../stores/prefs";
import { build_tree, is_listed } from "./tree";
import { LastActivity, QuietTag } from "./ExplorePage";
import { project_url } from "../selection";

const nb_first = 8;

// The project's subprojects, as Explore groups them: {nodes, quiet_nodes}, or null without any
export const useSubprojects = project => {
  const { data: projects } = useProjects();
  const favorites = usePrefsStore(state => state.favorites);
  const [now] = useState(() => Date.now());
  return useMemo(() => {
    if (!projects || !project) return null;
    const prefix = `${project}/`;
    const subset = Object.fromEntries(Object.entries(projects).filter(([id, details]) => (id === project || id.startsWith(prefix)) && is_listed(details)));
    // the project itself, so that what's below it is named after it
    subset[project] ??= { data: {}, latest_commit_datetime: null };
    const { nodes, quiet_nodes } = build_tree(subset, { favorites, now });
    const node = [...nodes, ...quiet_nodes].find(n => n.id === project);
    if (!node || node.children.length + node.quiet_children.length === 0) return null;
    return { nodes: node.children, quiet_nodes: node.quiet_children, nb_projects: node.nb_projects };
  }, [projects, project, favorites, now]);
};

const row_style = { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '0 10px', padding: '3px 0' };

const SubprojectRow = ({ node }) => <li style={row_style}>
  {node.project
    ? <Link to={project_url(node.id)} title={node.id} style={{overflowWrap: 'anywhere'}}>{node.name}</Link>
    : <span title={node.id} style={{overflowWrap: 'anywhere'}}>{node.name}/</span>}
  {node.nb_projects > 0 && <span className={`${Classes.TEXT_MUTED} ${Classes.TEXT_SMALL}`}>+{node.nb_projects} below</span>}
  {node.quiet && <QuietTag/>}
  <LastActivity activity={node.last_activity} className={Classes.TEXT_SMALL}/>
</li>;

export const SubprojectsCard = ({ project }) => {
  const subprojects = useSubprojects(project);
  const [open, setOpen] = useState(true);
  const [show_all, setShowAll] = useState(false);
  if (!subprojects) return null;
  // groups of subprojects without a project of their own list theirs
  const flatten = nodes => nodes.flatMap(n => n.project ? [n] : [n, ...flatten([...n.children, ...n.quiet_children]).map(c => ({ ...c, name: `${n.name}/${c.name}` }))]).filter(n => n.project);
  const rows = [...flatten(subprojects.nodes), ...flatten(subprojects.quiet_nodes).map(n => ({ ...n, quiet: true }))];
  const shown = show_all ? rows : rows.slice(0, nb_first);
  return <Card elevation={0} style={{marginBottom: '15px', padding: '10px 16px'}}>
    <Button
      variant="minimal"
      size="small"
      icon={<Icon icon={open ? "chevron-down" : "chevron-right"}/>}
      text={<strong>Subprojects <span className={Classes.TEXT_MUTED}>({subprojects.nb_projects})</span></strong>}
      aria-expanded={open}
      onClick={() => setOpen(o => !o)}
      style={{marginLeft: -8}}
    />
    <Collapse isOpen={open}>
      <ul style={{listStyle: 'none', margin: '4px 0 0', padding: 0}}>
        {shown.map(node => <SubprojectRow key={node.id} node={node}/>)}
      </ul>
      {rows.length > nb_first && <Button variant="minimal" size="small" text={show_all ? "Show fewer" : `Show all ${rows.length}`} onClick={() => setShowAll(s => !s)} style={{marginLeft: -8}}/>}
    </Collapse>
  </Card>;
};

export default SubprojectsCard;
