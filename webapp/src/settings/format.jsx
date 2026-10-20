// Shared by the settings and the admin pages: dates, scopes, audit actions.
import { Classes, Tag, Tooltip } from "@blueprintjs/core";
import { DateTime } from "luxon";

// The server's dates are UTC, with or without their offset
export const parseDate = iso => iso ? DateTime.fromISO(iso, { zone: 'utc' }).toLocal() : null;

// "3 days ago", the full date on hover. `never` when there is no date.
export const Time = ({ iso, never = "Never" }) => {
  const date = parseDate(iso);
  if (!date?.isValid) return <span className={Classes.TEXT_MUTED}>{never}</span>;
  return <Tooltip content={date.toLocaleString(DateTime.DATETIME_FULL)} hoverOpenDelay={300}>
    <time dateTime={iso}>{date.toRelative()}</time>
  </Tooltip>;
};

export const formatDate = iso => parseDate(iso)?.toLocaleString(DateTime.DATE_MED) ?? '';


// What tokens can do (design/user-management.md §7). `admin` is only offered to admins.
export const scopes = [
  { id: 'read', label: 'Read', description: 'See projects, commits and runs.' },
  { id: 'ingest', label: 'Ingest', description: 'Save runs and batches, e.g. from qa run or qa batch in CI.' },
  { id: 'act', label: 'Act', description: 'Redo, delete and tune runs, edit milestones.' },
  { id: 'manage', label: 'Manage', description: "Change projects' settings and who can access them." },
  { id: 'admin', label: 'Admin', description: 'Use the admin API: users, tokens, settings.', admin_only: true },
];
const scope_descriptions = Object.fromEntries(scopes.map(scope => [scope.id, scope.description]));

export const ScopeTags = ({ scopes: token_scopes = [] }) => <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
  {token_scopes.map(scope => <Tooltip key={scope} content={scope_descriptions[scope] ?? scope} hoverOpenDelay={300}>
    <Tag minimal round intent={scope === 'admin' ? 'danger' : undefined}>{scope}</Tag>
  </Tooltip>)}
</span>;


// Audit actions are codes, e.g. "token.create" or "auth.login_failed" (the server's backend/audit.py callers): we say them in words
const action_labels = {
  'auth.login': 'Logged in',
  'auth.login_failed': 'Failed to log in',
  'auth.logout': 'Logged out',
  'auth.signup': 'Signed up',
  'token.create': 'Created a token',
  'token.revoke': 'Revoked a token',
  'token.new_ip': 'Token used from a new address',
  'device.approve': 'Approved a CLI login',
  'device.deny': 'Denied a CLI login',
  'user.create': 'Created a user',
  'user.update': 'Updated a user',
  'setting.update': 'Changed a setting',
  'audit.purge': 'Deleted old audit events',
};

// Unknown actions: "user.sign_in_failed" => "User: sign in failed"
export const actionLabel = action => {
  if (!action) return '';
  if (action_labels[action]) return action_labels[action];
  const [subject, ...rest] = action.split('.');
  const words = text => text.replace(/[_-]+/g, ' ');
  const what = rest.length ? `${words(subject)}: ${words(rest.join(' '))}` : words(subject);
  return what.charAt(0).toUpperCase() + what.slice(1);
};
