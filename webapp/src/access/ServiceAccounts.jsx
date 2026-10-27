// Service accounts: bots with their own tokens, for CI and scripts that shouldn't run as a person.
// On a project's Access page (`project`), for its owners: their role is on the project, their tokens can't reach others.
// In the admin panel (`project` null): the instance's, with an optional role on all projects, and members of the
// projects whose owners add them.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert, Button, Callout, Classes, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect, HTMLTable, InputGroup, Intent,
  NonIdealState, Radio, RadioGroup, Switch,
} from "@blueprintjs/core";

import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { Time, scopes } from "../settings/format";
import { Loading, QueryError } from "../settings/states";
import { TokensTable } from "../settings/tokens";
import { CreateTokenDialog } from "../settings/CreateTokenDialog";
import { roles, roleLabel, role_options } from "./roles";
import {
  serviceAccountsQuery, serviceAccountQuery, createServiceAccount, setServiceAccountRole, deleteServiceAccount,
  createServiceAccountToken, revokeServiceAccountToken,
} from "./serviceAccounts";


const showError = error => toaster.show({ message: errorMessage(error), intent: Intent.DANGER, timeout: 8000 });
const showSuccess = message => toaster.show({ message, intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 });

// what the server accepts (backend/service_accounts.py)
export const valid_name = name => /^[a-z0-9][a-z0-9._-]{0,39}$/.test(name);
// their tokens never use the admin API
const service_scopes = scopes.filter(scope => !scope.admin_only);
// instance accounts may have no role on all projects: owners add them to their projects
const NO_ROLE = '';


const CreateServiceAccountDialog = ({ project, isOpen, onClose, onCreated }) => {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [role, setRole] = useState(project ? 'developer' : NO_ROLE);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const typed = name.trim();
  const valid = valid_name(typed);

  const close = () => {
    setName('');
    setDescription('');
    setRole(project ? 'developer' : NO_ROLE);
    setError(null);
    onClose();
  };
  const submit = event => {
    event.preventDefault();
    if (!valid) return;
    setSaving(true);
    setError(null);
    createServiceAccount(queryClient, project, { name: typed, description: description.trim(), role: role || null })
      .then(account => {
        showSuccess(`Created ${account.user_name}`);
        close();
        onCreated(account);
      })
      .catch(error => setError(errorMessage(error)))
      .finally(() => setSaving(false));
  };

  const choices = project ? roles : [{ id: NO_ROLE, label: 'None', description: "Projects' owners add it to their projects, from their Access page." }, ...roles];
  return <Dialog isOpen={isOpen} onClose={close} title="New service account" icon="build" style={{ width: 560, maxWidth: 'calc(100vw - 32px)' }}>
    <form onSubmit={submit}>
      <DialogBody>
        {error && <Callout intent={Intent.DANGER} role="alert" compact style={{ marginBottom: 16 }}>{error}</Callout>}
        <FormGroup
          label="Name"
          labelFor="service-account-name"
          intent={typed && !valid ? Intent.DANGER : undefined}
          helperText={typed && !valid
            ? "Lowercase letters, digits, . _ or -, at most 40 characters."
            : <>What it's for, e.g. “ci” or “nightly”. Runs it sends say <code>{project ? `${project}/` : ''}{typed || 'ci'}[bot]</code>.</>}
        >
          <InputGroup id="service-account-name" value={name} onChange={e => setName(e.target.value)} autoFocus maxLength={40}/>
        </FormGroup>
        <FormGroup label="Description" labelInfo="(optional)" labelFor="service-account-description">
          <InputGroup id="service-account-description" value={description} onChange={e => setDescription(e.target.value)} maxLength={500} placeholder="e.g. GitLab CI of group/repo"/>
        </FormGroup>
        <FormGroup label={project ? `Role on ${project}` : "Role on all projects"}>
          <RadioGroup selectedValue={role} onChange={e => setRole(e.currentTarget.value)} name="service-account-role">
            {choices.map(choice => <Radio
              key={choice.id}
              value={choice.id}
              labelElement={<><strong>{choice.label}</strong> <span className={Classes.TEXT_MUTED}>{choice.description}</span></>}
            />)}
          </RadioGroup>
        </FormGroup>
      </DialogBody>
      <DialogFooter actions={<>
        <Button text="Cancel" onClick={close}/>
        <Button type="submit" intent={Intent.PRIMARY} text="Create" loading={saving} disabled={!valid}/>
      </>}/>
    </form>
  </Dialog>;
};


// The account's tokens: create and revoke them
const TokensDialog = ({ account, onClose }) => {
  const queryClient = useQueryClient();
  const { data, isPending, error, refetch } = useQuery({ ...serviceAccountQuery(account?.id), enabled: !!account });
  const [creating, setCreating] = useState(false);
  const [show_inactive, setShowInactive] = useState(false);
  const tokens = data?.tokens ?? [];
  const active = tokens.filter(token => (token.status ?? 'active') === 'active');
  const shown = show_inactive ? tokens : active;
  return <Dialog
    isOpen={!!account}
    onClose={onClose}
    title={account ? `Tokens of ${account.user_name}` : ''}
    icon="key"
    style={{ width: 960, maxWidth: 'calc(100vw - 32px)' }}
  >
    <DialogBody>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
        <p className={Classes.TEXT_MUTED} style={{ margin: 0 }}>
          Use them in CI with <code>QABOARD_TOKEN</code>: runs say they were sent by <strong>{account?.user_name}</strong>.
        </p>
        <Button intent={Intent.PRIMARY} icon="plus" text="New token" onClick={() => setCreating(true)}/>
      </div>
      {isPending && <Loading label="Loading the tokens"/>}
      {error && <QueryError error={error} refetch={refetch} what="the tokens"/>}
      {!isPending && !error && (tokens.length === 0
        ? <NonIdealState icon="key" title="No tokens yet" description="Create one, then save it in your CI's secrets."/>
        : <>
          {shown.length > 0
            ? <TokensTable tokens={shown} onRevoke={token => revokeServiceAccountToken(queryClient, account, token.id)}/>
            : <p className={Classes.TEXT_MUTED}>None of its tokens can be used anymore.</p>}
          {tokens.length > active.length && <Switch
            style={{ marginTop: 12 }}
            checked={show_inactive}
            onChange={() => setShowInactive(!show_inactive)}
            label={`Show revoked and expired tokens (${tokens.length - active.length})`}
          />}
        </>)}
    </DialogBody>
    <DialogFooter actions={<Button text="Close" onClick={onClose}/>}/>
    {account && <CreateTokenDialog
      isOpen={creating}
      onClose={() => setCreating(false)}
      title={`New token for ${account.user_name}`}
      secret_label={token => `The new token of ${account.user_name}, “${token.name}”`}
      create={body => createServiceAccountToken(queryClient, account, body)}
      offered={service_scopes}
      project={account.project}
      scope_help={`Give it only what it needs: it can do this as ${account.user_name}, with its role.`}
    />}
  </Dialog>;
};


const RoleSelect = ({ account }) => {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const options = account.project ? role_options : [{ value: NO_ROLE, label: 'None' }, ...role_options];
  const change = role => {
    setBusy(true);
    setServiceAccountRole(queryClient, account, role || null)
      .then(() => showSuccess(role ? `${account.user_name} is now ${roleLabel(role).toLowerCase()}` : `${account.user_name} has no role on all projects`))
      .catch(showError)
      .finally(() => setBusy(false));
  };
  return <HTMLSelect
    aria-label={`Role of ${account.user_name}`}
    value={account.role ?? NO_ROLE}
    disabled={busy}
    onChange={e => change(e.target.value)}
    options={options}
  />;
};


export const ServiceAccounts = ({ project = null }) => {
  const queryClient = useQueryClient();
  const { data: accounts, isPending, error, refetch } = useQuery(serviceAccountsQuery(project));
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);

  const remove = () => {
    setBusy(true);
    deleteServiceAccount(queryClient, deleting)
      .then(() => showSuccess(`Deleted ${deleting.user_name}`))
      .catch(showError)
      .finally(() => {
        setBusy(false);
        setDeleting(null);
      });
  };

  return <section aria-label="Service accounts">
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '8px 12px', marginBottom: 8 }}>
      <h4 className={Classes.HEADING} style={{ margin: 0 }}>Service accounts</h4>
      <Button icon="plus" text="New service account" onClick={() => setCreating(true)}/>
    </div>
    <p className={Classes.TEXT_MUTED} style={{ margin: '0 0 12px', maxWidth: 720 }}>
      {project
        ? <>Bots with their own tokens, for CI and scripts that shouldn't run as one of you. They can only access this project.</>
        : <>Bots with their own tokens, for CI and scripts used across projects. Give them a role on all projects here,
          or let projects' owners add them as members. Projects' owners can also create their own, from the project's Access page.</>}
    </p>
    {isPending && <Loading label="Loading the service accounts"/>}
    {error && <QueryError error={error} refetch={refetch} what="the service accounts"/>}
    {!isPending && !error && (accounts.length === 0
      ? <p className={Classes.TEXT_MUTED}>No service accounts yet.</p>
      : <div style={{ overflowX: 'auto' }}>
        <HTMLTable compact style={{ width: '100%', minWidth: 720 }} aria-label="Service accounts">
          <thead>
            <tr><th>Account</th><th>{project ? 'Role' : 'Role on all projects'}</th><th>Active tokens</th><th>Last used</th><th>Created</th><th><span className={Classes.TEXT_MUTED} style={{ fontWeight: 'normal' }}>Actions</span></th></tr>
          </thead>
          <tbody>
            {accounts.map(account => <tr key={account.id} data-testid={`service-account-${account.id}`}>
              <td>
                <strong style={{ overflowWrap: 'anywhere' }}>{account.user_name}</strong>
                {account.description && <div className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>{account.description}</div>}
              </td>
              <td><RoleSelect account={account}/></td>
              <td>{account.active_tokens}</td>
              <td><Time iso={account.last_used_at} never="Never used"/></td>
              <td>
                <Time iso={account.created_at}/>
                {account.created_by && <div className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>by {account.created_by}</div>}
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <Button size="small" variant="outlined" icon="key" text="Tokens" aria-label={`Tokens of ${account.user_name}`} onClick={() => setManaging(account)}/>
                {' '}
                <Button size="small" variant="minimal" icon="trash" intent={Intent.DANGER} aria-label={`Delete ${account.user_name}`} onClick={() => setDeleting(account)}/>
              </td>
            </tr>)}
          </tbody>
        </HTMLTable>
      </div>)}
    <CreateServiceAccountDialog project={project} isOpen={creating} onClose={() => setCreating(false)} onCreated={setManaging}/>
    <TokensDialog account={managing} onClose={() => setManaging(null)}/>
    <Alert
      isOpen={!!deleting}
      icon="trash"
      intent={Intent.DANGER}
      cancelButtonText="Cancel"
      confirmButtonText="Delete"
      loading={busy}
      onCancel={() => setDeleting(null)}
      onConfirm={remove}
      canEscapeKeyCancel
    >
      {deleting && <p>
        Delete <strong>{deleting.user_name}</strong>? Its tokens stop working right away, and it loses its roles. The runs it
        sent keep saying it sent them. This can't be undone.
      </p>}
    </Alert>
  </section>;
};

export default ServiceAccounts;
