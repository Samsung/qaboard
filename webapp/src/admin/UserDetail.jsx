// Admin → Users → a user: who they are, their tokens, what they did, and what admins can do about it
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Classes, HTMLTable, Intent, NonIdealState, Tooltip } from "@blueprintjs/core";

import { Link } from "../router";
import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { Time, loginTypeLabel } from "../settings/format";
import { Loading } from "../settings/states";
import { TokensTable } from "../settings/tokens";
import { AuditEvents } from "../settings/AuditEvents";
import { AdminError } from "./states";
import { UserTags } from "./Users";
import { adminUserQuery, updateUser, revokeUserTokens, adminRevokeToken } from "./api";


// The actions that need a confirmation
const confirmations = {
  disable: {
    text: user => <p>Disable <strong>{user.user_name}</strong>? They are signed out, and their tokens stop working at their next request, until you enable the account again.</p>,
    button: 'Disable',
  },
  deny: {
    text: user => <p>Deny <strong>{user.user_name}</strong>'s account? It is disabled: they can't sign in. You can enable it later.</p>,
    button: 'Deny',
  },
  revoke_tokens: {
    text: user => <p>Revoke all the tokens of <strong>{user.user_name}</strong>, CLI sign-ins included? Their scripts and CI jobs will stop working. This can't be undone.</p>,
    button: 'Revoke all',
  },
  make_admin: {
    text: user => <p>Make <strong>{user.user_name}</strong> an admin? They will manage users, tokens and the server's settings.</p>,
    button: 'Make admin',
    intent: Intent.PRIMARY,
    icon: 'shield',
  },
  remove_admin: {
    text: user => <p>Remove the admin role of <strong>{user.user_name}</strong>?</p>,
    button: 'Remove admin',
  },
};

const Actions = ({ user, me }) => {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(null);
  const is_me = String(user.id) === String(me.user_id);

  const run = (action, call, success) => {
    setBusy(action);
    return call()
      .then(result => toaster.show({ message: success(result), intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 }))
      // e.g. "You can't disable yourself." (400)
      .catch(error => toaster.show({ message: errorMessage(error), intent: Intent.DANGER, timeout: 8000 }))
      .finally(() => {
        setBusy(null);
        setConfirming(null);
      });
  };
  const actions = {
    disable: () => run('disable', () => updateUser(queryClient, user.id, { status: 'disabled' }), () => `Disabled ${user.user_name}`),
    enable: () => run('enable', () => updateUser(queryClient, user.id, { status: 'active' }), () => `Enabled ${user.user_name}`),
    approve: () => run('approve', () => updateUser(queryClient, user.id, { status: 'active' }), () => `Approved ${user.user_name}: they can sign in`),
    deny: () => run('deny', () => updateUser(queryClient, user.id, { status: 'disabled' }), () => `Denied ${user.user_name}'s account`),
    make_admin: () => run('make_admin', () => updateUser(queryClient, user.id, { is_admin: true }), () => `${user.user_name} is now an admin`),
    remove_admin: () => run('remove_admin', () => updateUser(queryClient, user.id, { is_admin: false }), () => `${user.user_name} isn't an admin anymore`),
    revoke_tokens: () => run('revoke_tokens', () => revokeUserTokens(queryClient, user.id), result => {
      const n = result?.revoked ?? 0;
      return n === 0 ? `${user.user_name} had no active tokens` : `Revoked ${n} token${n === 1 ? '' : 's'} of ${user.user_name}`;
    }),
  };

  const admin_button = user.is_admin
    ? <Button
      icon="shield"
      text="Remove admin"
      disabled={user.is_admin_from_env || is_me}
      loading={busy === 'remove_admin'}
      onClick={() => setConfirming('remove_admin')}
    />
    : <Button icon="shield" text="Make admin" loading={busy === 'make_admin'} onClick={() => setConfirming('make_admin')}/>;
  const admin_tooltip = user.is_admin_from_env
    ? "Admin from QABOARD_ADMINS, in the server's environment: change it there."
    : is_me && user.is_admin ? "You can't remove your own admin role." : null;

  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
    {user.status === 'pending' && <>
      <Button icon="tick" intent={Intent.PRIMARY} text="Approve" loading={busy === 'approve'} onClick={actions.approve}/>
      <Button icon="cross" intent={Intent.DANGER} variant="outlined" text="Deny" loading={busy === 'deny'} onClick={() => setConfirming('deny')}/>
    </>}
    {user.status === 'disabled'
      ? <Button icon="unlock" intent={Intent.SUCCESS} text="Enable" loading={busy === 'enable'} onClick={actions.enable}/>
      : user.status !== 'pending' && <Tooltip content="You can't disable yourself." disabled={!is_me}>
        <Button icon="disable" intent={Intent.DANGER} variant="outlined" text="Disable" disabled={is_me} loading={busy === 'disable'} onClick={() => setConfirming('disable')}/>
      </Tooltip>}
    {admin_tooltip ? <Tooltip content={admin_tooltip}>{admin_button}</Tooltip> : admin_button}
    <Button icon="key" text="Revoke all tokens" intent={Intent.DANGER} variant="outlined" disabled={!user.active_tokens} loading={busy === 'revoke_tokens'} onClick={() => setConfirming('revoke_tokens')}/>
    <Alert
      isOpen={!!confirming}
      intent={confirmations[confirming]?.intent ?? Intent.DANGER}
      icon={confirmations[confirming]?.icon ?? "warning-sign"}
      cancelButtonText="Cancel"
      confirmButtonText={confirmations[confirming]?.button}
      loading={!!busy}
      onCancel={() => setConfirming(null)}
      onConfirm={() => actions[confirming]()}
      canEscapeKeyCancel
    >
      {confirming && confirmations[confirming].text(user)}
    </Alert>
  </div>;
};


export const UserDetail = ({ id, me }) => {
  const queryClient = useQueryClient();
  const { data, isPending, error, refetch } = useQuery(adminUserQuery(id));
  if (isPending) return <Loading label="Loading the user"/>;
  if (error?.response?.status === 404)
    return <NonIdealState icon="person" title="No such user" description="It may have been deleted." action={<Link to="/admin/users">All users</Link>}/>;
  if (error) return <AdminError error={error} refetch={refetch} what="the user"/>;
  const { user, tokens, audit } = data;
  return <section aria-label={`User ${user.user_name}`}>
    <p style={{ marginTop: 0 }}><Link to="/admin/users">← All users</Link></p>
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
      <div>
        <h3 className={Classes.HEADING} style={{ marginBottom: 6 }}>{user.full_name || user.user_name}</h3>
        <UserTags user={user}/>
      </div>
      <Actions user={user} me={me}/>
    </div>
    <HTMLTable compact style={{ marginBottom: 24 }}>
      <tbody>
        <tr><th scope="row">User name</th><td><code>{user.user_name}</code></td></tr>
        <tr><th scope="row">Email</th><td>{user.email || <span className={Classes.TEXT_MUTED}>Not set</span>}</td></tr>
        <tr><th scope="row">Sign-in</th><td>{loginTypeLabel(user.login_type) ?? '—'}</td></tr>
        <tr><th scope="row">Last sign-in</th><td><Time iso={user.last_login_at}/></td></tr>
        <tr><th scope="row">Created</th><td><Time iso={user.created_date}/></td></tr>
      </tbody>
    </HTMLTable>

    <h4 className={Classes.HEADING}>Tokens</h4>
    {tokens.length === 0
      ? <p className={Classes.TEXT_MUTED}>No tokens.</p>
      : <TokensTable tokens={tokens} onRevoke={token => adminRevokeToken(queryClient, token.id)}/>}

    <h4 className={Classes.HEADING} style={{ marginTop: 24 }}>Activity</h4>
    {audit.length === 0
      ? <p className={Classes.TEXT_MUTED}>Nothing yet.</p>
      : <>
        <AuditEvents events={audit}/>
        <p style={{ marginTop: 8 }}><Link to={`/admin/audit?actor=${encodeURIComponent(user.user_name)}`}>See all their actions in the audit log</Link></p>
      </>}
  </section>;
};

export default UserDetail;
