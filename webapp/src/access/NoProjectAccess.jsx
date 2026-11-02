// Project pages of projects users can't see: the server answers 403 {reason: "missing_role", required, project,
// owners: [{type, id, name}], can_request} (design/user-management.md, Appendix D.4). We say whom to ask, and link
// to the project's Access page to request a role. Older servers answer {reason: "forbidden_project"} only.
import { useQuery } from "@tanstack/react-query";
import { AnchorButton, Classes, Intent, NonIdealState } from "@blueprintjs/core";

import { Link, useLinkClickHandler } from "../router";
import { path_segment, useSelected } from "../selection";
import { projectQuery, userQuery, logged_out_user } from "../api/queries";
import { loginUrl } from "../login/api";
import { roleLabel, SubjectName } from "./roles";


const no_access_reasons = ['missing_role', 'forbidden_project'];
// private projects answer anonymous users 401 {reason: "sign_in_required"}
export const isNoAccessError = error =>
  (error?.response?.status === 403 && no_access_reasons.includes(error.response.data?.reason))
  || (error?.response?.status === 401 && error.response.data?.reason === 'sign_in_required');

export const LinkButton = ({ to, ...props }) => {
  const onClick = useLinkClickHandler(to);
  return <AnchorButton href={to} onClick={onClick} {...props}/>;
};

export const NoProjectAccess = ({ project, error }) => {
  const { data: user = logged_out_user } = useQuery(userQuery);
  const data = error?.response?.data ?? {};
  const name = data.project ?? project;
  const owners = Array.isArray(data.owners) ? data.owners : [];
  const required = data.required ? roleLabel(data.required).toLowerCase() : null;
  const access_url = `/${path_segment(project)}/access`;
  return <NonIdealState
    icon="lock"
    title={<span style={{ overflowWrap: 'anywhere' }}>{user.is_logged ? `You don't have access to ${name}` : `Sign in to see ${name}`}</span>}
    description={<div style={{ maxWidth: 520 }}>
      {user.is_logged && <p>{required ? `You need the ${required} role to see it.` : "Its owners decide who can see it."}</p>}
      {owners.length > 0 && <>
        <p style={{ marginBottom: 4 }}>Ask {owners.length === 1 ? 'its owner' : 'one of its owners'}:</p>
        <ul aria-label="Owners" style={{ display: 'inline-block', textAlign: 'left', margin: 0, paddingLeft: 20 }}>
          {owners.map(owner => <li key={`${owner.type}:${owner.id}`}><SubjectName subject={owner}/></li>)}
        </ul>
      </>}
      {!user.is_logged && <p className={Classes.TEXT_MUTED}>Sign in to see who owns it.</p>}
    </div>}
    action={<div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8 }}>
      {user.is_logged
        ? data.can_request !== false && <LinkButton to={access_url} intent={Intent.PRIMARY} icon="key" text="Request access"/>
        : <LinkButton to={loginUrl()} intent={Intent.PRIMARY} icon="log-in" text="Sign in"/>}
      <Link to="/" className={`${Classes.BUTTON} ${Classes.MINIMAL}`}>All projects</Link>
    </div>}
  />;
};


// Project pages show it instead of their content when the project answers 403. The Access page stays: it's where
// users request access.
export const ProjectAccessGate = ({ children }) => {
  const { project, route } = useSelected();
  const { error } = useQuery(projectQuery(project));
  if (!route.is_access && isNoAccessError(error))
    return <div style={{ padding: '90px 16px 40px' }}><NoProjectAccess project={project} error={error}/></div>;
  return children;
};
