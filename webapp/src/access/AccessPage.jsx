// /<project>/access: who can see and change the project (design/user-management.md, Appendix D.6).
// Everyone sees their role and why. Owners (and admins) change the visibility, the members and decide requests,
// the others see the owners and can request a role. Owners also manage the project's service accounts (CI bots). Members given on a folder of projects, or on all projects,
// are shown read-only: they're changed where they were given.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert, AnchorButton, Button, Callout, Card, Classes, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect, HTMLTable,
  Icon, InputGroup, Intent, NonIdealState, Radio, RadioGroup, Tag, TextArea, Tooltip,
} from "@blueprintjs/core";
import { DateTime } from "luxon";
import styled from "styled-components";

import { Link, history } from "../router";
import { path_segment, useSelected } from "../selection";
import { userQuery, logged_out_user } from "../api/queries";
import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { loginUrl } from "../login/api";
import { Time, formatDate } from "../settings/format";
import { Loading, QueryError } from "../settings/states";
import { RequestMessage } from "../admin/AccessRequests";
import { SubjectPicker } from "./SubjectPicker";
import { ServiceAccounts } from "./ServiceAccounts";
import { isNoAccessError } from "./NoProjectAccess";
import {
  roles, roleLabel, roleRank, role_options, RoleTag, visibilities, visibilityLabel, visibilityIcon, visibilityDescription,
  visibilityRank, viaText, SubjectName, subjectText,
} from "./roles";
import { projectAccessQuery, setVisibility, saveGrant, deleteGrant, requestAccess, decideRequest } from "./api";


// Below the fixed navbar, like the other project pages
const Page = styled.main`
  box-sizing: border-box;
  width: 100%;
  max-width: 1100px;
  min-width: 0;
  padding: 66px clamp(16px, 4%, 40px) 40px;

  section + section {
    margin-top: 28px;
  }
  h4.${Classes.HEADING} {
    margin-bottom: 8px;
  }
  .qa-muted-line {
    margin: 0 0 12px;
    max-width: 720px;
  }
`;

const SectionHeader = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  margin-bottom: 8px;
  h4.${Classes.HEADING} {
    margin: 0;
  }
`;

const signIn = event => {
  event.preventDefault();
  history.push(loginUrl());
};
export const SignInButton = ({ text = "Sign in", ...props }) =>
  <AnchorButton icon="log-in" text={text} href={loginUrl()} onClick={signIn} {...props}/>;

const showError = error => toaster.show({ message: errorMessage(error), intent: Intent.DANGER, timeout: 8000 });
const showSuccess = message => toaster.show({ message, intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 });


// "Developer: it was given to a group you're in."
const MyRole = ({ access }) => {
  const how = viaText(access.via, { visibility: access.visibility.effective });
  return <section aria-label="Your role">
    <h4 className={Classes.HEADING}>Your role</h4>
    {access.my_role
      ? <p style={{ margin: 0 }}>
        <RoleTag role={access.my_role} large/>{' '}
        <span className={Classes.TEXT_MUTED}>{roles.find(role => role.id === access.my_role)?.description}</span>
        {how && <><br/><span>{how}</span></>}
      </p>
      : <p style={{ margin: 0 }}>You have no role on this project: you can't see its results.</p>}
  </section>;
};


// What "Inherit" gives: the folder's visibility, else the server's default
const inheritedVisibility = visibility => visibility.parent
  ?? (visibility.own === null || visibility.inherited_from ? visibility.effective : null)
  ?? visibility.default;

const Levels = styled.ul`
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  li {
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 2px 0;
  }
`;

const Visibility = ({ access }) => {
  const queryClient = useQueryClient();
  const { visibility, can_manage, project } = access;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const effective = visibility.effective ?? visibility.own ?? visibility.default;
  const inherit = inheritedVisibility(visibility);
  // a folder that is more private wins
  const capped = visibility.own && visibility.inherited_from && visibilityRank(effective) > visibilityRank(visibility.own);

  const change = value => {
    setSaving(true);
    setError(null);
    setVisibility(queryClient, project, value === '' ? null : value)
      .then(() => showSuccess(value === '' ? `${project} inherits its visibility` : `${project} is now ${visibilityLabel(value).toLowerCase()}`))
      .catch(error => setError(errorMessage(error)))
      .finally(() => setSaving(false));
  };

  const where = visibility.inherited_from
    ? <>from <Link to={`/${path_segment(visibility.inherited_from)}/access`}><code>{visibility.inherited_from}</code></Link></>
    : visibility.own ? null : "the server's default";
  return <section aria-label="Visibility">
    <h4 className={Classes.HEADING}>Who can see it</h4>
    <p style={{ margin: '0 0 8px' }} data-testid="effective-visibility">
      <Icon icon={visibilityIcon(effective)} className={Classes.TEXT_MUTED} style={{ marginRight: 6 }}/>
      <strong>{visibilityLabel(effective) ?? 'Unknown'}</strong>
      {visibilityDescription(effective) && <>: {visibilityDescription(effective)}.</>}
      {where && <span className={Classes.TEXT_MUTED}> ({where})</span>}
    </p>
    {can_manage && <>
      <FormGroup label="Visibility" labelFor="project-visibility" style={{ marginBottom: 0 }}>
        <HTMLSelect
          id="project-visibility"
          value={visibility.own ?? ''}
          disabled={saving}
          onChange={e => change(e.target.value)}
          options={[
            ...visibilities.map(v => ({ value: v.id, label: v.label })),
            { value: '', label: inherit ? `Inherit (${visibilityLabel(inherit)})` : 'Inherit' },
          ]}
        />
      </FormGroup>
      <Levels className={Classes.TEXT_MUTED}>
        {visibilities.map(v => <li key={v.id}><Icon icon={v.icon} size={12}/><span><strong>{v.label}</strong>: {v.description}.</span></li>)}
      </Levels>
      {capped && <Callout intent={Intent.WARNING} icon="lock" compact style={{ marginTop: 8, maxWidth: 720 }}>
        It stays {visibilityLabel(effective).toLowerCase()}: <code>{visibility.inherited_from}</code> is, and projects can't be seen by more people than their folder.
      </Callout>}
      {error && <Callout intent={Intent.DANGER} compact role="alert" style={{ marginTop: 8, maxWidth: 720 }}>{error}</Callout>}
    </>}
  </section>;
};


// Where a member's role was given: this project, a folder of projects, or all of them
const isInstanceGrant = grant => grant.resource_type === 'instance' || (grant.inherited && !grant.resource_id);
const Scope = ({ grant }) => {
  if (isInstanceGrant(grant))
    return <Tooltip content="Given by an admin, on every project" hoverOpenDelay={300}><Tag minimal icon="globe-network">All projects</Tag></Tooltip>;
  if (grant.inherited)
    return <span>from <Link to={`/${path_segment(grant.resource_id)}/access`}><code style={{ overflowWrap: 'anywhere' }}>{grant.resource_id}</code></Link></span>;
  return <span className={Classes.TEXT_MUTED}>This project</span>;
};

const source_labels = { manual: null, request: 'Access request', yaml: 'Restrictions file', import: 'Imported' };
const personName = person => typeof person === 'string' ? person : person?.full_name || person?.user_name || person?.name || null;

const Granted = ({ grant }) => {
  const by = personName(grant.granted_by);
  const source = grant.source in source_labels ? source_labels[grant.source] : grant.source;
  return <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
    {source && <Tag minimal>{source}</Tag>}
    <span className={Classes.TEXT_MUTED}>{by && <>by {by}, </>}<Time iso={grant.granted_at} never="—"/></span>
  </span>;
};

const Expires = ({ iso }) => {
  if (!iso) return <span className={Classes.TEXT_MUTED}>Never</span>;
  return <Tooltip content={<Time iso={iso}/>} hoverOpenDelay={300}><span style={{ whiteSpace: 'nowrap' }}>{formatDate(iso)}</span></Tooltip>;
};


// The project's own members can be changed here, the others where they were given
const Members = ({ access, onAdd }) => {
  const queryClient = useQueryClient();
  const { project } = access;
  const [busy, setBusy] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [error, setError] = useState(null);
  // own rows first, by role, owners first
  const grants = [...access.grants].sort((a, b) => (!!a.inherited - !!b.inherited) || roleRank(b.role) - roleRank(a.role));

  const changeRole = (grant, role) => {
    setBusy(grant.id);
    setError(null);
    saveGrant(queryClient, project, { subject: grant.subject, role, expires_at: grant.expires_at })
      .then(() => showSuccess(`${subjectText(grant.subject)} is now ${roleLabel(role).toLowerCase()}`))
      // e.g. "A project needs at least one owner."
      .catch(error => setError(errorMessage(error)))
      .finally(() => setBusy(null));
  };
  const remove = grant => {
    setBusy(grant.id);
    setError(null);
    deleteGrant(queryClient, project, grant.id)
      .then(() => showSuccess(`Removed ${subjectText(grant.subject)}`))
      .catch(error => setError(errorMessage(error)))
      .finally(() => {
        setBusy(null);
        setRemoving(null);
      });
  };

  return <section aria-label="Members">
    <SectionHeader>
      <h4 className={Classes.HEADING}>Members</h4>
      <Button icon="new-person" intent={Intent.PRIMARY} text="Add member" onClick={onAdd}/>
    </SectionHeader>
    <p className={`${Classes.TEXT_MUTED} qa-muted-line`}>
      Users and groups given a role here, on a folder of projects, or on all projects.
      {access.visibility.effective !== 'private' && " Others get their role from the visibility."}
    </p>
    {error && <Callout intent={Intent.DANGER} role="alert" compact style={{ marginBottom: 12, maxWidth: 720 }}>{error}</Callout>}
    {grants.length === 0
      ? <p className={Classes.TEXT_MUTED}>No members yet: add the project's owners first.</p>
      : <div style={{ overflowX: 'auto' }}>
        <HTMLTable compact style={{ width: '100%', minWidth: 720 }} aria-label="Members">
          <thead>
            <tr><th>Member</th><th>Role</th><th>Given on</th><th>Expires</th><th>Added</th><th><span className={Classes.TEXT_MUTED} style={{ fontWeight: 'normal' }}>Actions</span></th></tr>
          </thead>
          <tbody>
            {grants.map(grant => <tr key={grant.id} data-testid={`grant-${grant.id}`}>
              <td><SubjectName subject={grant.subject}/></td>
              <td>{grant.inherited
                ? <RoleTag role={grant.role}/>
                : <HTMLSelect
                  aria-label={`Role of ${subjectText(grant.subject)}`}
                  value={grant.role}
                  disabled={busy === grant.id}
                  onChange={e => changeRole(grant, e.target.value)}
                  options={roleRank(grant.role) < 0 ? [{ value: grant.role, label: grant.role }, ...role_options] : role_options}
                />}</td>
              <td><Scope grant={grant}/></td>
              <td><Expires iso={grant.expires_at}/></td>
              <td><Granted grant={grant}/></td>
              <td>{grant.inherited
                ? <span className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>{isInstanceGrant(grant) ? 'Admins change it' : 'Change it there'}</span>
                : <Button
                  variant="minimal"
                  icon="trash"
                  intent={Intent.DANGER}
                  aria-label={`Remove ${subjectText(grant.subject)}`}
                  loading={busy === grant.id && !!removing}
                  disabled={busy === grant.id}
                  onClick={() => setRemoving(grant)}
                />}</td>
            </tr>)}
          </tbody>
        </HTMLTable>
      </div>}
    <Alert
      isOpen={!!removing}
      intent={Intent.DANGER}
      icon="trash"
      cancelButtonText="Cancel"
      confirmButtonText="Remove"
      loading={!!removing && busy === removing.id}
      onCancel={() => setRemoving(null)}
      onConfirm={() => remove(removing)}
      canEscapeKeyCancel
    >
      {removing && <p>
        Remove <strong>{subjectText(removing.subject)}</strong> from <strong>{project}</strong>? They keep the roles they have
        from elsewhere: groups, folders of projects, the visibility.
      </p>}
    </Alert>
  </section>;
};


// Picking roles, each with what it allows
const RoleChoice = ({ value, onChange, choices = roles, name }) => <RadioGroup selectedValue={value} onChange={e => onChange(e.currentTarget.value)} name={name}>
  {choices.map(role => <Radio
    key={role.id}
    value={role.id}
    labelElement={<><strong>{role.label}</strong> <span className={Classes.TEXT_MUTED}>{role.description}</span></>}
  />)}
</RadioGroup>;

const today = () => DateTime.now().toISODate();

const AddMemberDialog = ({ access, isOpen, onClose }) => {
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState(null);
  const [role, setRole] = useState('viewer');
  const [expires, setExpires] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const close = () => {
    setSubject(null);
    setRole('viewer');
    setExpires('');
    setError(null);
    onClose();
  };
  const submit = event => {
    event.preventDefault();
    if (!subject) return;
    setSaving(true);
    setError(null);
    // the end of the chosen day, in the user's time zone
    const expires_at = expires ? DateTime.fromISO(expires).endOf('day').toUTC().toISO() : undefined;
    saveGrant(queryClient, access.project, { subject, role, expires_at })
      .then(() => {
        showSuccess(`Added ${subjectText(subject)} as ${roleLabel(role).toLowerCase()}`);
        close();
      })
      .catch(error => setError(errorMessage(error)))
      .finally(() => setSaving(false));
  };
  const own = access.grants.filter(grant => !grant.inherited).map(grant => grant.subject).filter(Boolean);
  return <Dialog isOpen={isOpen} onClose={close} title="Add a member" icon="new-person" style={{ width: 560, maxWidth: 'calc(100vw - 32px)' }}>
    <form onSubmit={submit} aria-label="Add a member">
      <DialogBody>
        {error && <Callout intent={Intent.DANGER} role="alert" style={{ marginBottom: 16 }}>{error}</Callout>}
        <FormGroup label="User or group" labelFor="new-member" helperText="Groups are managed by admins, some from your sign-in provider.">
          <SubjectPicker id="new-member" value={subject} onChange={setSubject} exclude={own}/>
        </FormGroup>
        <FormGroup label="Role">
          <RoleChoice value={role} onChange={setRole} name="new-member-role"/>
        </FormGroup>
        <FormGroup label="Expires" labelInfo="(optional)" labelFor="new-member-expires" helperText={expires ? `They lose this role after ${DateTime.fromISO(expires).toLocaleString(DateTime.DATE_MED)}.` : "Leave empty to keep it until you remove it."}>
          <InputGroup id="new-member-expires" type="date" value={expires} min={today()} onChange={e => setExpires(e.target.value)} style={{ maxWidth: 200 }}/>
        </FormGroup>
      </DialogBody>
      <DialogFooter actions={<>
        <Button text="Cancel" onClick={close}/>
        <Button type="submit" intent={Intent.PRIMARY} text="Add member" loading={saving} disabled={!subject}/>
      </>}/>
    </form>
  </Dialog>;
};


const requester = request => request.user ?? request.subject ?? null;

const PendingRequest = ({ access, request }) => {
  const queryClient = useQueryClient();
  const [role, setRole] = useState(request.role ?? 'viewer');
  const [busy, setBusy] = useState(null);
  const user = requester(request);
  const name = subjectText(user);
  const decide = decision => {
    setBusy(decision);
    decideRequest(queryClient, access.project, request.id, { decision, role: decision === 'approve' ? role : undefined })
      .then(() => showSuccess(decision === 'approve' ? `${name} is now ${roleLabel(role).toLowerCase()}` : `Denied ${name}'s request`))
      .catch(showError)
      .finally(() => setBusy(null));
  };
  return <Card compact data-testid={`request-${request.id}`}>
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <SubjectName subject={user && { type: 'user', ...user }}/>
        <div className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>
          asks for <RoleTag role={request.role}/> <Time iso={request.created_at}/>
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <HTMLSelect aria-label={`Role for ${name}`} value={role} onChange={e => setRole(e.target.value)} options={role_options} disabled={!!busy}/>
        <Button icon="tick" intent={Intent.SUCCESS} text="Approve" aria-label={`Approve ${name}`} loading={busy === 'approve'} disabled={!!busy} onClick={() => decide('approve')}/>
        <Button icon="cross" intent={Intent.DANGER} variant="outlined" text="Deny" aria-label={`Deny ${name}`} loading={busy === 'deny'} disabled={!!busy} onClick={() => decide('deny')}/>
      </div>
    </div>
    <RequestMessage message={request.message}/>
  </Card>;
};

const Requests = ({ access }) => {
  const pending = access.requests.filter(request => !request.status || request.status === 'pending');
  if (pending.length === 0) return null;
  return <section aria-label="Access requests">
    <h4 className={Classes.HEADING}>Access requests <Tag minimal round intent={Intent.WARNING}>{pending.length}</Tag></h4>
    <p className={`${Classes.TEXT_MUTED} qa-muted-line`}>They get an email when you decide, if this server sends emails.</p>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {pending.map(request => <PendingRequest key={request.id} access={access} request={request}/>)}
    </div>
  </section>;
};


export const Owners = ({ owners }) => <section aria-label="Owners">
  <h4 className={Classes.HEADING}>Owners</h4>
  {owners.length === 0
    ? <p className={Classes.TEXT_MUTED} style={{ margin: 0 }}>This project has no owners yet: ask a QA-Board admin.</p>
    : <ul style={{ margin: 0, paddingLeft: 20 }}>
      {owners.map(owner => <li key={`${owner.type}:${owner.id}`}><SubjectName subject={owner}/></li>)}
    </ul>}
</section>;

const RequestAccess = ({ access }) => {
  const queryClient = useQueryClient();
  const above = roles.filter(role => roleRank(role.id) > roleRank(access.my_role));
  const [role, setRole] = useState(() => above[0]?.id ?? null);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const pending = access.my_request?.status === 'pending' || (access.my_request && !access.my_request.status) ? access.my_request : null;

  if (pending)
    return <section aria-label="Your request">
      <Callout intent={Intent.PRIMARY} icon="time" title={`You asked for the ${roleLabel(pending.role).toLowerCase()} role`} style={{ maxWidth: 720 }}>
        <span className={Classes.TEXT_MUTED}>Asked <Time iso={pending.created_at}/>. The owners got an email: you'll get one when they decide.</span>
        <RequestMessage message={pending.message}/>
      </Callout>
    </section>;
  if (above.length === 0) return null;

  const submit = event => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    requestAccess(queryClient, access.project, { role, message: message.trim() })
      .then(() => showSuccess("Request sent to the owners"))
      .catch(error => setError(errorMessage(error)))
      .finally(() => setSaving(false));
  };
  return <section aria-label="Request access">
    <h4 className={Classes.HEADING}>Request access</h4>
    {access.my_request?.status === 'denied' && <p className={Classes.TEXT_MUTED}>Your last request was denied <Time iso={access.my_request.decided_at ?? access.my_request.created_at}/>. You can ask again.</p>}
    <Card compact style={{ maxWidth: 720 }}>
      <form onSubmit={submit} aria-label="Request access">
        {error && <Callout intent={Intent.DANGER} role="alert" compact style={{ marginBottom: 12 }}>{error}</Callout>}
        <FormGroup label="Role">
          <RoleChoice value={role} onChange={setRole} choices={above} name="requested-role"/>
        </FormGroup>
        <FormGroup label="Why you need it" labelInfo="(optional)" labelFor="request-message" helperText="The owners see it with your request.">
          <TextArea id="request-message" value={message} onChange={e => setMessage(e.target.value)} fill rows={3} maxLength={2000} placeholder="e.g. I work on the denoiser, and need to run the benchmarks."/>
        </FormGroup>
        <Button type="submit" intent={Intent.PRIMARY} icon="send-message" text="Request access" loading={saving} disabled={!role}/>
      </form>
    </Card>
  </section>;
};


const SignInPrompt = () => <NonIdealState
  icon="people"
  title="Sign in to see who has access"
  description="The owners and members are only shown to signed-in users. Once signed in, you can request access."
  action={<SignInButton intent={Intent.PRIMARY}/>}
/>;


// The 403 answer says who the owners are, and whether users can ask them
const fromNoAccess = (project, error) => {
  const data = error.response?.data ?? {};
  return {
    project: data.project ?? project, my_role: null, via: null, can_manage: false,
    visibility: { own: null, effective: null, inherited_from: null, default: null },
    owners: data.owners ?? [], grants: [], requests: [], my_request: null, can_request: data.can_request !== false,
  };
};

const ProjectAccess = ({ project }) => {
  const [adding, setAdding] = useState(false);
  const { data, isPending, error, refetch } = useQuery(projectAccessQuery(project));
  if (isPending) return <Loading label="Loading who has access"/>;
  // servers may refuse outsiders: they can still ask the owners
  if (error && isNoAccessError(error)) {
    const access = fromNoAccess(project, error);
    return <>
      <MyRole access={access}/>
      <Owners owners={access.owners}/>
      {access.can_request && <RequestAccess access={access}/>}
    </>;
  }
  if (error) return <QueryError error={error} refetch={refetch} what="who has access"/>;
  const has_visibility = !!(data.visibility.effective ?? data.visibility.own ?? data.visibility.default);
  return <>
    <MyRole access={data}/>
    {has_visibility && <Visibility access={data}/>}
    {data.can_manage
      ? <>
        <Requests access={data}/>
        <Members access={data} onAdd={() => setAdding(true)}/>
        <AddMemberDialog access={data} isOpen={adding} onClose={() => setAdding(false)}/>
        <ServiceAccounts project={project}/>
      </>
      : <>
        <Owners owners={data.owners}/>
        <RequestAccess access={data}/>
      </>}
  </>;
};


export const AccessPage = () => {
  const { project } = useSelected();
  const { data: user = logged_out_user, isPending } = useQuery(userQuery);
  useEffect(() => {
    document.title = `Access - ${project.split('/').slice(-1)[0]}`;
  }, [project]);
  return <Page>
    <h2 className={Classes.HEADING} style={{ marginBottom: 4 }}>Access</h2>
    <p className={`${Classes.TEXT_MUTED} qa-muted-line`} style={{ overflowWrap: 'anywhere' }}>
      Who can see <strong>{project}</strong>, upload runs and act on them.
    </p>
    {isPending
      ? <Loading label="Loading who you are"/>
      : user.is_logged ? <ProjectAccess project={project}/> : <SignInPrompt/>}
  </Page>;
};

export default AccessPage;
