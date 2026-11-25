// A filterable audit log: Admin → Audit and a project's history. The filters are in the URL (audit/filters.js),
// the list loads more on demand, and exports download every matching event with the same filters.
import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Button, Classes, HTMLSelect, InputGroup, Menu, MenuItem, NonIdealState, PopoverNext } from "@blueprintjs/core";
import { useLocation } from "react-router";

import { history } from "../router";
import { actionLabel } from "../settings/format";
import { Loading, QueryError } from "../settings/states";
import { AuditEvents, useAuditRegistry } from "../settings/AuditEvents";
import { readFilters, filtersSearch, filterParams, formatTarget, is_filtered } from "./filters";


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

const DateFilter = ({ label, ...props }) => <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
  <span className={Classes.TEXT_MUTED}>{label}</span>
  <InputGroup type="date" style={{ width: 150 }} {...props}/>
</label>;

// `exportUrl(format)`: csv or jsonl
const ExportMenu = ({ exportUrl }) => <PopoverNext
  placement="bottom-end"
  content={<Menu>
    <MenuItem icon="th" text="Download CSV" href={exportUrl('csv')} download/>
    <MenuItem icon="code" text="Download JSON Lines" href={exportUrl('jsonl')} download/>
  </Menu>}
>
  <Button variant="minimal" icon="download" endIcon="caret-down" text="Export" title="Every matching event, at most 100,000: narrow the dates for more"/>
</PopoverNext>;


/**
 * query(params): the infinite query of the events with these filters
 * exportUrl(params, format): where to download them
 * actions: the action names users can filter by. Their categories are those of the server's registry.
 * renderError(error, refetch): the page's error state, e.g. for those who can't see it
 * what: what's loading, e.g. "the audit log"; empty: what will show up, when there are no events yet
 */
export const AuditLog = ({ label, what = 'the events', query, exportUrl, actions = [], renderError, empty }) => {
  const location = useLocation();
  const filters = readFilters(location.search);
  const setFilter = changes => history.replace(`${location.pathname}${filtersSearch(location.search, { ...filters, ...changes })}`);
  const [actor, setActor] = useDebouncedInput(filters.actor, actor => setFilter({ actor }));
  const [target, setTarget] = useDebouncedInput(filters.target, target => setFilter({ target }));
  const registry = useAuditRegistry();

  const params = filterParams(filters);
  const { data, isPending, error, refetch, hasNextPage, fetchNextPage, isFetchingNextPage, isFetching } = useInfiniteQuery(query(params));
  const events = data?.pages.flatMap(page => page.events) ?? [];
  const filtered = is_filtered(filters);

  const category_of = action => registry.actions[action]?.category;
  // only the categories of the actions listed: a project's history has no sign-ins
  const categories = Object.entries(registry.categories).filter(([key]) => actions.some(action => category_of(action) === key));
  const category_options = [{ value: '', label: 'All categories' }, ...categories.map(([value, category]) => ({ value, label: category.label }))];
  const shown_actions = filters.category ? actions.filter(action => category_of(action) === filters.category) : actions;
  const action_options = [{ value: '', label: 'All actions' }, ...shown_actions.map(action => ({ value: action, label: actionLabel(action, registry) }))];
  // an action of another category would match nothing
  const setCategory = category => setFilter({ category, ...(category && filters.action && category_of(filters.action) !== category ? { action: '' } : {}) });

  // people who can't see the log get no filters nor export, only why
  const refused = error?.response?.status === 403;
  return <section aria-label={label}>
    {!refused && <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 16 }}>
      {categories.length > 0 && <HTMLSelect aria-label="Category" options={category_options} value={filters.category} onChange={e => setCategory(e.target.value)}/>}
      <HTMLSelect aria-label="Action" options={action_options} value={filters.action} onChange={e => setFilter({ action: e.target.value })}/>
      <InputGroup leftIcon="person" placeholder="By user, or part of a name" aria-label="Actor" value={actor} onChange={e => setActor(e.target.value)} style={{ width: 210 }}/>
      <InputGroup leftIcon="locate" placeholder="About, e.g. batch:12 or token" aria-label="Target" value={target} onChange={e => setTarget(e.target.value)} style={{ width: 230 }}/>
      <DateFilter label="From" aria-label="From" value={filters.since} max={filters.until || undefined} onChange={e => setFilter({ since: e.target.value })}/>
      <DateFilter label="to" aria-label="To" value={filters.until} min={filters.since || undefined} onChange={e => setFilter({ until: e.target.value })}/>
      {filtered && <Button variant="minimal" icon="cross" text="Clear the filters" onClick={() => setFilter(Object.fromEntries(Object.keys(filters).map(name => [name, ''])))}/>}
      <span style={{ marginLeft: 'auto' }}><ExportMenu exportUrl={format => exportUrl(params, format)}/></span>
    </div>}
    {isPending && <Loading label={`Loading ${what}`}/>}
    {error && (renderError?.(error, refetch) ?? <QueryError error={error} refetch={refetch} what={what}/>)}
    {!isPending && !error && (events.length === 0
      ? <NonIdealState icon="history" title={filtered ? 'No matching events' : 'No events yet'} description={filtered ? 'Change the filters to see more events.' : empty}/>
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

export default AuditLog;
