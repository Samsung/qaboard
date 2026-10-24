// The batches of a project, the latest first: what users ran (tuning from the web app, local runs, CI), with their
// status, live progress and the default metric. Two can be compared. Used by the project page (CiCommitList).
import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import styled from "styled-components";
import { DateTime } from "luxon";
import {
  Button, Callout, Card, Checkbox, Classes, Icon, Intent, NonIdealState, ProgressBar, Spinner, Tag, Tooltip,
} from "@blueprintjs/core";

import { Link, history } from "./router";
import { path_segment } from "./selection";
import { batchesPagesQuery } from "./api/queries";
import { errorMessage } from "./api/http";
import { aggregation_metrics, useUser } from "./hooks";
import { LoadMore } from "./components/LoadMore";
import { format, metric_info, shortId } from "./utils";


export const origins = {
  webapp: { label: 'web app', icon: 'application', title: 'Started from QA-Board: tuning, Run Tests or redo' },
  local: { label: 'local', icon: 'console', title: "Run from someone's terminal" },
  ci: { label: 'CI', icon: 'build', title: 'Sent by a CI pipeline' },
};

export const OriginTag = ({ origin }) => {
  const info = origins[origin] ?? origins.ci;
  return <Tooltip content={info.title} hoverOpenDelay={300}>
    <Tag minimal icon={info.icon}>{info.label}</Tag>
  </Tooltip>;
};

// The link to a batch, compared with the same batch in the reference commit, or with another batch
export const batch_url = (project, batch, reference) => {
  const params = new URLSearchParams();
  if (batch.label !== 'default') params.set('batch', batch.label);
  if (reference) {
    params.set('reference', reference.commit.id);
    if (reference.label !== 'default') params.set('batch_ref', reference.label);
  } else if (batch.label !== 'default') params.set('batch_ref', batch.label);
  const search = params.toString();
  return `/${path_segment(project)}/commit/${path_segment(batch.commit.id)}${search ? `?${search}` : ''}`;
};

const total_runs = b => (b.valid_outputs ?? 0) + (b.failed_outputs ?? 0) + (b.pending_outputs ?? 0);

const Row = styled.li`
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 4px 12px;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid var(--qa-border);
  &:last-child { border-bottom: none; }
  .qa-batch-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; font-size: 13px; }
  .qa-batch-label { font-weight: 600; overflow-wrap: anywhere; }
  .qa-batch-results { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; align-items: center; font-variant-numeric: tabular-nums; }
  @media (max-width: 640px) {
    grid-template-columns: auto minmax(0, 1fr);
    .qa-batch-results { grid-column: 2; justify-content: flex-start; }
  }
`;

// What a batch is called in a list that says where it comes from and who started it: local batches are called
// "@alice| name" (see pretty_label), the CI's "default"
export const batch_name = batch => {
  const local = batch.label.match(/^@[^|]+\| (.*)$/);
  if (local) return local[1] === 'default' ? 'local run' : local[1];
  return batch.label === 'default' ? (batch.origin === 'ci' || !batch.origin ? 'CI batch' : 'default') : batch.label;
};

const relative = date => date ? DateTime.fromISO(date, { zone: 'utc' }).toRelative() : null;

// Its progress while runs wait or run, then how many runs ended well and failed
export const BatchStatus = ({ batch }) => {
  const total = total_runs(batch);
  const done = (batch.valid_outputs ?? 0) + (batch.failed_outputs ?? 0);
  const waiting = (batch.pending_outputs ?? 0) - (batch.running_outputs ?? 0);
  return <>
    {batch.pending_outputs > 0 && <Tooltip content={`${batch.running_outputs ?? 0} running, ${waiting} waiting for a runner`}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <ProgressBar value={total ? done / total : 0} intent={Intent.PRIMARY} stripes={batch.running_outputs > 0} style={{ width: 80 }}/>
        <span className={Classes.TEXT_MUTED}>{done}/{total}</span>
      </span>
    </Tooltip>}
    {!batch.pending_outputs && batch.valid_outputs > 0 && <Tag minimal intent={Intent.SUCCESS} icon="tick-circle">{batch.valid_outputs}</Tag>}
    {batch.failed_outputs > 0 && <Tag minimal intent={Intent.DANGER} icon="error">{batch.failed_outputs} failed</Tag>}
    {total === 0 && <Tag minimal>No runs yet</Tag>}
  </>;
};

// The project's default metric, averaged over the batch's finished runs (aggregated by the server, see useBatchesList)
export const DefaultMetric = ({ batch, qatools_metrics }) => {
  const { available_metrics = {}, default_metric } = qatools_metrics ?? {};
  if (!default_metric || !batch.valid_outputs) return null;
  const info = metric_info(available_metrics, default_metric);
  const value = batch.aggregated_metrics?.[`${info.key}_average`];
  if (value === undefined || value === null) return null;
  return <Tooltip content={`${info.label ?? info.key}: average over the ${batch.valid_outputs} finished runs`}>
    <Tag minimal><strong>{format(info.scale * value, { precision: 3 })}{info.suffix}</strong> avg {info.short_label}</Tag>
  </Tooltip>;
};

const BatchRow = ({ project, batch, qatools_metrics, checked, onCheck, show_user }) => {
  const { commit } = batch;
  const message = (commit.message ?? '').split('\n')[0];
  return <Row>
    <Checkbox
      checked={checked}
      onChange={onCheck}
      aria-label={`Select ${batch_name(batch)} to compare it`}
      style={{ margin: 0 }}
    />
    <div style={{ minWidth: 0 }}>
      <div className="qa-batch-meta">
        <Link to={batch_url(project, batch)} className="qa-batch-label" title={batch.label}>{batch_name(batch)}</Link>
        <OriginTag origin={batch.origin}/>
        {show_user && batch.user_name && batch.origin !== 'ci' && <span className={Classes.TEXT_MUTED}><Icon icon="person" size={12}/> {batch.user_name}</span>}
      </div>
      <div className={`qa-batch-meta ${Classes.TEXT_MUTED}`}>
        <span title={commit.message}><code>{shortId(project, commit.id)}</code>{commit.branch && <> on {commit.branch}</>}{message && <> · {message}</>}</span>
        {batch.latest_output_datetime && <span title={DateTime.fromISO(batch.latest_output_datetime, { zone: 'utc' }).toLocal().toLocaleString(DateTime.DATETIME_MED)}>
          {relative(batch.latest_output_datetime)}
        </span>}
      </div>
    </div>
    <div className="qa-batch-results">
      <BatchStatus batch={batch}/>
      <DefaultMetric batch={batch} qatools_metrics={qatools_metrics}/>
    </div>
  </Row>;
};

// The project's batches, shared by the list and the page that decides whether to show it
export const useBatchesList = ({ project, project_data, branch, scope, hide_ci, enabled = true }) => {
  const viewer = useUser().user_id ?? null;
  const qatools_metrics = project_data?.data?.qatools_metrics;
  const metrics = useMemo(() => aggregation_metrics(qatools_metrics), [qatools_metrics]);
  const query = useInfiniteQuery({
    ...batchesPagesQuery({
      project,
      branch: branch ?? undefined,
      scope: scope === 'mine' ? 'mine' : undefined,
      origin: hide_ci ? 'webapp,local' : undefined,
      metrics,
      viewer: scope === 'mine' ? viewer : undefined,
    }),
    enabled: enabled && !!project,
  });
  // servers that don't know this endpoint answer with something else
  const batches = useMemo(() => query.data?.pages.flatMap(page => Array.isArray(page.batches) ? page.batches : []) ?? [], [query.data]);
  return { query, batches, qatools_metrics };
};

export const BatchList = ({ project, project_data, branch, scope, hide_ci, onShowEveryone }) => {
  const { query, batches, qatools_metrics } = useBatchesList({ project, project_data, branch, scope, hide_ci });
  // ids of the batches users picked to compare, in the order they picked them
  const [picked, setPicked] = useState([]);
  const toggle = id => setPicked(ids => ids.includes(id) ? ids.filter(i => i !== id) : [...ids, id].slice(-2));
  const picked_batches = picked.map(id => batches.find(b => b.id === id)).filter(Boolean);

  if (query.isPending)
    return <NonIdealState title="Loading batches…" icon={<Spinner/>}/>;
  if (query.error)
    return <NonIdealState icon="error" title="Could not load the batches" description={<code>{errorMessage(query.error)}</code>}
      action={<Button icon="refresh" text="Retry" onClick={() => query.refetch()}/>}/>;
  if (batches.length === 0)
    return <NonIdealState
      icon="search"
      title={scope === 'mine' ? "You haven't run anything here yet" : 'No batches yet'}
      description={scope === 'mine' ? 'Start a batch from a commit\'s "Run Tests / Tuning" page, or with qa batch.' : undefined}
      action={scope === 'mine' && onShowEveryone ? <Button icon="people" text="Show everyone's" onClick={onShowEveryone}/> : undefined}
    />;

  // the first picked is compared with the second, the reference
  const [new_batch, ref_batch] = picked_batches;
  return <>
    {picked_batches.length > 0 && <Callout intent={Intent.PRIMARY} icon="comparison" style={{ marginBottom: 12, position: 'sticky', top: 60, zIndex: 2 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
        <span>{picked_batches.length === 1
          ? <>Pick another batch to compare <strong>{batch_name(new_batch)}</strong> with.</>
          : <>Compare <strong>{batch_name(new_batch)}</strong> with <strong>{batch_name(ref_batch)}</strong> (the reference).</>}</span>
        <span style={{ display: 'flex', gap: 8 }}>
          <Button text="Clear" variant="minimal" onClick={() => setPicked([])}/>
          <Button intent={Intent.PRIMARY} icon="comparison" text="Compare" disabled={picked_batches.length < 2}
            onClick={() => history.push(batch_url(project, new_batch, ref_batch))}/>
        </span>
      </div>
    </Callout>}
    {/* the previous list, while the new one loads */}
    <Card elevation={0} style={{ padding: '4px 16px', opacity: query.isPlaceholderData ? 0.6 : 1, transition: 'opacity 150ms' }} aria-busy={query.isPlaceholderData}>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Batches">
        {batches.map(batch => <BatchRow
          key={batch.id}
          project={project}
          batch={batch}
          qatools_metrics={qatools_metrics}
          checked={picked.includes(batch.id)}
          onCheck={() => toggle(batch.id)}
          show_user={scope !== 'mine'}
        />)}
      </ul>
    </Card>
    {query.hasNextPage && <LoadMore onLoadMore={() => !query.isFetchingNextPage && query.fetchNextPage()} loading={query.isFetchingNextPage} loaded={batches.length} text="More batches"/>}
  </>;
};

export default BatchList;
