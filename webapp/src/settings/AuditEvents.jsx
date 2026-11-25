// A timeline of audit events: what happened, who did it, to what, from where, and its details on demand
import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Classes, Icon, Tag } from "@blueprintjs/core";
import styled from "styled-components";

import { Link } from "../router";
import { path_segment } from "../selection";
import { Time, actionLabel, login_failure_reasons } from "./format";
import { auditRegistryQuery } from "./api";


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
  /* the links that filter the events, in a sentence: not told apart by their color only */
  a[href="#filter"] {
    text-decoration: underline dotted;
    text-underline-offset: 2px;
  }
  .details, .meta-panel {
    grid-column: 2 / -1;
    font-size: 12px;
  }
  .details .${Classes.BUTTON} {
    min-height: 18px;
    padding: 0 4px;
    font-size: 12px;
    vertical-align: baseline;
  }
  .when {
    white-space: nowrap;
    font-size: 12px;
  }
  dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 2px 12px;
    margin: 2px 0 4px;
    overflow-wrap: anywhere;
  }
  dt {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  dd {
    margin: 0;
    min-width: 0;
  }
  dd dl {
    margin: 0;
  }
`;

// Without a registry (older servers) or while it loads: icons guessed from the action
const guessed_icon = action => {
  if (!action) return 'dot';
  if (action.includes('fail') || action.includes('denied')) return 'error';
  if (action.startsWith('auth.')) return 'log-in';
  if (action.startsWith('token.') || action.startsWith('device.')) return 'key';
  if (action.startsWith('setting')) return 'cog';
  if (action.startsWith('user.')) return 'person';
  return 'dot';
};

const empty_registry = { categories: {}, actions: {} };
// The server's labels and categories of actions, empty until they load
export const useAuditRegistry = () => useQuery(auditRegistryQuery).data ?? empty_registry;

const actor_kinds = { system: 'QA-Board', anonymous: 'someone not signed in' };


// Long values are cut, users can see all of them
const max_length = 120;
const LongText = ({ text, code = false }) => {
  const [full, setFull] = useState(false);
  const long = text.length > max_length;
  const shown = long && !full ? `${text.slice(0, max_length)}…` : text;
  return <>
    {code ? <code>{shown}</code> : shown}
    {long && <>{' '}<Button variant="minimal" size="small" text={full ? 'Show less' : 'Show all'} onClick={() => setFull(!full)}/></>}
  </>;
};

// Words and numbers as they are, objects as their keys and values, lists and deeper objects as compact JSON
const MetaValue = ({ value, depth }) => {
  if (value === null || value === undefined) return <span className={Classes.TEXT_MUTED}>none</span>;
  if (typeof value === 'string') return value ? <LongText text={value}/> : <span className={Classes.TEXT_MUTED}>empty</span>;
  if (typeof value !== 'object') return <code>{String(value)}</code>;
  if (!Array.isArray(value) && depth === 0 && Object.keys(value).length > 0) return <MetaList meta={value} depth={depth + 1}/>;
  return <LongText code text={JSON.stringify(value)}/>;
};

const MetaList = ({ meta, depth = 0 }) => <dl>
  {Object.entries(meta).map(([key, value]) => <Fragment key={key}>
    <dt>{key}</dt>
    <dd><MetaValue value={value} depth={depth}/></dd>
  </Fragment>)}
</dl>;


// `registry`: from useAuditRegistry, `onFilter`, `self_id`: see AuditEvents
const AuditEvent = ({ event, registry, self_id, onFilter }) => {
  // the details are only rendered once opened: lists have hundreds of events
  const [open, setOpen] = useState(false);
  // failed sign-ins are by someone not signed in, who tried a user name: we say which, and why it failed
  const login_failed = event.action === 'auth.login_failed';
  const show_actor = (self_id === null || event.actor_user_id !== self_id) && !(login_failed && event.actor_kind === 'anonymous');
  const actor = event.actor_label || actor_kinds[event.actor_kind] || 'unknown';
  const target = event.target_label || (event.target_type ? `${event.target_type} ${event.target_id ?? ''}`.trim() : null);
  const meta = event.meta ?? {};
  const failure = login_failed ? login_failure_reasons[meta.reason] ?? meta.reason : null;
  const changes = Object.entries(event.changes ?? {});
  const has_meta = Object.keys(meta).length > 0;
  const failed = (event.action ?? '').includes('fail');
  const category = registry.categories[registry.actions[event.action]?.category];
  // what batches and runs were about, at a glance: the commit (a link in its project) and the batch
  const commit = typeof meta.commit === 'string' ? meta.commit : null;
  // batch.start says batch_label, run events say batch
  const meta_batch = meta.batch_label ?? meta.batch;
  const batch_label = typeof meta_batch === 'string' && meta_batch !== event.target_label ? meta_batch : null;
  // each toggle says which event it opens, for screen readers
  const details_label = `Details of ${[actionLabel(event.action, registry), target].filter(Boolean).join(', ')}`;
  const panel_id = `audit-event-${event.id}-details`;
  return <li>
    <Icon icon={category?.icon ?? guessed_icon(event.action)} title={category?.label ?? false} size={14} intent={failed ? 'danger' : undefined} className={failed ? undefined : Classes.TEXT_MUTED}/>
    <span className="what">
      <strong>{actionLabel(event.action, registry)}</strong>
      {target && <>{login_failed ? ' as ' : ' · '}{onFilter && event.target_type && event.target_id
        ? <a href="#filter" onClick={e => { e.preventDefault(); onFilter({ target_type: event.target_type, target_id: event.target_id }); }} title="Only events about it">{target}</a>
        : target}</>}
      {failure && <>: {failure}</>}
      {batch_label && <> · batch <strong>{batch_label}</strong></>}
      {commit && <> · {event.project_id
        ? <Link to={`/${path_segment(event.project_id)}/commit/${path_segment(commit)}`} title={commit}><code>{commit.slice(0, 8)}</code></Link>
        : <code title={commit}>{commit.slice(0, 8)}</code>}</>}
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
      {has_meta && <>{' '}<Button
        variant="minimal"
        size="small"
        icon={open ? 'chevron-down' : 'chevron-right'}
        text="Details"
        aria-label={details_label}
        aria-expanded={open}
        aria-controls={open ? panel_id : undefined}
        onClick={() => setOpen(!open)}
      /></>}
    </span>
    {open && <div className="meta-panel" id={panel_id} role="region" aria-label={details_label}><MetaList meta={meta}/></div>}
  </li>;
};

// `onFilter({actor} or {target_type, target_id})`: admins narrow the list by clicking names.
// `self_id`: we don't say "by you" for the user's own actions.
export const AuditEvents = ({ events, self_id = null, onFilter }) => {
  const registry = useAuditRegistry();
  return <List aria-label="Activity">
    {events.map(event => <AuditEvent key={event.id} event={event} registry={registry} self_id={self_id} onFilter={onFilter}/>)}
  </List>;
};
