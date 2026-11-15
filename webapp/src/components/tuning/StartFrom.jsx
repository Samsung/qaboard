// Run Tests / Tuning: "Start from a previous batch". Lists what was started from QA-Board in the project, on any
// commit, and fills the form like it was then. The server remembers it with each batch (see history.js).
import { useState } from "react";
import styled from "styled-components";
import { useQuery } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { Button, Classes, Icon, InputGroup, Intent, NonIdealState, PopoverNext, SegmentedControl, Spinner, Tag } from "@blueprintjs/core";

import { http, errorMessage } from "../../api/http";
import { describe_request, request_batches } from "./history";


const Panel = styled.div`
  width: min(560px, 92vw);
  .qa-history-head { display: flex; gap: 8px; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--qa-border); }
  .qa-history-list { max-height: 400px; overflow-y: auto; padding: 4px 0; }
  .qa-history-item { display: block; width: 100%; padding: 7px 12px; border: 0; background: none; text-align: left; font: inherit; color: inherit; cursor: pointer; }
  .qa-history-item:hover, .qa-history-item:focus-visible { background: var(--qa-hover); outline: none; }
  .qa-history-title { display: flex; align-items: baseline; gap: 8px; }
  .qa-history-label { font-weight: 600; overflow-wrap: anywhere; }
  .qa-history-when { margin-left: auto; flex: none; font-size: 12px; white-space: nowrap; }
  .qa-history-detail { font-size: 12px; overflow-wrap: anywhere; }
  .qa-history-foot { padding: 8px 12px; border-top: 1px solid var(--qa-border); font-size: 12px; }
`;

const when = created_at => {
  const date = DateTime.fromISO(String(created_at ?? ''));
  return date.isValid ? { relative: date.toRelative(), exact: date.toLocaleString(DateTime.DATETIME_MED) } : null;
};

const HistoryList = ({ project, commit_id, onPick }) => {
  const [scope, setScope] = useState('mine');
  const [search, setSearch] = useState('');
  const { data, isPending, error } = useQuery({
    queryKey: ['tuning-history', project, scope],
    queryFn: async ({ signal }) => (await http.get('/api/v1/tuning/history', { params: { project, scope }, signal, background: true })).data,
    staleTime: 30 * 1000,
  });
  const history = Array.isArray(data?.history) ? data.history : [];
  const query = search.trim().toLowerCase();
  const shown = query
    ? history.filter(e => [e.batch_label, e.user, e.branch, request_batches(e.request), describe_request(e.request)].some(text => String(text ?? '').toLowerCase().includes(query)))
    : history;
  return <Panel data-testid="tuning-history">
    <div className="qa-history-head">
      <SegmentedControl
        size="small"
        aria-label="Whose batches"
        options={[{ label: 'Mine', value: 'mine' }, { label: 'Everyone’s', value: 'all' }]}
        value={scope}
        onValueChange={setScope}
      />
      <InputGroup small fill leftIcon="search" aria-label="Find a previous batch" placeholder="Find by name, batch, parameter, branch" value={search} onChange={e => setSearch(e.target.value)}/>
    </div>
    <div className="qa-history-list">
      {isPending ? <div style={{ padding: 24 }}><Spinner size={20} aria-label="Loading the previous batches"/></div>
        : error ? <NonIdealState icon="error" iconSize={32} title="Could not list the previous batches" description={errorMessage(error)}/>
        : shown.length === 0 ? <NonIdealState
            icon="history"
            iconSize={32}
            title={query ? 'Nothing matches' : scope === 'mine' ? 'You started nothing here yet' : 'Nothing was started here yet'}
            description={query ? undefined : 'Batches started from this form show here, on any commit of the project, to start from them again.'}
          />
        : shown.map(entry => {
          const date = when(entry.created_at);
          const failed = entry.status === 'failed';
          return <button type="button" key={entry.id} className={`qa-history-item ${Classes.POPOVER_DISMISS}`} onClick={() => onPick(entry)} data-testid={`history-${entry.id}`}>
            <div className="qa-history-title">
              <span className="qa-history-label">{entry.batch_label}</span>
              {failed && <Tag minimal intent={Intent.DANGER}>failed to start</Tag>}
              {date && <span className={`qa-history-when ${Classes.TEXT_MUTED}`} title={date.exact}>{date.relative}</span>}
            </div>
            <div className={`qa-history-detail ${Classes.TEXT_MUTED}`}>
              <Icon icon="list-detail-view" size={11} style={{ marginRight: 4 }}/>{request_batches(entry.request) || 'no batch'}
              <span style={{ margin: '0 6px' }}>·</span>{describe_request(entry.request)}
            </div>
            <div className={`qa-history-detail ${Classes.TEXT_MUTED}`}>
              {scope === 'all' && entry.user && <><Icon icon="user" size={11} style={{ marginRight: 4 }}/>{entry.user}<span style={{ margin: '0 6px' }}>·</span></>}
              <Icon icon="git-branch" size={11} style={{ marginRight: 4 }}/>{entry.branch ?? 'no branch'}
              <span style={{ margin: '0 6px' }}>·</span>{entry.commit_id === commit_id ? 'this commit' : <code>{String(entry.commit_id ?? '').slice(0, 8)}</code>}
              {entry.message && entry.commit_id !== commit_id && <span style={{ marginLeft: 6 }}>{entry.message}</span>}
            </div>
          </button>;
        })}
    </div>
    <div className={`qa-history-foot ${Classes.TEXT_MUTED}`}>
      Picking one fills the form with its tests and parameters. Nothing starts until you press Start.
    </div>
  </Panel>;
};

/** The button that opens the list. `onPick` gets the entry: {batch_label, request, commit_id...} */
export const StartFrom = ({ project, commit_id, onPick, disabled }) => <PopoverNext
  placement="bottom-end"
  disabled={disabled}
  // the list is asked for when it opens
  content={<HistoryList project={project} commit_id={commit_id} onPick={onPick}/>}
>
  <Button icon="history" text="Start from a previous batch" endIcon="caret-down" disabled={disabled} data-testid="tuning-start-from"/>
</PopoverNext>;

export default StartFrom;
