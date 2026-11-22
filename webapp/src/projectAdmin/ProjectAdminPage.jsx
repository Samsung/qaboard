// /<project>/admin/<section>: the project's Admin pages besides Access (route_paths.js project_admin)
import { useSelected } from "../selection";
import { GatePage } from "./GatePage";
import { AuditPage } from "./AuditPage";


const pages = { gate: GatePage, audit: AuditPage };

export const ProjectAdminPage = () => {
  const { route } = useSelected();
  const Section = pages[route.section] ?? GatePage;
  return <Section/>;
};

export default ProjectAdminPage;
