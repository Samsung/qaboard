// Lists of tokens: the user's own (Settings), their CLI sign-ins, and all the tokens (Admin)
import { useState } from "react";
import { Alert, Button, Classes, HTMLTable, Intent, Tag, Tooltip } from "@blueprintjs/core";

import { Link } from "../router";
import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { Time, ScopeTags, formatDate } from "./format";
import { expires_soon, days_until } from "./api";


export const legacy_tooltip = "Made before tokens had scopes and expiry dates: it can do everything you can, and never expires. Replace it with a token that can only do what's needed.";

// Whether it can be used, and what users should know about it
export const TokenStatusTags = ({ token }) => {
  const status = token.status ?? 'active';
  const tags = [];
  if (token.kind === 'legacy')
    tags.push(<Tooltip key="legacy" content={legacy_tooltip} hoverOpenDelay={300}>
      <Tag minimal intent={Intent.WARNING} icon="warning-sign">legacy: all scopes</Tag>
    </Tooltip>);
  if (status === 'revoked')
    tags.push(<Tooltip key="status" content={token.revoked_at ? `Revoked on ${formatDate(token.revoked_at)}` : 'Revoked'} hoverOpenDelay={300}>
      <Tag minimal>Revoked</Tag>
    </Tooltip>);
  else if (status === 'expired')
    tags.push(<Tooltip key="status" content={token.expires_at ? `Expired on ${formatDate(token.expires_at)}` : 'Expired'} hoverOpenDelay={300}>
      <Tag minimal intent={Intent.DANGER}>Expired</Tag>
    </Tooltip>);
  else if (status === 'idle_expired')
    tags.push(<Tooltip key="status" content={`It wasn't used for ${token.idle_expiry_days ?? 'too many'} days.`} hoverOpenDelay={300}>
      <Tag minimal intent={Intent.DANGER}>Expired: unused</Tag>
    </Tooltip>);
  else if (expires_soon(token)) {
    // whole days, like the dates next to it
    const days = Math.floor(days_until(token.expires_at));
    tags.push(<Tag key="status" minimal intent={Intent.WARNING} icon="time">{days < 1 ? 'Expires within a day' : days === 1 ? 'Expires tomorrow' : `Expires in ${days} days`}</Tag>);
  } else
    tags.push(<Tag key="status" minimal intent={Intent.SUCCESS}>Active</Tag>);
  return <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>{tags}</span>;
};

const Expiry = ({ token }) => {
  if (token.expires_at) return <Time iso={token.expires_at}/>;
  if (token.idle_expiry_days) return <span>After {token.idle_expiry_days} days unused</span>;
  return <span className={Classes.TEXT_MUTED}>Never</span>;
};

const Projects = ({ projects }) => projects?.length
  ? <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, maxWidth: 220 }}>{projects.map(pattern => <code key={pattern} className={Classes.CODE}>{pattern}</code>)}</span>
  : <span className={Classes.TEXT_MUTED}>All</span>;

const LastUsed = ({ token }) => <>
  <Time iso={token.last_used_at} never="Never used"/>
  {token.last_used_ip && <div className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>from {token.last_used_ip}</div>}
</>;

// CLI sign-ins are named after the computer
export const device_name = token => token.data?.hostname || token.name;
// "qa CLI on host-12" => "qa CLI": the computer is already in the row's name
const client_name = token => {
  const { client, hostname } = token.data ?? {};
  if (!client) return null;
  return hostname ? client.replace(` on ${hostname}`, '').trim() || null : client;
};


// `kind`: "personal" (the default) or "cli" (named after the computer).
// `onRevoke(token)` resolves once revoked, we confirm before. `show_user`: the owner's column, for admins.
export const TokensTable = ({ tokens, onRevoke, kind = 'personal', show_user = false }) => {
  const [revoking, setRevoking] = useState(null);
  const [busy, setBusy] = useState(false);
  const is_cli = kind === 'cli';

  const confirm = () => {
    setBusy(true);
    Promise.resolve(onRevoke(revoking))
      .then(() => toaster.show({ message: `Revoked ${is_cli ? `the CLI sign-in on ${device_name(revoking)}` : `“${revoking.name}”`}`, intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 }))
      .catch(error => toaster.show({ message: `Could not revoke the token: ${errorMessage(error)}`, intent: Intent.DANGER }))
      .finally(() => {
        setBusy(false);
        setRevoking(null);
      });
  };

  return <>
    <div style={{ overflowX: 'auto' }}>
      <HTMLTable compact style={{ width: '100%' }} aria-label={is_cli ? 'CLI sign-ins' : 'Access tokens'}>
        <thead>
          <tr>
            <th>{is_cli ? 'Computer' : 'Name'}</th>
            {show_user && <th>User</th>}
            {!is_cli && <th>Scopes</th>}
            {!is_cli && <th>Projects</th>}
            <th>Created</th>
            <th>Expires</th>
            <th>Last used</th>
            <th>Status</th>
            <th><span className={Classes.TEXT_MUTED} style={{ fontWeight: 'normal' }}>Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {tokens.map(token => <tr key={token.id} data-testid={`token-${token.id}`} style={token.status && token.status !== 'active' ? { opacity: 0.7 } : undefined}>
            <td>
              <strong>{is_cli ? device_name(token) : token.name}</strong>
              <div className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>
                {is_cli && client_name(token) ? <>{client_name(token)} · </> : null}
                {token.prefix && <code>{token.prefix}…</code>}
              </div>
            </td>
            {show_user && <td>{token.user ? <Link to={`/admin/users/${token.user.id}`}>{token.user.user_name}</Link> : '—'}</td>}
            {!is_cli && <td>{token.kind === 'legacy' ? <span className={Classes.TEXT_MUTED}>all</span> : <ScopeTags scopes={token.scopes}/>}</td>}
            {!is_cli && <td style={{ maxWidth: 240 }}><Projects projects={token.projects}/></td>}
            <td><Time iso={token.created_at}/></td>
            <td><Expiry token={token}/></td>
            <td><LastUsed token={token}/></td>
            <td><TokenStatusTags token={token}/></td>
            <td>
              {(token.status ?? 'active') === 'active' && <Button
                size="small"
                variant="outlined"
                intent={Intent.DANGER}
                text="Revoke"
                aria-label={`Revoke ${is_cli ? device_name(token) : token.name}`}
                onClick={() => setRevoking(token)}
              />}
            </td>
          </tr>)}
        </tbody>
      </HTMLTable>
    </div>
    <Alert
      isOpen={!!revoking}
      icon="trash"
      intent={Intent.DANGER}
      cancelButtonText="Cancel"
      confirmButtonText="Revoke"
      loading={busy}
      onCancel={() => setRevoking(null)}
      onConfirm={confirm}
      canEscapeKeyCancel
    >
      {revoking && (is_cli
        ? <p>Revoke the CLI sign-in on <strong>{device_name(revoking)}</strong>? <code>qa</code> will stop working there until you run <code>qa auth login</code> again.</p>
        : <p>Revoke <strong>{revoking.name}</strong>? Scripts and CI jobs that use it will stop working right away. This can't be undone.</p>)}
    </Alert>
  </>;
};
