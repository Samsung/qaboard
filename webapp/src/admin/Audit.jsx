// Admin → Audit: who did what, newest first. Filters are in the URL (audit/filters.js), shared with projects' history.
import { useQuery } from "@tanstack/react-query";

import { AuditLog } from "../audit/AuditLog";
import { AdminError } from "./states";
import { auditQuery, auditExportUrl, auditActionsQuery } from "./api";

export { parseTarget } from "../audit/filters";


export const Audit = () => {
  // the actions in the log, also older ones the server's registry no longer has
  const { data: actions = [] } = useQuery(auditActionsQuery);
  return <AuditLog
    label="Audit log"
    what="the audit log"
    query={auditQuery}
    exportUrl={auditExportUrl}
    actions={actions}
    renderError={(error, refetch) => <AdminError error={error} refetch={refetch} what="the audit log"/>}
    empty="Sign-ins, tokens and admin actions will show up here."
  />;
};

export default Audit;
