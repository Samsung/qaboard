// /<project>/admin/audit, the project's audit log: who ran, deleted or changed what in the project and its subprojects.
// For the project's developers and owners (and admins): the server answers 403 to the others.
import { Classes, NonIdealState } from "@blueprintjs/core";
import styled from "styled-components";

import { Link } from "../router";
import { errorMessage } from "../api/http";
import { useSelected } from "../selection";
import { usePageTitle, join_title, project_name } from "../pageTitle";
import { AuditLog } from "../audit/AuditLog";
import { useAuditRegistry } from "../settings/AuditEvents";
import { QueryError } from "../settings/states";
import { ProjectAdminTabs, project_admin_pages } from "./ProjectAdminTabs";
import { projectAuditQuery, projectAuditExportUrl } from "./api";


// Below the fixed navbar, like the other Admin pages
const Page = styled.main`
  box-sizing: border-box;
  width: 100%;
  max-width: 1100px;
  min-width: 0;
  padding: 66px clamp(16px, 4%, 40px) 40px;
`;

// The server says why, e.g. "You need the developer role to see the history of group/repo: you're a viewer."
const DevelopersOnly = ({ project, error }) => <NonIdealState
  icon="lock"
  title="Developers and owners only"
  description={<>
    <p>Only the project's developers and owners can see its audit log. Ask an owner if you need it.</p>
    {errorMessage(error) && <p className={Classes.TEXT_MUTED}>{errorMessage(error)}</p>}
  </>}
  action={<Link to={project_admin_pages(project)[0].to}>See who has which role</Link>}
/>;

export const AuditPage = () => {
  const { project } = useSelected();
  const registry = useAuditRegistry();
  usePageTitle(join_title('Audit log', project_name(project)));
  // what projects see of the audit log
  const actions = Object.entries(registry.actions).filter(([, action]) => action.project).map(([name]) => name);
  return <Page>
    <ProjectAdminTabs project={project} current="audit"/>
    <h2 className={Classes.HEADING} style={{ marginBottom: 4 }}>Audit log</h2>
    <p className={Classes.TEXT_MUTED} style={{ margin: '0 0 20px', maxWidth: 720, overflowWrap: 'anywhere' }}>
      Who started, deleted or changed batches, runs, milestones and access in <strong>{project}</strong> and its subprojects.
    </p>
    <AuditLog
      label="Project audit log"
      what="the project's audit log"
      query={params => projectAuditQuery(project, params)}
      exportUrl={(params, format) => projectAuditExportUrl(project, params, format)}
      actions={actions}
      renderError={(error, refetch) => error?.response?.status === 403
        ? <DevelopersOnly project={project} error={error}/>
        : <QueryError error={error} refetch={refetch} what="the project's audit log"/>}
      empty="Batches started, runs deleted, milestones and roles changed will show up here."
    />
  </Page>;
};

export default AuditPage;
