// A timeline of audit events: what happened, who did it, to what, from where
import { Classes, Icon, Tag } from "@blueprintjs/core";
import styled from "styled-components";

import { Time, actionLabel } from "./format";


const List = styled.ol`
  list-style: none;
  margin: 0;
  padding: 0;

  li {
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr) auto;
    gap: 4px 10px;
    align-items: baseline;
    padding: 8px 4px;
    border-bottom: 1px solid var(--qa-border);
  }
  li:last-child {
    border-bottom: none;
  }
  .what {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .details {
    grid-column: 2 / -1;
    font-size: 12px;
  }
  .when {
    white-space: nowrap;
    font-size: 12px;
  }
`;

const action_icon = action => {
  if (!action) return 'dot';
  if (action.includes('fail') || action.includes('denied')) return 'error';
  if (action.startsWith('auth.')) return 'log-in';
  if (action.startsWith('token.') || action.startsWith('device.')) return 'key';
  if (action.startsWith('setting')) return 'cog';
  if (action.startsWith('user.')) return 'person';
  return 'dot';
};

const actor_kinds = { system: 'QA-Board', anonymous: 'Someone logged out' };

// `onFilter({actor} or {target_type, target_id})`: admins narrow the list by clicking names.
// `self_id`: we don't say "by you" for the user's own actions.
export const AuditEvents = ({ events, self_id = null, onFilter }) => <List aria-label="Activity">
  {events.map(event => {
    const show_actor = self_id === null || event.actor_user_id !== self_id;
    const actor = event.actor_label || actor_kinds[event.actor_kind] || 'Unknown';
    const target = event.target_label || (event.target_type ? `${event.target_type} ${event.target_id ?? ''}`.trim() : null);
    const changes = Object.entries(event.changes ?? {});
    const failed = (event.action ?? '').includes('fail');
    return <li key={event.id}>
      <Icon icon={action_icon(event.action)} size={14} intent={failed ? 'danger' : undefined} className={failed ? undefined : Classes.TEXT_MUTED}/>
      <span className="what">
        <strong>{actionLabel(event.action)}</strong>
        {target && <> · {onFilter && event.target_type
          ? <a href="#filter" onClick={e => { e.preventDefault(); onFilter({ target_type: event.target_type, target_id: event.target_id }); }} title="Only events about it">{target}</a>
          : target}</>}
        {event.project_id && <> · <Tag minimal>{event.project_id}</Tag></>}
      </span>
      <span className={`when ${Classes.TEXT_MUTED}`}><Time iso={event.created_at}/></span>
      <span className={`details ${Classes.TEXT_MUTED}`}>
        {show_actor && <>by {onFilter && event.actor_label && event.actor_kind !== 'system'
          ? <a href="#filter" onClick={e => { e.preventDefault(); onFilter({ actor: event.actor_label }); }} title="Only events by them">{actor}</a>
          : actor}{event.actor_token_id ? ' with a token' : ''}</>}
        {event.ip && <>{show_actor ? ' · ' : ''}from {event.ip}</>}
        {changes.length > 0 && <> · {changes.map(([field, change]) => <span key={field}>
          {field}: <code>{JSON.stringify(change?.from ?? null)}</code> → <code>{JSON.stringify(change?.to ?? null)}</code>{' '}
        </span>)}</>}
      </span>
    </li>;
  })}
</List>;
