// Admin → Audit: who did what, newest first. Filters are in the URL (?action=&actor=&target=type:id)
import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Button, Classes, HTMLSelect, InputGroup, NonIdealState } from "@blueprintjs/core";
import { useLocation } from "react-router";

import { history } from "../router";
import { actionLabel } from "../settings/format";
import { Loading } from "../settings/states";
import { AuditEvents } from "../settings/AuditEvents";
import { AdminError } from "./states";
import { auditQuery, auditActionsQuery } from "./api";


// "user:12" => {target_type: "user", target_id: "12"}, "token" => {target_type: "token"}
export const parseTarget = text => {
  const [target_type = '', ...id] = (text ?? '').trim().split(':');
  return { target_type: target_type.trim(), target_id: id.join(':').trim() };
};
const formatTarget = ({ target_type, target_id }) => target_type ? `${target_type}${target_id ? `:${target_id}` : ''}` : '';

const readFilters = search => {
  const params = new URLSearchParams(search);
  return { action: params.get('action') ?? '', actor: params.get('actor') ?? '', target: params.get('target') ?? '' };
};
const writeFilters = filters => {
  const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
  const query = params.toString();
  history.replace(`/admin/audit${query ? `?${query}` : ''}`);
};

// Text filters apply a moment after users stop typing. When the URL changes (e.g. "Clear the filters"), so does the text.
const useDebouncedInput = (value, onChange) => {
  const [text, setText] = useState(value);
  const [previous_value, setPreviousValue] = useState(value);
  if (value !== previous_value) {
    setPreviousValue(value);
    setText(value);
  }
  const latest = useRef(onChange);
  useEffect(() => { latest.current = onChange; });
  useEffect(() => {
    if (text === value) return;
    const timer = setTimeout(() => latest.current(text), 300);
    return () => clearTimeout(timer);
  }, [text, value]);
  return [text, setText];
};


export const Audit = () => {
  const location = useLocation();
  const filters = readFilters(location.search);
  const setFilter = changes => writeFilters({ ...filters, ...changes });
  const [actor, setActor] = useDebouncedInput(filters.actor, actor => setFilter({ actor }));
  const [target, setTarget] = useDebouncedInput(filters.target, target => setFilter({ target }));

  const { data: actions = [] } = useQuery(auditActionsQuery);
  const { data, isPending, error, refetch, hasNextPage, fetchNextPage, isFetchingNextPage, isFetching } = useInfiniteQuery(auditQuery({
    action: filters.action,
    actor: filters.actor,
    ...parseTarget(filters.target),
  }));
  const events = data?.pages.flatMap(page => page.events) ?? [];
  const filtered = !!(filters.action || filters.actor || filters.target);
  const action_options = [{ value: '', label: 'All actions' }, ...actions.map(action => ({ value: action, label: actionLabel(action) }))];

  return <section aria-label="Audit log">
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 16 }}>
      <HTMLSelect aria-label="Action" options={action_options} value={filters.action} onChange={e => setFilter({ action: e.target.value })}/>
      <InputGroup leftIcon="person" placeholder="By user name" aria-label="Actor" value={actor} onChange={e => setActor(e.target.value)} style={{ width: 180 }}/>
      <InputGroup leftIcon="locate" placeholder="About, e.g. user:12 or token" aria-label="Target" value={target} onChange={e => setTarget(e.target.value)} style={{ width: 240 }}/>
      {filtered && <Button variant="minimal" icon="cross" text="Clear the filters" onClick={() => writeFilters({})}/>}
    </div>
    {isPending && <Loading label="Loading the audit log"/>}
    {error && <AdminError error={error} refetch={refetch} what="the audit log"/>}
    {!isPending && !error && (events.length === 0
      ? <NonIdealState icon="history" title={filtered ? 'No matching events' : 'No events yet'} description={filtered ? 'Change the filters to see more events.' : 'Sign-ins, tokens and admin actions will show up here.'}/>
      : <div style={{ opacity: isFetching && !isFetchingNextPage ? 0.7 : 1 }}>
        <AuditEvents events={events} onFilter={changes => setFilter('actor' in changes ? { actor: changes.actor } : { target: formatTarget(changes) })}/>
        {hasNextPage
          ? <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
            <Button variant="minimal" icon="chevron-down" text="Load more" loading={isFetchingNextPage} onClick={() => fetchNextPage()}/>
          </div>
          : <p className={Classes.TEXT_MUTED} style={{ textAlign: 'center', marginTop: 12 }}>That's all.</p>}
      </div>)}
  </section>;
};

export default Audit;
