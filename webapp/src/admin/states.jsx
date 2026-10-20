// Admin pages' error states: an admin whose role was removed meanwhile gets "not_admin" (403)
import { NonIdealState } from "@blueprintjs/core";

import { Link } from "../router";
import { errorReason } from "../api/http";
import { QueryError } from "../settings/states";


export const NotAdmin = () => <NonIdealState
  icon="shield"
  title="Admins only"
  description={<p>Only QA-Board admins can see this page. Ask an admin if you need access.</p>}
  action={<Link to="/">Back to the projects</Link>}
/>;

export const AdminError = ({ error, refetch, what }) => errorReason(error) === 'not_admin'
  ? <NotAdmin/>
  : <QueryError error={error} refetch={refetch} what={what}/>;
