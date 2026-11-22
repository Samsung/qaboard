// The tabs at the top of a project's Admin pages (docs/rfcs/project-admin.md): Access, Quality gate, Audit log.
// Each is a page with its own URL, so the tabs are links. The sidebar's Admin menu lists the same pages.
import { Classes, Icon } from "@blueprintjs/core";
import styled from "styled-components";

import { Link } from "../router";
import { path_segment } from "../selection";


export const project_admin_pages = project => [
  { id: 'access', text: 'Access', icon: 'people', to: `/${path_segment(project)}/access` },
  { id: 'gate', text: 'Quality gate', icon: 'shield', to: `/${path_segment(project)}/admin/gate` },
  // for developers and owners: the page says so to the others. Not "History": the sidebar's History is the metrics'
  { id: 'audit', text: 'Audit log', icon: 'history', to: `/${path_segment(project)}/admin/audit` },
];

const Tabs = styled.nav`
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0 0 20px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--qa-border);
`;

// `current`: the id of the page shown (access, gate, audit)
export const ProjectAdminTabs = ({ project, current }) => <Tabs aria-label="Project admin">
  {project_admin_pages(project).map(({ id, text, icon, to }) => <Link
    key={id}
    to={to}
    className={`${Classes.BUTTON} ${Classes.MINIMAL}${id === current ? ` ${Classes.ACTIVE}` : ''}`}
    aria-current={id === current ? 'page' : undefined}
  >
    <Icon icon={icon}/>
    <span className={Classes.BUTTON_TEXT}>{text}</span>
  </Link>)}
</Tabs>;

export default ProjectAdminTabs;
