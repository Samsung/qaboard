// Shared by the settings and the admin pages: dates, scopes, audit actions, sign-in methods.
import { Classes, Intent, Tag, Tooltip } from "@blueprintjs/core";
import { DateTime } from "luxon";

// The server's dates are UTC, with or without their offset
export const parseDate = iso => iso ? DateTime.fromISO(iso, { zone: 'utc' }).toLocal() : null;

// "3 days ago", "just now" rather than "0 seconds ago"
export const relativeTime = date => Math.abs(date.diffNow('seconds').seconds) < 45 ? 'just now' : date.toRelative();

// "3 days ago", the full date on hover. `never` when there is no date.
export const Time = ({ iso, never = "Never" }) => {
  const date = parseDate(iso);
  if (!date?.isValid) return <span className={Classes.TEXT_MUTED} style={{ whiteSpace: 'nowrap' }}>{never}</span>;
  return <Tooltip content={date.toLocaleString(DateTime.DATETIME_FULL)} hoverOpenDelay={300}>
    <time dateTime={iso} style={{ whiteSpace: 'nowrap' }}>{relativeTime(date)}</time>
  </Tooltip>;
};

export const formatDate = iso => parseDate(iso)?.toLocaleString(DateTime.DATE_MED) ?? '';


// What tokens can do (design/user-management.md §7). `admin` is only offered to admins.
// Scopes the server gives that aren't listed here are shown as they are.
export const scopes = [
  { id: 'read', label: 'Read', description: 'See projects, commits and runs.' },
  { id: 'ingest', label: 'Ingest', description: 'Save runs and batches, e.g. from qa run or qa batch in CI.' },
  { id: 'act', label: 'Act', description: 'Redo, delete and tune runs, edit milestones.' },
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
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed to sign in',
  'auth.logout': 'Signed out',
  'auth.signup': 'Signed up',
  'token.create': 'Created a token',
  'token.revoke': 'Revoked a token',
  'token.new_ip': 'Token used from a new address',
  // it creates a CLI token: its own token.create event follows
  'device.approve': 'Approved a CLI sign-in',
  'device.deny': 'Denied a CLI sign-in',
  'user.create': 'Created a user',
  'user.update': 'Updated a user',
  'setting.update': 'Changed a setting',
  'audit.purge': 'Deleted old audit events',
  'batch.delete': 'Deleted a batch',
  'jenkins.build': 'Started a Jenkins build',
};

// Why signing in failed (`meta.reason` of auth.login_failed events)
export const login_failure_reasons = {
  'invalid-password': 'wrong password',
  'invalid-username': 'unknown user',
  'disabled': 'disabled account',
  'pending': 'pending account',
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


// How users sign in (`login_type` of users and of the server)
const login_type_labels = {
  LOCAL: 'User name and password',
  LDAP: 'LDAP',
  SAML: 'SAML',
};
export const loginTypeLabel = login_type => login_type ? login_type_labels[String(login_type).toUpperCase()] ?? login_type : null;

// The same everywhere: the profile, the users list, a user's page
export const AdminTag = ({ from_env = false }) => <Tag minimal intent={Intent.PRIMARY} icon="shield">Admin{from_env ? ' (env)' : ''}</Tag>;


// Server texts (settings' descriptions...) write code between `backticks`: we show it as code
export const WithCode = ({ text }) => {
  if (typeof text !== 'string') return text ?? null;
  return text.split(/`([^`]+)`/).map((part, i) => i % 2 ? <code key={i}>{part}</code> : part);
};
