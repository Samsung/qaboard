// Admin → Overview: how many users and tokens, and what to fix to make the server safer
import { useQuery } from "@tanstack/react-query";
import { Card, Classes, Colors, Icon, Intent, Spinner, Tag } from "@blueprintjs/core";
import styled from "styled-components";

import { Link } from "../router";
import { AdminError } from "./states";
import { InstanceRoles } from "./InstanceRoles";
import { overviewQuery, overviewUsageQuery } from "./api";


const Counts = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 28px;

  .count {
    font-size: 28px;
    font-weight: 600;
    line-height: 1.2;
  }
`;

const counts = [
  { key: 'users', label: 'Users', to: '/admin/users' },
  { key: 'active_30d', label: 'Active in the last 30 days' },
  { key: 'admins', label: 'Admins', to: '/admin/users?admin=true' },
  { key: 'pending', label: 'Waiting for approval', to: '/admin/users?status=pending', intent: Intent.WARNING },
  { key: 'disabled', label: 'Disabled', to: '/admin/users?status=disabled' },
  { key: 'active_tokens', label: 'Active tokens', to: '/admin/tokens' },
];

const severity_intents = { info: Intent.PRIMARY, warning: Intent.WARNING, danger: Intent.DANGER };
const severity_icons = { info: 'info-sign', warning: 'warning-sign', danger: 'error' };
const severity_order = { danger: 0, warning: 1, info: 2 };

const Check = styled.li`
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  gap: 2px 10px;
  padding: 10px 4px;
  border-bottom: 1px solid var(--qa-border);
  &:last-child { border-bottom: none; }
  .detail { grid-column: 2; }
`;

// Where admins fix each item. Items can also say where, with `link`.
const item_links = {
  require_sign_in: '/admin/settings?setting=auth.require_sign_in',
  ingest_auth: '/admin/settings?setting=ingest.auth',
  local_signup: '/admin/settings?setting=auth.local_signup',
  jenkins_anonymous_jobs: '/admin/settings?setting=jenkins.anonymous_jobs',
  signed_in_role: '/admin/settings?setting=projects.signed_in_role',
  webhook_secret: '/admin/settings?setting=git.webhook_secret',
  legacy_tokens: '/admin/tokens',
  encryption_unreadable: '/admin/settings?group=security',
  encryption_problem: '/admin/settings?group=security',
  encryption_generated: '/admin/settings?group=security',
  encryption_weak: '/admin/settings?group=security',
  encryption_rotate: '/admin/settings?group=security',
  // the "Get more from QA-Board" list (value_checklist, backend/api/admin.py). The others are server settings.
  email_notifications: '/admin/settings?group=email',
  git_hosts: '/admin/settings?group=git',
  single_sign_on: '/admin/sign-in',
  garbage_collect: '/admin/storage',
  ci_only_projects: '/admin/usage?period=90d',
  web_only_users: '/admin/usage?period=90d',
  tuning_products: '/admin/usage?period=90d',
};
// invalid_env:<key>, undecryptable:<key>: the setting
const item_link = item => item.link ?? item_links[item.id] ?? (/^(invalid_env|undecryptable):/.test(item.id) ? `/admin/settings?setting=${encodeURIComponent(item.id.split(':')[1])}` : undefined);
// The settings named in the details, e.g. "Set auth.require_sign_in to...", link to the settings
const setting_name = /\b((?:auth|ingest|tokens|audit|projects|sessions|jenkins|git|email|web|analytics|storage|metrics|jobs)\.[a-z_]+[a-z])\b/;
export const Detail = ({ text }) => text.split(setting_name).map((part, i) => i % 2
  ? <Link key={i} to={`/admin/settings?setting=${part}`}><code>{part}</code></Link>
  : part);

// What's left to do first, then what's fine. `title`: the security checklist by default, or what to configure or
// look at to get more from QA-Board (value_checklist); `todo_label`: what the count of items left says.
// `pending`: what is still loading, said in a last row (e.g. the usage-based items)
export const Checklist = ({ checklist, title = 'Security checklist', todo_label = 'to review', pending }) => {
  const sorted = [...checklist].sort((a, b) => (a.ok - b.ok) || (severity_order[a.severity] ?? 3) - (severity_order[b.severity] ?? 3));
  const todo = checklist.filter(item => !item.ok).length;
  return <section aria-label={title}>
    <h4 className={Classes.HEADING}>
      {title} {todo > 0 ? <Tag minimal intent={Intent.WARNING} round>{todo} {todo_label}</Tag> : !pending && <Tag minimal intent={Intent.SUCCESS} round>All good</Tag>}
    </h4>
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxWidth: 820 }}>
      {sorted.map(item => <Check key={item.id} data-testid={`check-${item.id}`}>
        <Icon
          icon={item.ok ? 'tick-circle' : severity_icons[item.severity] ?? 'warning-sign'}
          intent={item.ok ? Intent.SUCCESS : severity_intents[item.severity] ?? Intent.WARNING}
          aria-label={item.ok ? 'Done' : 'To review'}
        />
        <strong style={item.ok ? { fontWeight: 'normal' } : undefined}>
          {item_link(item) ? <Link to={item_link(item)} style={{ color: 'inherit' }}>{item.title}</Link> : item.title}
        </strong>
        {typeof item.detail === 'string' && item.detail && <span className={`detail ${Classes.TEXT_MUTED}`}><Detail text={item.detail}/></span>}
      </Check>)}
      {pending && <Check aria-busy="true">
        <Spinner size={16} aria-label={pending}/>
        <span className={Classes.TEXT_MUTED}>{pending}</span>
      </Check>}
    </ul>
  </section>;
};


// The page shows up at once: the counts fill in when they arrive, and the usage-based items, slower, after them
export const Overview = () => {
  const { data, error, refetch } = useQuery(overviewQuery);
  const usage = useQuery(overviewUsageQuery);
  const value_checklist = [...(data?.value_checklist ?? []), ...(usage.data ?? [])];
  return <>
    {error && <AdminError error={error} refetch={refetch} what="the overview"/>}
    <Counts aria-busy={!data && !error}>
      {counts.map(({ key, label, to, intent }) => {
        const value = data?.counts?.[key];
        const content = <>
          <div className={`count${data || error ? '' : ` ${Classes.SKELETON}`}`} style={intent && value > 0 ? { color: Colors.ORANGE3 } : undefined}>{value ?? '—'}</div>
          <div className={Classes.TEXT_MUTED}>{label}</div>
        </>;
        return <Card key={key} compact>{to ? <Link to={to} style={{ color: 'inherit', textDecoration: 'none' }}>{content}</Link> : content}</Card>;
      })}
    </Counts>
    {(data?.checklist?.length ?? 0) > 0 && <Checklist checklist={data.checklist}/>}
    {data && <div style={{ marginTop: 28 }}>
      <Checklist
        checklist={value_checklist}
        title="Get more from QA-Board"
        todo_label="to look at"
        pending={usage.isPending ? 'Looking at the last 90 days of usage…' : undefined}
      />
      {usage.error && <AdminError error={usage.error} refetch={usage.refetch} what="what the usage says"/>}
    </div>}
    <div style={{ marginTop: 28 }}><InstanceRoles/></div>
  </>;
};

export default Overview;
