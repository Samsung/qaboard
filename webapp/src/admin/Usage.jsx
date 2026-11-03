// Admin → Usage: who uses QA-Board, how much, and for what, from the usage events the web app and the `qa` CLI send
// (docs/design/usage-analytics.md). The period and the project filter are in the URL (?period=30d&project=).
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AnchorButton, Button, ButtonGroup, Card, Classes, Colors, HTMLTable, InputGroup, Intent, Tag, Tooltip } from "@blueprintjs/core";
import { DateTime } from "luxon";
import styled from "styled-components";

import { history, Link } from "../router";
import { Loading } from "../settings/states";
import { Time } from "../settings/format";
import { formatNumber } from "../activity/format";
import { project_url } from "../selection";
import { AdminError } from "./states";
import { usageSummaryQuery, usageTimeseriesQuery, usageUsersQuery, usageGroupsQuery, usageProjectsQuery, usageCsvUrl } from "./api";


export const periods = [
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
  { id: '12m', label: '12 months', days: 365 },
];
const default_period = '30d';

export const readFilters = search => {
  const params = new URLSearchParams(search);
  const period = periods.find(p => p.id === params.get('period')) ? params.get('period') : default_period;
  return { period, project: params.get('project') ?? '' };
};

const writeFilters = ({ period, project }) => {
  const params = new URLSearchParams();
  if (period && period !== default_period) params.set('period', period);
  if (project) params.set('project', project);
  const query = params.toString();
  history.replace(`/admin/usage${query ? `?${query}` : ''}`);
};

// The API's parameters for a period: the last N days, until today. Buckets are days, weeks past 90 days.
// The server counts in UTC days: so do we, else the evening's events are missing west of Greenwich.
export const paramsFor = ({ period, project }, now = DateTime.utc()) => {
  const { days } = periods.find(p => p.id === period) ?? periods[1];
  return {
    since: now.minus({ days: days - 1 }).toISODate(),
    until: now.toISODate(),
    project: project || undefined,
    bucket: days > 90 ? 'week' : 'day',
  };
};


const Counts = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 20px;

  .count {
    font-size: 28px;
    font-weight: 600;
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
  }
  .previous {
    font-size: 12px;
    margin-left: 6px;
    font-weight: normal;
  }
`;

// The headline numbers, and what they were the period before
const tiles = [
  { section: 'People', items: [
    { key: 'users', label: 'Active users' },
    { key: 'web_users', label: 'In the web app' },
    { key: 'cli_users', label: 'With the CLI' },
    { key: 'new_users', label: 'New users' },
  ] },
  { section: 'Looking', items: [
    { key: 'commits_viewed', label: 'Commits looked at' },
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'outputs_opened', label: 'Outputs opened' },
    { key: 'image_viewer_uses', label: 'Image viewer features used' },
  ] },
  { section: 'Doing', items: [
    { key: 'batches_started', label: 'Batches started by people' },
    { key: 'cli_commands', label: 'qa commands' },
    { key: 'exports', label: 'Exports' },
    { key: 'milestones', label: 'Milestones saved' },
    { key: 'ci_runs', label: 'Runs from the CI' },
  ] },
];

const kind_labels = { tuning: 'tuning', automated_tuning: 'automated tuning', run_tests: 'run tests', redo: 'redo', cli: 'qa batch' };

const Tile = ({ label, value, previous, detail }) => <Card compact>
  <div className="count">
    {value === undefined || value === null ? '—' : formatNumber(value)}
    {typeof previous === 'number' && <span className={`previous ${Classes.TEXT_MUTED}`} title="The period before">vs {formatNumber(previous)}</span>}
  </div>
  <div className={Classes.TEXT_MUTED}>{label}</div>
  {detail && <div className={Classes.TEXT_MUTED} style={{ fontSize: 12, marginTop: 4 }}>{detail}</div>}
</Card>;

const Summary = ({ counts, previous }) => tiles.map(({ section, items }) => <section key={section} aria-label={section}>
  <h4 className={Classes.HEADING}>{section}</h4>
  <Counts>
    {items.map(({ key, label }) => {
      const by_kind = key === 'batches_started' ? counts?.batches_started_by_kind : null;
      const detail = by_kind && Object.entries(by_kind).filter(([, n]) => n > 0).map(([kind, n]) => `${formatNumber(n)} ${kind_labels[kind] ?? kind}`).join(', ');
      return <Tile key={key} label={label} value={counts?.[key]} previous={previous?.[key]} detail={detail || undefined}/>;
    })}
  </Counts>
</section>);


// Charts: plain SVG, the data is small (a point per day or week)
const chart_colors = [Colors.BLUE3, Colors.VIOLET3, Colors.GREEN3, Colors.ORANGE3];
const width = 600, height = 160, pad = { left: 36, right: 8, top: 8, bottom: 22 };

const bucket_label = (start, bucket) => {
  const date = DateTime.fromISO(start);
  return date.isValid ? (bucket === 'week' ? `w/c ${date.toFormat('MMM d')}` : date.toFormat('MMM d')) : start;
};

const Legend = ({ series }) => <div className={Classes.TEXT_MUTED} style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 12, marginTop: 4 }}>
  {series.map(s => <span key={s.key} style={{ whiteSpace: 'nowrap' }}>
    <span aria-hidden="true" style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: s.color, marginRight: 4 }}/>{s.label}
  </span>)}
</div>;

const Axes = ({ buckets, max, bucket }) => {
  // small maxima and short periods repeat ticks
  const ticks = [...new Set([0, Math.round(max / 2), max])];
  const x_indices = [...new Set(buckets.length <= 1 ? [0] : [0, Math.floor((buckets.length - 1) / 2), buckets.length - 1])];
  const x = i => pad.left + (buckets.length <= 1 ? 0 : i * (width - pad.left - pad.right) / (buckets.length - 1));
  return <g className={Classes.TEXT_MUTED} fontSize={11} fill="currentColor">
    {ticks.map(t => <text key={t} x={pad.left - 4} y={pad.top + (height - pad.top - pad.bottom) * (1 - t / max) + 4} textAnchor="end">{formatNumber(t)}</text>)}
    {x_indices.map(i => <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === buckets.length - 1 ? 'end' : 'middle'}>{bucket_label(buckets[i].start, bucket)}</text>)}
    <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} stroke="currentColor" strokeOpacity={0.3}/>
  </g>;
};

// series: [{key, label, color}], one line each, over the buckets
export const LineChart = ({ title, buckets, series, bucket }) => {
  if (!buckets?.length) return null;
  const max = Math.max(1, ...buckets.flatMap(b => series.map(s => b[s.key] ?? 0)));
  const x = i => pad.left + (buckets.length <= 1 ? 0 : i * (width - pad.left - pad.right) / (buckets.length - 1));
  const y = v => pad.top + (height - pad.top - pad.bottom) * (1 - (v ?? 0) / max);
  return <figure style={{ margin: 0, minWidth: 0 }}>
    <figcaption className={Classes.HEADING} style={{ fontSize: 14, marginBottom: 4 }}>{title}</figcaption>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title} style={{ width: '100%', height: 'auto', display: 'block' }}>
      <Axes buckets={buckets} max={max} bucket={bucket}/>
      {series.map(s => <polyline
        key={s.key}
        data-testid={`line-${s.key}`}
        fill="none"
        stroke={s.color}
        strokeWidth={2}
        strokeLinejoin="round"
        points={buckets.map((b, i) => `${x(i)},${y(b[s.key])}`).join(' ')}
      >
        <title>{s.label}: {buckets.map(b => `${bucket_label(b.start, bucket)} ${formatNumber(b[s.key] ?? 0)}`).join(', ')}</title>
      </polyline>)}
    </svg>
    <Legend series={series}/>
  </figure>;
};

// series side by side in each bucket
export const BarChart = ({ title, buckets, series, bucket }) => {
  if (!buckets?.length) return null;
  const max = Math.max(1, ...buckets.flatMap(b => series.map(s => b[s.key] ?? 0)));
  const slot = (width - pad.left - pad.right) / buckets.length;
  const bar = Math.max(1, (slot * 0.8) / series.length);
  const y = v => pad.top + (height - pad.top - pad.bottom) * (1 - (v ?? 0) / max);
  return <figure style={{ margin: 0, minWidth: 0 }}>
    <figcaption className={Classes.HEADING} style={{ fontSize: 14, marginBottom: 4 }}>{title}</figcaption>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title} style={{ width: '100%', height: 'auto', display: 'block' }}>
      <Axes buckets={buckets} max={max} bucket={bucket}/>
      {buckets.map((b, i) => series.map((s, j) => {
        const value = b[s.key] ?? 0;
        return <rect
          key={`${b.start}-${s.key}`}
          data-testid={`bar-${s.key}`}
          x={pad.left + i * slot + slot * 0.1 + j * bar}
          y={y(value)}
          width={bar}
          height={height - pad.bottom - y(value)}
          fill={s.color}
        >
          <title>{bucket_label(b.start, bucket)}: {formatNumber(value)} {s.label.toLowerCase()}</title>
        </rect>;
      }))}
    </svg>
    <Legend series={series}/>
  </figure>;
};

const Charts = ({ params }) => {
  const { data, isPending, error, refetch } = useQuery(usageTimeseriesQuery(params, params.bucket));
  if (isPending) return <Loading label="Loading the trends"/>;
  if (error) return <AdminError error={error} refetch={refetch} what="the trends"/>;
  const buckets = data?.buckets ?? [];
  // the server fills the empty buckets: no events is every value at 0
  const empty = buckets.every(b => Object.entries(b).every(([key, value]) => key === 'start' || !value));
  if (empty) return <p className={Classes.TEXT_MUTED}>No usage events in this period.</p>;
  const per = params.bucket === 'week' ? 'per week' : 'per day';
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 24, marginBottom: 24 }}>
    <LineChart title={`Active users and commits looked at, ${per}`} buckets={buckets} bucket={params.bucket} series={[
      { key: 'web_users', label: 'Users in the web app', color: chart_colors[0] },
      { key: 'cli_users', label: 'Users with the CLI', color: chart_colors[1] },
      { key: 'commits_viewed', label: 'Commits looked at', color: chart_colors[2] },
    ]}/>
    <BarChart title={`Batches started and qa commands, ${per}`} buckets={buckets} bucket={params.bucket} series={[
      { key: 'batches_started', label: 'Batches started', color: chart_colors[0] },
      { key: 'cli_commands', label: 'qa commands', color: chart_colors[3] },
    ]}/>
  </div>;
};


// Leaderboards. Admin-only: users see only their own numbers (Settings → Activity).
const medals = ['#d99e0b', '#a7b6c2', '#c87619'];
const Rank = ({ rank }) => <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: medals[rank - 1] }}>{rank}</td>;
const Num = ({ value }) => <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatNumber(value)}</td>;

const TableHeader = ({ title, count, noun, csv }) => <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
  <h4 className={Classes.HEADING} style={{ margin: 0 }}>{title}</h4>
  {typeof count === 'number' && <span className={Classes.TEXT_MUTED}>{formatNumber(count)} {noun}{count === 1 ? '' : 's'}</span>}
  <AnchorButton size="small" variant="minimal" icon="download" text="CSV" href={csv} download/>
</div>;

const Table = ({ query, title, noun, csv, columns, rows, rowKey, empty }) => {
  const { data, isPending, error, refetch } = useQuery(query);
  const list = rows(data) ?? [];
  return <section aria-label={title} style={{ marginBottom: 28, minWidth: 0 }}>
    <TableHeader title={title} count={data ? list.length : undefined} noun={noun} csv={csv}/>
    {isPending && <Loading label={`Loading the ${noun}s`}/>}
    {error && <AdminError error={error} refetch={refetch} what={`the ${noun}s`}/>}
    {data && (list.length === 0
      ? <p className={Classes.TEXT_MUTED}>{empty}</p>
      : <div style={{ overflowX: 'auto' }}>
        <HTMLTable compact striped style={{ width: '100%' }}>
          <thead><tr><th style={{ width: 36 }}>#</th>{columns.map(c => <th key={c.label} style={c.numeric ? { textAlign: 'right' } : undefined}>{c.label}</th>)}</tr></thead>
          <tbody>
            {list.slice(0, 25).map((row, i) => <tr key={rowKey(row)}>
              <Rank rank={i + 1}/>
              {columns.map(c => c.numeric ? <Num key={c.label} value={row[c.key]}/> : <td key={c.label}>{c.render(row)}</td>)}
            </tr>)}
          </tbody>
        </HTMLTable>
        {list.length > 25 && <p className={Classes.TEXT_MUTED} style={{ marginTop: 8 }}>The 25 most active, of {formatNumber(list.length)}: the CSV has them all.</p>}
      </div>)}
  </section>;
};

const Projects = ({ ids }) => <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
  {(ids ?? []).map(id => <Tag key={id} minimal><Link to={project_url(id)} style={{ color: 'inherit' }}>{id}</Link></Tag>)}
</span>;

const statuses = {
  active: { label: 'Active', intent: Intent.SUCCESS, title: 'People looked at its results' },
  ci_only: { label: 'CI only', intent: Intent.WARNING, title: 'The CI sends runs, but nobody looked at them in this period' },
  quiet: { label: 'Quiet', intent: Intent.NONE, title: 'No runs and no views in this period, some in the period before' },
  new: { label: 'New', intent: Intent.PRIMARY, title: 'Its first events are in this period' },
};
const Status = ({ status }) => {
  const s = statuses[status] ?? { label: status, intent: Intent.NONE };
  return <Tooltip content={s.title} disabled={!s.title}><Tag minimal intent={s.intent}>{s.label}</Tag></Tooltip>;
};

const Leaderboards = ({ params }) => <>
  <Table
    query={usageUsersQuery(params)}
    title="Users" noun="user"
    csv={usageCsvUrl('users', params)}
    rows={data => data?.users}
    rowKey={row => row.user_id ?? `name:${row.user_name}`}
    empty="Nobody used QA-Board in this period."
    columns={[
      { label: 'User', render: row => <>
        {row.user_id ? <Link to={`/admin/users/${row.user_id}`}>{row.full_name || row.user_name}</Link> : row.user_name}
        {row.verified === false && <Tooltip content="Only seen from the CLI, without signing in: the user name is what their machine says"><Tag minimal style={{ marginLeft: 6 }}>unverified</Tag></Tooltip>}
      </> },
      { label: 'Active days', key: 'active_days', numeric: true },
      { label: 'Commits looked at', key: 'commits_viewed', numeric: true },
      { label: 'Batches started', key: 'batches_started', numeric: true },
      { label: 'qa commands', key: 'cli_commands', numeric: true },
      { label: 'Last seen', render: row => <Time iso={row.last_seen_at}/> },
      { label: 'Projects', render: row => <Projects ids={row.projects}/> },
    ]}
  />
  <Table
    query={usageGroupsQuery(params)}
    title="Groups" noun="group"
    csv={usageCsvUrl('groups', params)}
    rows={data => data?.groups}
    rowKey={row => row.group_id}
    empty="No group had active members in this period. Groups come from single sign-on, LDAP, or Admin → Groups."
    columns={[
      { label: 'Group', render: row => <Link to={`/admin/groups/${row.group_id}`}>{row.name}</Link> },
      { label: 'Active members', render: row => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatNumber(row.active_members)} / {formatNumber(row.members)}</span> },
      { label: 'Active days', key: 'active_days', numeric: true },
      { label: 'Commits looked at', key: 'commits_viewed', numeric: true },
      { label: 'Batches started', key: 'batches_started', numeric: true },
      { label: 'qa commands', key: 'cli_commands', numeric: true },
    ]}
  />
  <Table
    query={usageProjectsQuery(params)}
    title="Projects" noun="project"
    csv={usageCsvUrl('projects', params)}
    rows={data => data?.projects}
    rowKey={row => row.project_id}
    empty="No project had runs or views in this period."
    columns={[
      { label: 'Project', render: row => <Link to={project_url(row.project_id)}>{row.project_id}</Link> },
      { label: 'Status', render: row => <Status status={row.status}/> },
      { label: 'People', key: 'people', numeric: true },
      { label: 'Commits looked at', key: 'commits_viewed', numeric: true },
      { label: 'Outputs opened', key: 'outputs_opened', numeric: true },
      { label: 'Batches started', key: 'batches_started', numeric: true },
      { label: 'qa commands', key: 'cli_commands', numeric: true },
      { label: 'CI runs', key: 'ci_runs', numeric: true },
    ]}
  />
</>;


const Filters = ({ filters, setFilters }) => {
  // the URL changes a moment after users stop typing
  const [project, setProject] = useState(filters.project);
  // the URL changed by itself (back, forward, a link): the input follows
  const [from_url, setFromUrl] = useState(filters.project);
  if (from_url !== filters.project) {
    setFromUrl(filters.project);
    setProject(filters.project);
  }
  const latest = useRef(filters);
  useEffect(() => { latest.current = filters; });
  useEffect(() => {
    if (project === latest.current.project) return;
    const timer = setTimeout(() => writeFilters({ ...latest.current, project }), 300);
    return () => clearTimeout(timer);
  }, [project]);
  return <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 20 }}>
    <ButtonGroup aria-label="Period">
      {periods.map(p => <Button key={p.id} text={p.label} active={filters.period === p.id} aria-pressed={filters.period === p.id} onClick={() => setFilters({ period: p.id })}/>)}
    </ButtonGroup>
    <InputGroup
      leftIcon="projects"
      placeholder="Project or product…"
      aria-label="Filter by project"
      value={project}
      onChange={e => setProject(e.target.value)}
      style={{ width: 260 }}
      rightElement={project ? <Button variant="minimal" icon="cross" aria-label="Clear the project filter" onClick={() => { setProject(''); setFilters({ project: '' }); }}/> : undefined}
    />
  </div>;
};


export const Usage = () => {
  const location = useLocation();
  const filters = readFilters(location.search);
  const setFilters = changes => writeFilters({ ...filters, ...changes });
  const params = paramsFor(filters);
  const summary = useQuery(usageSummaryQuery(params));
  return <section aria-label="Usage">
    <p className={Classes.TEXT_MUTED} style={{ marginTop: 0 }}>
      What people do with QA-Board: from the web app, and from the <code>qa</code> CLI on their machines (never the CI's).
      The CSV links export each table; the <code>usage_events_v</code> and <code>usage_daily_v</code> SQL views are for dashboards.
    </p>
    <Filters filters={filters} setFilters={setFilters}/>
    {summary.isPending && <Loading label="Loading the usage"/>}
    {summary.error && <AdminError error={summary.error} refetch={summary.refetch} what="the usage"/>}
    {summary.data && <Summary counts={summary.data.counts} previous={summary.data.previous_counts}/>}
    {summary.data && <>
      <Charts params={params}/>
      <Leaderboards params={params}/>
    </>}
  </section>;
};

export default Usage;
