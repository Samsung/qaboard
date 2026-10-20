// Admin → Overview: how many users and tokens, and what to fix to make the server safer
import { useQuery } from "@tanstack/react-query";
import { Card, Classes, Colors, Icon, Intent, Tag } from "@blueprintjs/core";
import styled from "styled-components";

import { Link } from "../router";
import { Loading } from "../settings/states";
import { AdminError } from "./states";
import { overviewQuery } from "./api";


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

// What's left to do first, then what's fine
export const Checklist = ({ checklist }) => {
  const sorted = [...checklist].sort((a, b) => (a.ok - b.ok) || (severity_order[a.severity] ?? 3) - (severity_order[b.severity] ?? 3));
  const todo = checklist.filter(item => !item.ok).length;
  return <section aria-label="Security checklist">
    <h4 className={Classes.HEADING}>
      Security checklist {todo > 0 ? <Tag minimal intent={Intent.WARNING} round>{todo} to review</Tag> : <Tag minimal intent={Intent.SUCCESS} round>All good</Tag>}
    </h4>
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxWidth: 820 }}>
      {sorted.map(item => <Check key={item.id} data-testid={`check-${item.id}`}>
        <Icon
          icon={item.ok ? 'tick-circle' : severity_icons[item.severity] ?? 'warning-sign'}
          intent={item.ok ? Intent.SUCCESS : severity_intents[item.severity] ?? Intent.WARNING}
          aria-label={item.ok ? 'Done' : 'To review'}
        />
        <strong style={item.ok ? { fontWeight: 'normal' } : undefined}>{item.title}</strong>
        {item.detail && <span className={`detail ${Classes.TEXT_MUTED}`}>{item.detail}</span>}
      </Check>)}
    </ul>
  </section>;
};


export const Overview = () => {
  const { data, isPending, error, refetch } = useQuery(overviewQuery);
  if (isPending) return <Loading label="Loading the overview"/>;
  if (error) return <AdminError error={error} refetch={refetch} what="the overview"/>;
  return <>
    <Counts>
      {counts.map(({ key, label, to, intent }) => {
        const value = data?.counts?.[key];
        const content = <>
          <div className="count" style={intent && value > 0 ? { color: Colors.ORANGE3 } : undefined}>{value ?? '—'}</div>
          <div className={Classes.TEXT_MUTED}>{label}</div>
        </>;
        return <Card key={key} compact>{to ? <Link to={to} style={{ color: 'inherit', textDecoration: 'none' }}>{content}</Link> : content}</Card>;
      })}
    </Counts>
    {(data?.checklist?.length ?? 0) > 0 && <Checklist checklist={data.checklist}/>}
  </>;
};

export default Overview;
