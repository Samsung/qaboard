// The home page's center: the user's batches that run, that need attention, that ended, then teammates'
import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Classes, Collapse, Icon, Intent, Spinner, Tag, Tooltip } from "@blueprintjs/core";

import { Link } from "../router";
import { batch_name, batch_url, BatchStatus, DefaultMetric } from "../BatchList";
import { usePrefsStore } from "../stores/prefs";
import { useSiteConfig, useUser } from "../hooks";
import { metrics_fill_defaults } from "../utils";
import { runningQuery, failedQuery, recentQuery, othersQuery, recent_size, attention_days } from "./api";
import { is_running, needs_attention } from "./logic";
import { BatchRow, Empty, LoadError, Rows, Section, SkeletonRows } from "./parts";


const logs_url = batch => {
  const url = batch_url(batch.project, batch);
  return `${url}${url.includes('?') ? '&' : '?'}selected_views=logs`;
};

const RowLink = ({ to, icon, text, label }) => <Link to={to} className={`${Classes.BUTTON} ${Classes.SMALL} ${Classes.MINIMAL}`} aria-label={label}>
  <Icon icon={icon}/><span className={Classes.BUTTON_TEXT}>{text}</span>
</Link>;


export const RunningNow = ({ query }) => {
  const running = (query.data ?? []).filter(is_running);
  if (query.isPending || (!query.error && running.length === 0)) return null;
  return <Section
    id="running"
    title="Running now"
    icon={<Spinner size={14}/>}
    extra={<Link to="/activity" className={Classes.TEXT_SMALL}>Runs activity <Icon icon="arrow-right" size={12}/></Link>}
  >
    {query.error
      ? <LoadError what="your running batches" error={query.error} onRetry={() => query.refetch()}/>
      : <Rows aria-label="Your running batches">
        {running.map(batch => <BatchRow key={batch.id} batch={batch} icon={<Spinner size={16} intent={Intent.PRIMARY}/>}>
          <BatchStatus batch={batch}/>
          <RowLink to={logs_url(batch)} icon="console" text="Logs" label={`The logs of ${batch_name(batch)}`}/>
        </BatchRow>)}
      </Rows>}
  </Section>;
};


export const NeedsAttention = ({ query }) => {
  const dismissed = usePrefsStore(state => state.homeDismissed);
  const dismiss = usePrefsStore(state => state.dismissHomeBatch);
  const batches = needs_attention(query.data ?? [], dismissed ?? {});
  if (query.isPending || (!query.error && batches.length === 0)) return null;
  return <Section
    id="attention"
    title="Needs attention"
    icon="warning-sign"
    extra={<span className={`${Classes.TEXT_MUTED} ${Classes.TEXT_SMALL}`}>failed runs, last {attention_days} days</span>}
  >
    {query.error
      ? <LoadError what="your failed batches" error={query.error} onRetry={() => query.refetch()}/>
      : <Rows aria-label="Your batches with failed runs">
        {batches.map(batch => <BatchRow key={batch.id} batch={batch} icon={<Icon icon="error" intent={Intent.DANGER}/>}>
          <Tag minimal intent={Intent.DANGER}>{batch.failed_outputs} failed</Tag>
          {batch.valid_outputs > 0 && <Tag minimal intent={Intent.SUCCESS} icon="tick-circle">{batch.valid_outputs}</Tag>}
          <RowLink to={logs_url(batch)} icon="console" text="Logs" label={`The logs of ${batch_name(batch)}`}/>
          <Tooltip content="Hide it from here. It comes back if it runs again and runs fail." hoverOpenDelay={300}>
            <Button variant="minimal" size="small" icon="cross" aria-label={`Dismiss ${batch_name(batch)}`} onClick={() => dismiss(batch.id, batch.failed_outputs, batch.latest_output_datetime)}/>
          </Tooltip>
        </BatchRow>)}
      </Rows>}
  </Section>;
};


// The server says how to show each batch's default metric: we don't fetch every project
const default_metric_of = batch => ({
  default_metric: batch.default_metric,
  available_metrics: batch.default_metric_info ? metrics_fill_defaults({ [batch.default_metric]: batch.default_metric_info }) : {},
});

export const Recent = ({ query }) => {
  const finished = (query.data ?? []).filter(b => !is_running(b)).slice(0, recent_size);
  return <Section id="recent" title="Recent" icon="history">
    {query.isPending && <SkeletonRows count={4} label="Loading your recent batches"/>}
    {query.error && <LoadError what="your recent batches" error={query.error} onRetry={() => query.refetch()}/>}
    {query.data && finished.length === 0 && <Empty>Your batches show here when they end.</Empty>}
    {finished.length > 0 && <Rows aria-label="Your recent batches">
      {finished.map(batch => <BatchRow
        key={batch.id}
        batch={batch}
        icon={batch.failed_outputs > 0 ? <Icon icon="error" intent={Intent.DANGER}/> : <Icon icon="tick-circle" intent={Intent.SUCCESS}/>}
      >
        <BatchStatus batch={batch}/>
        {batch.default_metric && <DefaultMetric batch={batch} qatools_metrics={default_metric_of(batch)}/>}
      </BatchRow>)}
    </Rows>}
  </Section>;
};


// Collapsed by default: we only ask for it when users open it
export const FromYourProjects = ({ projects }) => {
  const [open, setOpen] = useState(false);
  const body_id = useId();
  const viewer = useUser().user_id ?? null;
  const query = useQuery({ ...othersQuery(projects, viewer), enabled: open && projects.length > 0 });
  const batches = query.data ?? [];
  return <Section
    id="others"
    title={<Button
      variant="minimal"
      icon={open ? "chevron-down" : "chevron-right"}
      text="From your projects"
      aria-expanded={open}
      aria-controls={body_id}
      onClick={() => setOpen(o => !o)}
      style={{ marginLeft: -8, fontWeight: 600, fontSize: 15 }}
    />}
    extra={<span className={`${Classes.TEXT_MUTED} ${Classes.TEXT_SMALL}`}>teammates' batches, without the CI</span>}
  >
    <Collapse isOpen={open}>
      <div id={body_id}>
        {projects.length === 0 && <Empty>Pin projects, or run batches in some: your teammates' batches there show here.</Empty>}
        {open && query.isPending && projects.length > 0 && <SkeletonRows count={3} label="Loading your teammates' batches"/>}
        {query.error && <LoadError what="your teammates' batches" error={query.error} onRetry={() => query.refetch()}/>}
        {query.data && batches.length === 0 && <Empty>Nobody else ran batches in your projects lately.</Empty>}
        {batches.length > 0 && <Rows aria-label="Your teammates' batches">
          {batches.map(batch => <BatchRow key={batch.id} batch={batch} show_user icon={<Icon icon="person" className={Classes.TEXT_MUTED}/>}>
            <BatchStatus batch={batch}/>
          </BatchRow>)}
        </Rows>}
      </div>
    </Collapse>
  </Section>;
};


// New users: how their batches get here
export const GetStarted = () => {
  const { docs_root } = useSiteConfig();
  const steps = [
    { icon: 'key', title: 'Sign your runs', body: <>Run <code className={Classes.CODE}>qa auth login</code> in your terminal: the runs you send then show here, as yours. <a href={`${docs_root}docs/installation#signing-in`}>How to sign in</a></> },
    { icon: 'play', title: 'Run your first batch', body: <>Run <code className={Classes.CODE}>qa batch</code> in your project, or <strong>Run Tests / Tuning</strong> from a commit's page. <a href={`${docs_root}docs/user-guide/running-from-the-webapp`}>Run from the web app</a> · <a href={`${docs_root}docs/batches-running-on-multiple-inputs`}>Write a batch</a></> },
    { icon: 'projects', title: 'Explore the projects', body: <>See what your teammates run, and pin your projects with their star. <Link to="/projects">Explore all projects</Link></> },
  ];
  return <Section id="get-started" title="Get started" icon="flag">
    <p className={Classes.TEXT_MUTED} style={{ margin: '4px 0 8px' }}>Your batches will show here: what runs now, what failed, what ended.</p>
    <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {steps.map(({ icon, title, body }, i) => <li key={title} style={{ display: 'flex', gap: 12, padding: '10px 0', borderTop: i ? '1px solid var(--qa-border)' : undefined }}>
        <span style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: '50%', background: 'var(--qa-hover)', color: 'var(--qa-link)' }}>
          <Icon icon={icon}/>
        </span>
        <div style={{ minWidth: 0 }}>
          <strong>{i + 1}. {title}</strong>
          <p style={{ margin: '2px 0 0' }}>{body}</p>
        </div>
      </li>)}
    </ol>
  </Section>;
};


// Whether users have batches anywhere, once we know
export const useFeed = () => {
  const viewer = useUser().user_id ?? null;
  const running = useQuery(runningQuery(viewer));
  const failed = useQuery(failedQuery(viewer));
  const recent = useQuery(recentQuery(viewer));
  // When batches start or end, they move between the sections: the others refresh at once
  const queryClient = useQueryClient();
  const running_ids = (running.data ?? []).map(b => b.id).join(',');
  const [known_ids, setKnownIds] = useState(null);
  if (running.isSuccess && running_ids !== known_ids) {
    setKnownIds(running_ids);
    if (known_ids !== null)
      queryClient.invalidateQueries({ queryKey: ['batches', 'home'], predicate: query => query.queryKey[2] !== 'running' });
  }
  const loaded = running.isSuccess && recent.isSuccess;
  const has_batches = (running.data ?? []).length > 0 || (recent.data ?? []).length > 0 || (failed.data ?? []).length > 0;
  return { running, failed, recent, loaded, is_new: loaded && !has_batches };
};
