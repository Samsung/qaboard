// Roles, visibility levels and members, in words (design/user-management.md, Appendix D.1 and D.2).
// Shared by the project's Access page and the admin pages.
import { Classes, Icon, Intent, Tag, Tooltip } from "@blueprintjs/core";


// Ordered levels: each role can do what the ones before can
export const roles = [
  { id: 'viewer', label: 'Viewer', description: 'Sees the project, its commits and runs.' },
  { id: 'developer', label: 'Developer', description: 'Also uploads runs, redoes, deletes and tunes them, edits milestones.' },
  { id: 'owner', label: 'Owner', description: 'Also decides who has access, and who can see the project.' },
];
const role_by_id = Object.fromEntries(roles.map(role => [role.id, role]));
export const roleLabel = role => role_by_id[role]?.label ?? role;
// Unknown roles (e.g. a future "maintainer") rank between the known ones we can't place: we don't hide them
export const roleRank = role => roles.findIndex(r => r.id === role);
export const role_options = roles.map(role => ({ value: role.id, label: role.label }));

const role_intents = { viewer: Intent.NONE, developer: Intent.PRIMARY, owner: Intent.SUCCESS };
export const RoleTag = ({ role, ...props }) => <Tooltip content={role_by_id[role]?.description ?? role} hoverOpenDelay={300} disabled={!role_by_id[role]}>
  <Tag minimal intent={role_intents[role]} {...props}>{roleLabel(role)}</Tag>
</Tooltip>;


// Who sees them, said after their label: "Public: anyone who can open QA-Board."
export const visibilities = [
  { id: 'public', label: 'Public', icon: 'globe', description: 'anyone who can open QA-Board' },
  { id: 'internal', label: 'Internal', icon: 'office', description: 'anyone signed in' },
  { id: 'private', label: 'Private', icon: 'lock', description: 'only members' },
];
const visibility_by_id = Object.fromEntries(visibilities.map(v => [v.id, v]));
export const visibilityLabel = visibility => visibility_by_id[visibility]?.label ?? visibility;
export const visibilityIcon = visibility => visibility_by_id[visibility]?.icon ?? 'eye-open';
export const visibilityDescription = visibility => visibility_by_id[visibility]?.description ?? null;
// public < internal < private
export const visibilityRank = visibility => visibilities.findIndex(v => v.id === visibility);


// Why users have their role on a project (`via` of /api/v1/project/access)
export const viaText = (via, { visibility } = {}) => ({
  grant: "It was given to you.",
  group: "It was given to a group you're in.",
  visibility: "The project is public: anyone can see it.",
  signed_in: `Everyone signed in has it on ${visibility === 'internal' ? 'internal' : visibility === 'public' ? 'public' : 'public and internal'} projects.`,
  admin: "You're an admin: admins are owners of every project.",
  yaml: "The server's list of restricted projects gives it to you.",
})[via] ?? null;


// "Alice (alice)", or a group's name with its icon
export const SubjectName = ({ subject }) => {
  if (!subject) return <span className={Classes.TEXT_MUTED}>Deleted</span>;
  if (subject.type === 'group')
    return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <Icon icon="people" size={14} aria-label="Group" className={Classes.TEXT_MUTED}/>
      <strong style={{ overflowWrap: 'anywhere' }}>{subject.name ?? `Group #${subject.id}`}</strong>
    </span>;
  const user_name = subject.user_name ?? subject.name;
  // service accounts are named by their user name, e.g. ci[bot]
  if (subject.kind === 'service')
    return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <Icon icon="build" size={14} aria-label="Service account" className={Classes.TEXT_MUTED}/>
      <strong style={{ overflowWrap: 'anywhere' }}>{user_name ?? `User #${subject.id}`}</strong>
    </span>;
  const full_name = subject.full_name && subject.full_name !== user_name ? subject.full_name : null;
  return <span style={{ minWidth: 0 }}>
    <strong style={{ overflowWrap: 'anywhere' }}>{full_name ?? user_name ?? `User #${subject.id}`}</strong>
    {full_name && user_name && <span className={Classes.TEXT_MUTED}> {user_name}</span>}
  </span>;
};

// For confirmations and toasts
export const subjectText = subject => subject?.type === 'group'
  ? `the group ${subject.name ?? subject.id}`
  : subject?.kind === 'service'
    ? subject.user_name ?? subject.name ?? 'this service account'
    : subject?.full_name || subject?.user_name || subject?.name || 'this user';
