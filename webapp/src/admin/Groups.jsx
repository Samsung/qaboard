// Admin → Groups: give roles to many users at once (design/user-management.md, Appendix D.3). Admins add members,
// and rules add users from the claims of their sign-in (an OIDC claim, an LDAP attribute, their email's domain).
// Project owners then give the groups roles, on the projects' Access pages.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert, Button, Callout, Classes, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect, HTMLTable, InputGroup,
  Intent, NonIdealState, Tag, TagInput, TextArea, Tooltip,
} from "@blueprintjs/core";

import { history, Link } from "../router";
import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { Time } from "../settings/format";
import { Loading } from "../settings/states";
import { SubjectPicker } from "../access/SubjectPicker";
import { SubjectName } from "../access/roles";
import { AdminError } from "./states";
import {
  groupsQuery, groupQuery, signInAdminQuery, createGroup, deleteGroup, addGroupMember, removeGroupMember, addGroupRule, deleteGroupRule,
  startJob, isActiveJob,
} from "./api";


const showError = error => toaster.show({ message: errorMessage(error), intent: Intent.DANGER, timeout: 8000 });
const showSuccess = message => toaster.show({ message, intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 });

// Servers may name the counts differently, or give the lists
const count = (group, name) => group[`${name}_count`] ?? group[`${name}s_count`] ?? group[`nb_${name}s`] ?? group[`${name}s`]?.length ?? 0;


const NewGroupDialog = ({ isOpen, onClose }) => {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const close = () => {
    setName('');
    setDescription('');
    setError(null);
    onClose();
  };
  const submit = event => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    createGroup(queryClient, { name: name.trim(), description: description.trim() })
      .then(group => {
        showSuccess(`Created the group ${name.trim()}`);
        close();
        if (group?.id !== undefined) history.push(`/admin/groups/${group.id}`);
      })
      // e.g. the name is taken
      .catch(error => setError(errorMessage(error)))
      .finally(() => setSaving(false));
  };
  return <Dialog isOpen={isOpen} onClose={close} title="New group" icon="people" style={{ width: 520, maxWidth: 'calc(100vw - 32px)' }}>
    <form onSubmit={submit} aria-label="New group">
      <DialogBody>
        {error && <Callout intent={Intent.DANGER} role="alert" style={{ marginBottom: 16 }}>{error}</Callout>}
        <FormGroup label="Name" labelFor="group-name" helperText="What owners pick on their projects' Access page, e.g. “camera-team”.">
          <InputGroup id="group-name" value={name} onChange={e => setName(e.target.value)} maxLength={100}/>
        </FormGroup>
        <FormGroup label="Description" labelInfo="(optional)" labelFor="group-description">
          <TextArea id="group-description" value={description} onChange={e => setDescription(e.target.value)} fill rows={2} maxLength={500}/>
        </FormGroup>
      </DialogBody>
      <DialogFooter actions={<>
        <Button text="Cancel" onClick={close}/>
        <Button type="submit" intent={Intent.PRIMARY} text="Create group" loading={saving} disabled={!name.trim()}/>
      </>}/>
    </form>
  </Dialog>;
};


// The update of users' groups from LDAP and single sign-on: daily, and when rules change
const GroupsSync = ({ sync }) => {
  const queryClient = useQueryClient();
  const [starting, setStarting] = useState(false);
  const job = sync?.last_job;
  const active = isActiveJob(job);
  const start = () => {
    setStarting(true);
    startJob(queryClient, 'sync_groups', {})
      .then(() => showSuccess("Updating users' groups"))
      .catch(error => error?.response?.status === 409 ? queryClient.invalidateQueries({ queryKey: ['admin', 'groups'] }) : showError(error))
      .finally(() => setStarting(false));
  };
  return <div aria-label="Updates of users' groups" role="group" className={Classes.TEXT_MUTED} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 12 }}>
    <span>
      Rules apply when users sign in, and {sync?.schedule?.enabled === false ? 'when you update them' : 'every day'}, from LDAP and single sign-on.
      {job && <> Last update: <Link to={`/admin/storage/jobs/${job.id}`}>{active ? 'running…' : job.status === 'done' ? 'done' : job.status.replace(/_/g, ' ')}</Link>{job.finished_at && <>, <Time iso={job.finished_at}/></>}.</>}
    </span>
    <Button size="small" variant="minimal" icon="refresh" text="Update now" loading={starting || active} onClick={start}/>
  </div>;
};


export const Groups = () => {
  const [creating, setCreating] = useState(false);
  const { data, isPending, error, refetch } = useQuery(groupsQuery);
  const groups = data?.groups;
  return <section aria-label="Groups">
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
      <p className={Classes.TEXT_MUTED} style={{ margin: 0, maxWidth: 680 }}>
        Give roles to many users at once: project owners pick groups on their projects' Access page.
        Add members here, or rules that add users from their sign-in's groups.
      </p>
      <Button icon="add" intent={Intent.PRIMARY} text="New group" onClick={() => setCreating(true)}/>
    </div>
    {data && <GroupsSync sync={data.sync}/>}
    {isPending && <Loading label="Loading the groups"/>}
    {error && <AdminError error={error} refetch={refetch} what="the groups"/>}
    {!isPending && !error && (groups.length === 0
      ? <NonIdealState icon="people" title="No groups yet" description="Create one for each team, then let rules fill it from your sign-in provider's groups."/>
      : <div style={{ overflowX: 'auto' }}>
        <HTMLTable compact interactive style={{ width: '100%' }} aria-label="Groups">
          <thead>
            <tr><th>Group</th><th>Description</th><th>Members</th><th>Rules</th></tr>
          </thead>
          <tbody>
            {groups.map(group => <tr key={group.id} onClick={event => { if (!event.target.closest('a')) history.push(`/admin/groups/${group.id}`); }} style={{ cursor: 'pointer' }}>
              <td><Link to={`/admin/groups/${group.id}`} style={{ fontWeight: 600 }}>{group.name}</Link></td>
              <td className={Classes.TEXT_MUTED}>{group.description || '—'}</td>
              <td>{count(group, 'member')}</td>
              <td>{count(group, 'rule')}</td>
            </tr>)}
          </tbody>
        </HTMLTable>
      </div>)}
    <NewGroupDialog isOpen={creating} onClose={() => setCreating(false)}/>
  </section>;
};


const Members = ({ group, members }) => {
  const queryClient = useQueryClient();
  const [user, setUser] = useState(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const memberUser = member => member.user ?? member;
  const add = event => {
    event.preventDefault();
    if (!user) return;
    setAdding(true);
    setError(null);
    addGroupMember(queryClient, group.id, user.id)
      .then(() => {
        showSuccess(`Added ${user.full_name || user.user_name} to ${group.name}`);
        setUser(null);
      })
      .catch(error => setError(errorMessage(error)))
      .finally(() => setAdding(false));
  };
  const remove = member => {
    const member_user = memberUser(member);
    setBusy(member_user.id);
    removeGroupMember(queryClient, group.id, member_user.id)
      .then(() => showSuccess(`Removed ${member_user.full_name || member_user.user_name} from ${group.name}`))
      .catch(showError)
      .finally(() => setBusy(null));
  };
  return <section aria-label="Members" style={{ marginBottom: 28 }}>
    <h4 className={Classes.HEADING}>Members</h4>
    <form onSubmit={add} aria-label="Add a member" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8, marginBottom: 12 }}>
      <FormGroup label="Add a user" labelFor="group-new-member" style={{ margin: 0, flex: '1 1 240px', maxWidth: 400 }}>
        <SubjectPicker id="group-new-member" types={['user']} value={user} onChange={setUser} exclude={members.map(member => ({ type: 'user', id: memberUser(member).id }))}/>
      </FormGroup>
      <Button type="submit" icon="add" text="Add" loading={adding} disabled={!user}/>
    </form>
    {error && <Callout intent={Intent.DANGER} role="alert" compact style={{ marginBottom: 12, maxWidth: 720 }}>{error}</Callout>}
    {members.length === 0
      ? <p className={Classes.TEXT_MUTED}>No members yet.</p>
      : <div style={{ overflowX: 'auto' }}>
        <HTMLTable compact style={{ width: '100%' }} aria-label="Members">
          <thead><tr><th>User</th><th>Added</th><th><span className={Classes.TEXT_MUTED} style={{ fontWeight: 'normal' }}>Actions</span></th></tr></thead>
          <tbody>
            {members.map(member => {
              const member_user = memberUser(member);
              const name = member_user.full_name || member_user.user_name;
              return <tr key={member_user.id}>
                <td><Link to={`/admin/users/${member_user.id}`}><SubjectName subject={{ type: 'user', ...member_user }}/></Link></td>
                <td>
                  {member.source === 'rule' && <Tooltip content="Added by a rule: they leave when their sign-in's groups don't match it anymore (checked daily)." hoverOpenDelay={300}><Tag minimal icon="automatic-updates" style={{ marginRight: 6 }}>Rule</Tag></Tooltip>}
                  <Time iso={member.added_at} never="—"/>
                </td>
                <td>{member.source === 'rule'
                  ? <span className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>Change the rules</span>
                  : <Button variant="minimal" icon="cross" intent={Intent.DANGER} aria-label={`Remove ${name}`} loading={busy === member_user.id} onClick={() => remove(member)}/>}</td>
              </tr>;
            })}
          </tbody>
        </HTMLTable>
      </div>}
  </section>;
};


// The claims sign-ins give: OIDC's groups, LDAP's memberOf, and the email's domain
// Keycloak roles are nested: realm_access.roles
const claim_suggestions = ['groups', 'memberOf', 'email_domain', 'roles', 'realm_access.roles'];

const Rules = ({ group, rules }) => {
  const queryClient = useQueryClient();
  const { data: sign_in } = useQuery(signInAdminQuery);
  const providers = sign_in?.providers ?? [];
  const [provider_id, setProvider] = useState('');
  const [claim, setClaim] = useState('');
  const [values, setValues] = useState([]);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const provider_name = id => id === null || id === undefined ? 'Any' : providers.find(p => p.id === id)?.name ?? id;

  const add = event => {
    event.preventDefault();
    if (!claim.trim() || values.length === 0) return;
    setSaving(true);
    setError(null);
    addGroupRule(queryClient, group.id, { provider_id: provider_id || null, claim: claim.trim(), values })
      .then(() => {
        showSuccess(`Added a rule to ${group.name}: it applies to everyone in a minute`);
        setClaim('');
        setValues([]);
      })
      .catch(error => setError(errorMessage(error)))
      .finally(() => setSaving(false));
  };
  const remove = rule => {
    setBusy(rule.id);
    deleteGroupRule(queryClient, group.id, rule.id)
      .then(() => showSuccess("Deleted the rule: the users it added leave in a minute"))
      .catch(showError)
      .finally(() => setBusy(null));
  };

  return <section aria-label="Rules">
    <h4 className={Classes.HEADING}>Rules</h4>
    <p className={Classes.TEXT_MUTED} style={{ marginTop: 0, maxWidth: 720 }}>
      Users join when they sign in with a matching claim, e.g. <code>groups</code> contains <code>camera-team</code>.
      They leave at their next sign-in without it.
    </p>
    {rules.length > 0 && <div style={{ overflowX: 'auto', marginBottom: 12 }}>
      <HTMLTable compact style={{ width: '100%' }} aria-label="Rules">
        <thead><tr><th>Sign-in</th><th>Claim</th><th>Values</th><th><span className={Classes.TEXT_MUTED} style={{ fontWeight: 'normal' }}>Actions</span></th></tr></thead>
        <tbody>
          {rules.map(rule => <tr key={rule.id} data-testid={`rule-${rule.id}`}>
            <td>{provider_name(rule.provider_id)}</td>
            <td><code>{rule.claim}</code></td>
            <td><span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
              {[].concat(rule.values ?? []).map(value => <Tag key={value} minimal style={{ maxWidth: '100%' }} title={value}>{value}</Tag>)}
            </span></td>
            <td><Button variant="minimal" icon="trash" intent={Intent.DANGER} aria-label={`Delete the rule on ${rule.claim}`} loading={busy === rule.id} onClick={() => remove(rule)}/></td>
          </tr>)}
        </tbody>
      </HTMLTable>
    </div>}
    <form onSubmit={add} aria-label="Add a rule" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8 }}>
      <FormGroup label="Sign-in" labelFor="rule-provider" style={{ margin: 0 }}>
        <HTMLSelect id="rule-provider" value={provider_id} onChange={e => setProvider(e.target.value)} options={[
          { value: '', label: 'Any' },
          ...providers.map(p => ({ value: p.id, label: p.name ?? p.id })),
        ]}/>
      </FormGroup>
      <FormGroup label="Claim" labelFor="rule-claim" style={{ margin: 0, flex: '0 1 180px' }}>
        <InputGroup id="rule-claim" value={claim} onChange={e => setClaim(e.target.value)} placeholder="groups" list="rule-claim-suggestions" autoComplete="off"/>
        <datalist id="rule-claim-suggestions">{claim_suggestions.map(c => <option key={c} value={c}>{c}</option>)}</datalist>
      </FormGroup>
      <FormGroup label="Contains any of" labelFor="rule-values" style={{ margin: 0, flex: '1 1 240px', maxWidth: 420 }}>
        <TagInput
          inputProps={{ id: 'rule-values' }}
          values={values}
          onChange={next => setValues([...new Set(next.map(v => String(v).trim()).filter(Boolean))])}
          placeholder="camera-team, Enter after each"
          addOnBlur
          // Enter adds the value, it never submits the rule
          onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }}
        />
      </FormGroup>
      <Button type="submit" icon="add" text="Add rule" loading={saving} disabled={!claim.trim() || values.length === 0}/>
    </form>
    {error && <Callout intent={Intent.DANGER} role="alert" compact style={{ marginTop: 12, maxWidth: 720 }}>{error}</Callout>}
  </section>;
};


export const GroupDetail = ({ id }) => {
  const queryClient = useQueryClient();
  const { data, isPending, error, refetch } = useQuery(groupQuery(id));
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  if (isPending) return <Loading label="Loading the group"/>;
  if (error?.response?.status === 404)
    return <NonIdealState icon="people" title="No such group" description="It may have been deleted." action={<Link to="/admin/groups">All groups</Link>}/>;
  if (error) return <AdminError error={error} refetch={refetch} what="the group"/>;
  const { group, members, rules } = data;
  const remove = () => {
    setBusy(true);
    deleteGroup(queryClient, group.id ?? id)
      .then(() => {
        showSuccess(`Deleted the group ${group.name}`);
        history.push('/admin/groups');
      })
      .catch(showError)
      .finally(() => {
        setBusy(false);
        setDeleting(false);
      });
  };
  return <section aria-label={`Group ${group.name}`}>
    <p style={{ marginTop: 0 }}><Link to="/admin/groups">← All groups</Link></p>
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
      <div style={{ minWidth: 0 }}>
        <h3 className={Classes.HEADING} style={{ marginBottom: 4, overflowWrap: 'anywhere' }}>{group.name}</h3>
        {group.description && <p className={Classes.TEXT_MUTED} style={{ margin: 0 }}>{group.description}</p>}
      </div>
      <Button icon="trash" intent={Intent.DANGER} variant="outlined" text="Delete group" onClick={() => setDeleting(true)}/>
    </div>
    <Members group={{ ...group, id: group.id ?? id }} members={members}/>
    <Rules group={{ ...group, id: group.id ?? id }} rules={rules}/>
    <Alert
      isOpen={deleting}
      intent={Intent.DANGER}
      icon="trash"
      cancelButtonText="Cancel"
      confirmButtonText="Delete"
      loading={busy}
      onCancel={() => setDeleting(false)}
      onConfirm={remove}
      canEscapeKeyCancel
    >
      <p>Delete the group <strong>{group.name}</strong>? Its members lose the roles given to it, on every project.</p>
    </Alert>
  </section>;
};

export default Groups;
