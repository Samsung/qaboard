// Trends over a branch's commits, drawn from what the metrics' definitions say (model.js), without configuration:
// - totals and their parts (tests: passed, failed, skipped...) as columns per commit, and each test over the commits,
// - groups of metrics (benchmarks) as a summary per group, on the same scope, and the metrics that moved the most.
// Standalone: it knows nothing of the app. The app gives the commits as points (model.js), a way to read a
// commit's test reports (`loadTests`), and where a click on a commit goes (`onSelect`, `point.href`).
import { useEffect, useMemo, useState } from 'react';
import { Button, HTMLSelect, Icon, InputGroup, ProgressBar, Switch, Tag } from '@blueprintjs/core';

import {
  findGroup, movers, countDirections, groupIndex, groupDirection, changeOf,
  formatNumber, formatValue, formatRatio, formatDelta, plural, samplePoints, trendsOf, hasTrends,
} from './model';
import { buildTestHistory, VIEWS, STATUS_NAMES, packagesOf, inPackage, commonPackage } from './testHistory';
import { Columns, Line, Sparkline, StatusStrip } from './charts';
import './trends.css';

export const MAX_REPORTS = 100;

export const useTrends = (points, definitions, run_filter) => useMemo(
  () => trendsOf(points, definitions, { run_filter }),
  [points, definitions, run_filter],
);

// The colors of the parts of a total, by intent: two parts with the same intent (failed, errors) get two colors
const INTENT_COLORS = {
  success: ['var(--trends-success)'],
  none: ['var(--trends-none)', 'var(--trends-none-2)'],
  warning: ['var(--trends-warning)'],
  danger: ['var(--trends-danger)', 'var(--trends-danger-2)'],
};
function layersOf(parts) {
  const used = {};
  return parts.map(series => {
    const intent = INTENT_COLORS[series.definition.intent] ? series.definition.intent : 'none';
    const index = used[intent] ?? 0;
    used[intent] = index + 1;
    const colors = INTENT_COLORS[intent];
    return { key: series.key, label: series.label, values: series.values, intent, color: colors[Math.min(index, colors.length - 1)] };
  });
}
const is_problem = layer => layer.intent === 'danger' || layer.intent === 'warning';
const last_value = values => values.reduce((found, v) => v ?? found, null);
const first_value = values => values.find(v => v !== null && v !== undefined) ?? null;
const sum_at = (layers, i) => layers.reduce((sum, layer) => sum + (layer.values[i] ?? 0), 0);

const CommitLink = ({ point }) => point?.href
  ? <a href={point.href} className="qa-trends-commit"><code>{point.label}</code></a>
  : <code className="qa-trends-commit">{point?.label}</code>;

// better, worse or only different, with an arrow: never color alone
const Change = ({ ratio, direction }) => {
  if (direction === 'same' || !direction) return <span className="qa-trends-muted">{formatRatio(ratio)}</span>;
  return <span className={`qa-trends-change qa-trends-${direction}`}>
    <Icon icon={ratio >= 1 ? 'arrow-up' : 'arrow-down'} size={12}/>
    {formatRatio(ratio)}
  </span>;
};
const directionOfRatio = (ratio, smaller_is_better) => {
  if (!Number.isFinite(ratio) || Math.abs(ratio - 1) < 0.005) return 'same';
  if (smaller_is_better === undefined || smaller_is_better === null) return 'changed';
  return (ratio < 1) === smaller_is_better ? 'better' : 'worse';
};

const Legend = ({ layers }) => <div className="qa-trends-legend">
  {layers.map(layer => <span key={layer.key}><span className="qa-trends-swatch" style={{ background: layer.color }}/>{layer.label}</span>)}
</div>;


// --- Tiles: the headline numbers, above a list of commits ---
const Tile = ({ label, value, detail, spark, intent, onClick }) => {
  const Box = onClick ? 'button' : 'div';
  return <Box className={`qa-trends-tile${intent ? ` qa-trends-tile-${intent}` : ''}`} onClick={onClick} type={onClick ? 'button' : undefined}>
    <span className="qa-trends-tile-label">{label}</span>
    <span className="qa-trends-tile-value">{value}</span>
    <span className="qa-trends-tile-detail">{detail}</span>
    {spark && <span className="qa-trends-tile-spark">{spark}</span>}
  </Box>;
};

export function TrendsTiles({ points, trends, onOpen, max = 6 }) {
  const count = points.length;
  const tiles = [];
  for (const composition of trends.composed) {
    const layers = layersOf(composition.parts);
    const total = composition.total?.values ?? points.map((_, i) => layers.some(l => l.values[i] !== null) ? sum_at(layers, i) : null);
    const first = first_value(total), last = last_value(total);
    if (last === null) continue;
    const anchor = `trends-${composition.key}`;
    tiles.push(<Tile
      key={composition.key}
      label={composition.label}
      value={formatNumber(last)}
      detail={last === first ? `unchanged over ${plural(count, 'commit')}` : `${formatDelta(last - first)} over ${plural(count, 'commit')}`}
      spark={<Sparkline values={total}/>}
      onClick={onOpen && (() => onOpen(anchor))}
    />);
    const problems = layers.filter(is_problem);
    if (problems.length > 0) {
      const values = points.map((_, i) => total[i] === null ? null : sum_at(problems, i));
      const now = last_value(values) ?? 0;
      const commits_with = values.filter(v => v > 0).length;
      tiles.push(<Tile
        key={`${composition.key}-problems`}
        label={`${composition.label} not passing`}
        value={formatNumber(now)}
        intent={now > 0 ? 'danger' : 'success'}
        detail={commits_with === 0 ? 'none in these commits' : `in ${plural(commits_with, 'commit')} of ${count}`}
        spark={<Sparkline values={values} color={now > 0 ? 'var(--trends-danger)' : 'var(--trends-line)'}/>}
        onClick={onOpen && (() => onOpen(anchor))}
      />);
    }
    for (const extra of composition.extras.slice(0, 1)) {
      const change = changeOf(extra);
      tiles.push(<Tile
        key={extra.key}
        label={extra.label}
        value={formatValue(last_value(extra.values), extra.definition)}
        detail={change ? <><Change ratio={change.ratio} direction={change.direction}/> over {plural(count, 'commit')}</> : null}
        spark={<Sparkline values={extra.values}/>}
        onClick={onOpen && (() => onOpen(anchor))}
      />);
    }
  }
  for (const node of trends.tree.children) {
    const index = groupIndex(node.all, count);
    const ratio = last_value(index.values);
    const counts = countDirections(movers(index.scope.common));
    const direction = directionOfRatio(ratio, groupDirection(index.members));
    tiles.push(<Tile
      key={node.name}
      label={node.name}
      value={ratio === null ? formatNumber(node.all.length) : <Change ratio={ratio} direction={direction}/>}
      intent={direction === 'worse' ? 'danger' : undefined}
      detail={<>{counts.worse} worse, {counts.better} better of {formatNumber(index.scope.common.length)}</>}
      spark={<Sparkline values={index.values} domain={ratio === null ? undefined : [Math.min(1, ...index.values.filter(v => v !== null)), Math.max(1, ...index.values.filter(v => v !== null))]}/>}
      onClick={onOpen && (() => onOpen(`trends-${node.name}`))}
    />);
  }
  if (tiles.length === 0) return null;
  return <div className="qa-trends qa-trends-tiles">{tiles.slice(0, max)}</div>;
}


// --- Each test over the commits ---
const STRIP_COLORS = [null, 'var(--trends-success-soft)', 'var(--trends-none)', 'var(--trends-warning)', 'var(--trends-danger)', 'var(--trends-danger-2)'];
const seconds = value => value === null ? '–' : value >= 100 ? `${value.toFixed(0)} s` : value >= 1 ? `${value.toFixed(1)} s` : `${(value * 1000).toFixed(0)} ms`;

// The reports of the commits, read a few at a time: {reports, done, failed}
function useReports(points, loadTests) {
  const [state, setState] = useState({ key: null, reports: [], done: 0 });
  useEffect(() => {
    let cancelled = false;
    const reports = Array.from({ length: points.length }, () => null);
    let done = 0, next = 0;
    const worker = async () => {
      while (!cancelled && next < points.length) {
        const i = next++;
        try {
          reports[i] = await loadTests(points[i]);
        } catch {
          reports[i] = null;
        }
        done += 1;
        if (!cancelled && (done === points.length || done % 5 === 0)) setState({ key: points, reports: [...reports], done });
      }
    };
    Promise.all(Array.from({ length: 4 }, worker));
    return () => { cancelled = true; };
  }, [points, loadTests]);
  return state.key === points ? state : { reports: [], done: 0 };
}

const TestFact = ({ view, test, points, loaded }) => {
  const after = index => loaded.filter(i => i >= index).length;
  if (view === 'failing') return <>since <CommitLink point={points[test.failing_since]}/> <span className="qa-trends-muted">· {plural(after(test.failing_since), 'report')}</span></>;
  if (view === 'flaky') return <>changed {test.flips} times <span className="qa-trends-muted">· failed in {test.failures} of {loaded.length}</span></>;
  if (view === 'slower') return <>{seconds(test.last_time / test.slowdown)} → {seconds(test.last_time)} <span className="qa-trends-muted">· ×{test.slowdown.toFixed(1)}</span></>;
  if (view === 'fixed') return <>passes since <CommitLink point={points[test.fixed_at]}/></>;
  if (view === 'added') return <>since <CommitLink point={points[test.added_at]}/></>;
  if (view === 'removed') return <>gone since <CommitLink point={points[test.removed_at]}/></>;
  return <>{seconds(test.last_time)}</>;
};

const PAGE = 25;
export function TestHistory({ points: all_points, loadTests }) {
  const points = useMemo(() => samplePoints(all_points, MAX_REPORTS), [all_points]);
  const { reports, done } = useReports(points, loadTests);
  const ready = done === points.length && points.length > 0;
  const history = useMemo(() => ready ? buildTestHistory(reports) : null, [ready, reports]);
  const [view_id, setView] = useState(null);
  const [chosen_prefix, setPrefix] = useState(null);
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PAGE);
  // without a choice: the deepest package all the tests share ("tests" for tests.codec..., tests.maps...)
  const shared_prefix = useMemo(() => history ? commonPackage(history.tests) : [], [history]);
  const prefix = chosen_prefix ?? shared_prefix;

  if (!ready) return <div className="qa-trends-loading">
    <span>Reading the test reports of {plural(points.length, 'commit')}… {done}/{points.length}</span>
    <ProgressBar value={points.length ? done / points.length : 0} animate={false} stripes={false} intent="primary"/>
  </div>;
  if (history.loaded.length < 2)
    return <p className="qa-trends-muted">Each test's history needs test reports in at least two commits: {history.loaded.length === 0 ? 'none was found' : 'one was found'}.</p>;

  const in_package = history.tests.filter(inPackage(prefix));
  const counts = Object.fromEntries(VIEWS.map(v => [v.id, in_package.filter(v.is).length]));
  const view = VIEWS.find(v => v.id === view_id) ?? VIEWS.find(v => counts[v.id] > 0) ?? VIEWS[0];
  const packages = packagesOf(history.tests, prefix);
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = in_package.filter(view.is).filter(t => words.every(w => t.id.toLowerCase().includes(w))).sort(view.sort);
  const select = id => { setView(id); setLimit(PAGE); };
  const open = path => { setPrefix(path); setLimit(PAGE); };

  return <div className="qa-trends-tests">
    <div className="qa-trends-toolbar">
      <div className="qa-trends-chips" role="tablist" aria-label="Tests to show">
        {VIEWS.map(v => <button key={v.id} type="button" role="tab" aria-selected={v.id === view.id} className="qa-trends-chip" onClick={() => select(v.id)}>
          {v.label} <span className="qa-trends-chip-count">{counts[v.id].toLocaleString('en')}</span>
        </button>)}
      </div>
      <InputGroup small leftIcon="search" placeholder="Filter tests" value={search} onChange={e => { setSearch(e.target.value); setLimit(PAGE); }} className="qa-trends-search"/>
    </div>
    <div className="qa-trends-path">
      <button type="button" className="qa-trends-crumb" onClick={() => open(shared_prefix)} disabled={prefix.length === shared_prefix.length}>All tests</button>
      {prefix.slice(shared_prefix.length).map((name, k) => <span key={k}>
        <span className="qa-trends-muted"> / </span>
        <button type="button" className="qa-trends-crumb" onClick={() => open(prefix.slice(0, shared_prefix.length + k + 1))} disabled={shared_prefix.length + k === prefix.length - 1}>{name}</button>
      </span>)}
      {packages.length > 1 && <span className="qa-trends-packages">
        {packages.map(p => <button key={p.name} type="button" className="qa-trends-package" onClick={() => open(p.path)} title={`${plural(p.total, 'test')} in ${p.path.join('.')}`}>
          {p.name}
          {p.counts[view.id] > 0 && <span className="qa-trends-chip-count">{p.counts[view.id]}</span>}
        </button>)}
      </span>}
    </div>
    {rows.length === 0
      ? <p className="qa-trends-muted qa-trends-empty">{search ? 'No test matches.' : view.empty}</p>
      : <table className="qa-trends-table">
        <thead><tr>
          <th>Test</th>
          <th>{plural(history.loaded.length, 'report')}, oldest first{points.length < all_points.length ? ` (of ${all_points.length} commits)` : ''}</th>
          <th>{view.label}</th>
        </tr></thead>
        <tbody>{rows.slice(0, limit).map(test => <tr key={test.id}>
          <td className="qa-trends-test-name" title={test.id}>
            <span className="qa-trends-muted">{test.path.slice(prefix.length, -1).join('.')}{test.path.length - 1 > prefix.length ? '.' : ''}</span>{test.name}
          </td>
          <td><StatusStrip statuses={test.statuses} colors={STRIP_COLORS} names={STATUS_NAMES} points={points} width={280}/></td>
          <td className="qa-trends-fact"><TestFact view={view.id} test={test} points={points} loaded={history.loaded}/></td>
        </tr>)}</tbody>
      </table>}
    {rows.length > limit && <Button minimal small icon="chevron-down" onClick={() => setLimit(limit + 4 * PAGE)}>
      {plural(rows.length - limit, 'more test')}
    </Button>}
  </div>;
}


// --- A total and its parts: tests ---
export function CompositionSection({ composition, points, loadTests, onSelect }) {
  const [hover, setHover] = useState(null);
  const layers = useMemo(() => layersOf(composition.parts), [composition]);
  const volume = layers.filter(l => !is_problem(l));
  const problems = layers.filter(is_problem);
  const total = composition.total?.values ?? points.map((_, i) => sum_at(layers, i));
  const first = first_value(total), last = last_value(total);
  const failing_now = sum_at(problems, total.reduce((found, v, i) => v !== null ? i : found, 0));
  const shared = { points, hover, onHover: setHover, onSelect };
  return <section className="qa-trends-section" id={`trends-${composition.key}`}>
    <header className="qa-trends-header">
      <h3>{composition.path.length > 1 ? composition.path.join(' / ') : composition.label}</h3>
      <span className="qa-trends-muted">
        {formatNumber(last)} in the latest commit{first !== null && last !== first ? `, ${formatDelta(last - first)} over ${plural(points.length, 'commit')}` : ''}
        {problems.length > 0 && <> · {failing_now > 0 ? <strong className="qa-trends-worse">{formatNumber(failing_now)} not passing</strong> : 'all passing'}</>}
      </span>
    </header>
    <div className="qa-trends-chart-title">{composition.label} per commit <Legend layers={[...volume].reverse()}/></div>
    <Columns {...shared} layers={volume} height={130} formatValue={formatNumber} label={`${composition.label} per commit`}/>
    {problems.length > 0 && <>
      <div className="qa-trends-chart-title">Not passing <Legend layers={[...problems].reverse()}/></div>
      <Columns {...shared} layers={problems} height={96} formatValue={formatNumber} label={`${composition.label} not passing, per commit`}/>
    </>}
    {composition.extras.map(extra => <div key={extra.key}>
      <div className="qa-trends-chart-title">{extra.label}</div>
      <Line {...shared} values={extra.values} height={96} name={extra.label} formatValue={v => formatValue(v, extra.definition)} label={`${extra.label} per commit`}/>
    </div>)}
    {loadTests && <>
      <div className="qa-trends-chart-title qa-trends-subtitle">Each test over the commits</div>
      <TestHistory points={points} loadTests={loadTests}/>
    </>}
  </section>;
}


// --- A group of metrics: benchmarks ---
const DIRECTION_FILTERS = [
  { id: 'all', label: 'All that moved' },
  { id: 'worse', label: 'Worse' },
  { id: 'better', label: 'Better' },
  { id: 'added', label: 'Added' },
  { id: 'removed', label: 'Removed' },
];
const percent = ratio => formatRatio(ratio);

function ScopeLine({ scope, same_scope, onChange, noun }) {
  const changed = scope.added.length + scope.removed.length + scope.partial.length;
  const total = scope.common.length + changed;
  return <div className="qa-trends-scope">
    <span>
      <strong>{plural(total, noun)}</strong>
      {changed === 0
        ? <span className="qa-trends-muted"> · the same in all {scope.measured.length} commits that measured them</span>
        : <span className="qa-trends-muted"> · {formatNumber(scope.common.length)} in all {scope.measured.length} commits that measured them
          {scope.added.length > 0 && ` · ${scope.added.length} added`}
          {scope.removed.length > 0 && ` · ${scope.removed.length} removed`}
          {scope.partial.length > 0 && ` · ${scope.partial.length} not in every commit`}</span>}
    </span>
    {changed > 0 && <Switch
      checked={same_scope}
      onChange={e => onChange(e.target.checked)}
      label="Summarize the same scope only"
      title="On: the summary is over the metrics every commit has. Off: over whatever each commit measured, which moves when metrics are added or removed."
      style={{ margin: 0 }}
    />}
  </div>;
}

export function GroupSection({ node, points, onSelect }) {
  const count = points.length;
  const [path, setPath] = useState([]);
  const [same_scope, setSameScope] = useState(true);
  const [baseline, setBaseline] = useState('first');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(15);
  const [hover, setHover] = useState(null);
  const current = findGroup(node, path) ?? node;
  const index = useMemo(() => groupIndex(current.all, count, { same_scope }), [current, count, same_scope]);
  const direction = groupDirection(index.members);
  const children = useMemo(() => current.children.map(child => {
    const child_index = groupIndex(child.all, count, { same_scope });
    return { node: child, index: child_index, ratio: last_value(child_index.values), direction: groupDirection(child_index.members) };
  }), [current, count, same_scope]);
  // one scale for the children's charts: they compare at a glance
  const child_values = children.flatMap(c => c.index.values.filter(v => v !== null));
  const child_domain = child_values.length ? [Math.min(1, ...child_values), Math.max(1, ...child_values)] : [0.9, 1.1];
  const pad = (child_domain[1] - child_domain[0] || 0.1) * 0.1;
  const all_movers = useMemo(() => movers(current.all, { baseline }), [current, baseline]);
  const counts = countDirections(all_movers);
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = series => words.every(w => series.label.toLowerCase().includes(w) || series.key.includes(w));
  let rows;
  if (filter === 'added' || filter === 'removed')
    rows = index.scope[filter].filter(matches).map(series => ({ series, change: null }));
  else
    rows = all_movers.filter(row => (filter === 'all' || row.change.direction === filter) && matches(row.series));
  const ratio = last_value(index.values);
  const open = next => { setPath(next); setLimit(15); };
  const noun = 'metric';
  const shared = { points, hover, onHover: setHover, onSelect };

  return <section className="qa-trends-section" id={`trends-${node.name}`}>
    <header className="qa-trends-header">
      <h3>
        <button type="button" className="qa-trends-crumb" onClick={() => open([])} disabled={path.length === 0}>{node.name}</button>
        {path.map((name, depth) => <span key={depth}>
          <span className="qa-trends-muted"> / </span>
          <button type="button" className="qa-trends-crumb" onClick={() => open(path.slice(0, depth + 1))} disabled={depth === path.length - 1}>{name}</button>
        </span>)}
      </h3>
      {ratio !== null && <span className="qa-trends-muted">
        <Change ratio={ratio} direction={directionOfRatio(ratio, direction)}/> over {plural(count, 'commit')}
        {' '}· {counts.worse} worse, {counts.better} better
      </span>}
    </header>
    <ScopeLine scope={index.scope} same_scope={same_scope} onChange={setSameScope} noun={noun}/>
    {index.members.length > 0 && <>
      <div className="qa-trends-chart-title">
        Geometric mean against the first commit
        <span className="qa-trends-muted"> · {same_scope ? `the ${formatNumber(index.members.length)} in every commit` : 'whatever each commit measured'}</span>
      </div>
      <Line
        {...shared} values={index.values} height={130} reference={1} name="Mean change" formatValue={percent}
        extra={same_scope ? undefined : i => `over ${index.counts[i]}`}
        label={`${current.name}: geometric mean of the metrics against the first commit`}
      />
    </>}
    {children.length > 1 && <div className="qa-trends-multiples">
      {children.map(child => <button key={child.node.name} type="button" className="qa-trends-multiple" onClick={() => open(child.node.path.slice(node.path.length))}>
        <span className="qa-trends-multiple-head">
          <strong>{child.node.name}</strong>
          <span className="qa-trends-muted">{formatNumber(child.node.all.length)}</span>
          {child.ratio !== null && <Change ratio={child.ratio} direction={directionOfRatio(child.ratio, child.direction)}/>}
        </span>
        <Sparkline values={child.index.values} width={200} height={44} domain={[child_domain[0] - pad, child_domain[1] + pad]}/>
      </button>)}
    </div>}
    <div className="qa-trends-toolbar">
      <div className="qa-trends-chips" role="tablist" aria-label="Metrics to show">
        {DIRECTION_FILTERS.map(f => {
          const n = f.id === 'all' ? all_movers.length : f.id === 'added' || f.id === 'removed' ? index.scope[f.id].length : counts[f.id];
          return <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className="qa-trends-chip" onClick={() => { setFilter(f.id); setLimit(15); }}>
            {f.label} <span className="qa-trends-chip-count">{n}</span>
          </button>;
        })}
      </div>
      <HTMLSelect minimal value={baseline} onChange={e => setBaseline(e.target.value)} aria-label="Compared with">
        <option value="first">Latest vs. the first commit</option>
        <option value="previous">Latest vs. the commit before</option>
      </HTMLSelect>
      <InputGroup small leftIcon="search" placeholder="Filter metrics" value={search} onChange={e => { setSearch(e.target.value); setLimit(15); }} className="qa-trends-search"/>
    </div>
    {rows.length === 0
      ? <p className="qa-trends-muted qa-trends-empty">{filter === 'all' ? 'Nothing moved beyond its usual variation.' : 'None.'}</p>
      : <table className="qa-trends-table">
        <thead><tr>
          <th>Metric</th>
          <th>Over the commits</th>
          <th className="qa-trends-num">{baseline === 'first' ? 'First' : 'Before'}</th>
          <th className="qa-trends-num">Latest</th>
          <th className="qa-trends-num">Change</th>
          <th>Biggest move</th>
        </tr></thead>
        <tbody>{rows.slice(0, limit).map(({ series, change }) => <tr key={series.key}>
          <td className="qa-trends-test-name" title={series.label}>
            <span className="qa-trends-muted">{series.path.slice(node.path.length + path.length).join(' / ')}{series.path.length > node.path.length + path.length ? ' / ' : ''}</span>{series.short_label}
          </td>
          <td><Sparkline values={series.values} width={140} height={22} mark={change?.stepped ? change.step.index : undefined}/></td>
          {change ? <>
            <td className="qa-trends-num">{formatValue(change.first, series.definition)}</td>
            <td className="qa-trends-num">{formatValue(change.last, series.definition)}</td>
            <td className="qa-trends-num"><Change ratio={change.ratio} direction={change.direction}/></td>
            <td className="qa-trends-fact">
              {formatRatio(change.step.ratio)} at <CommitLink point={points[change.step.index]}/>
              <Tag minimal round className="qa-trends-step" title={change.stepped ? 'Most of the change happened at this commit.' : 'The change built up over several commits.'}>{change.stepped ? 'a step' : 'a drift'}</Tag>
            </td>
          </> : <>
            <td className="qa-trends-num">{filter === 'removed' ? formatValue(first_value(series.values), series.definition) : '–'}</td>
            <td className="qa-trends-num">{filter === 'added' ? formatValue(last_value(series.values), series.definition) : '–'}</td>
            <td className="qa-trends-num qa-trends-muted">{filter}</td>
            <td aria-hidden="true"/>
          </>}
        </tr>)}</tbody>
      </table>}
    {rows.length > limit && <Button minimal small icon="chevron-down" onClick={() => setLimit(limit + 50)}>{plural(rows.length - limit, 'more metric')}</Button>}
    {all_movers.quiet > 0 && <p className="qa-trends-muted qa-trends-note">
      {plural(all_movers.quiet, 'other metric')} changed by less than 3 times what {all_movers.quiet === 1 ? 'it usually moves' : 'they usually move'} from a commit to the next: not listed.
      QA-Board doesn't know how noisy the machine is, this only keeps wobble out of the list.
    </p>}
  </section>;
}


// Everything the commits' metrics describe: totals with their parts, then groups
export function TrendsReport({ points, trends, loadTests, onSelect }) {
  if (!hasTrends(trends)) return null;
  return <div className="qa-trends">
    {trends.composed.map(composition => <CompositionSection key={composition.key} composition={composition} points={points} loadTests={loadTests} onSelect={onSelect}/>)}
    {trends.tree.children.map(node => <GroupSection key={node.name} node={node} points={points} onSelect={onSelect}/>)}
  </div>;
}
