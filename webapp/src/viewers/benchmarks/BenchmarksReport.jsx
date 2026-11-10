// A viewer for benchmark files: the run's benchmarks next to the reference run's, matched by name, with the change,
// the spread the harness measured, and what got slower or faster beyond it. It reads pytest-benchmark, Google
// Benchmark, hyperfine, Criterion, JMH, `go test -bench` and QA-Board's *.benchmarks.json (see parse.js), and stays
// fast with thousands of benchmarks: only the rows in view are rendered.
//
// A standalone component, given the files' text: it imports nothing from the app (a test checks it). QA-Board's
// adapter, ../benchmarks-viewer.jsx, downloads the files; the playground (/benchmark-viewer.html) generates them.
// Colors come from the theme's CSS variables (--qa-text, --qa-border...), with Blueprint's dark theme class.
import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Button, Callout, HTMLSelect, Icon, InputGroup, Intent, NonIdealState, Switch, Tag, Tooltip,
} from "@blueprintjs/core";

import { FORMATS, parseBenchmarks, STATS } from "./parse";
import {
  NOISE_RULE, SORTS, STATUSES, STATUS_ORDER, changeDomain, compareBenchmarks, contextDifferences, formatAmount,
  formatCount, formatPercent, formatValue, groupRows, rowFilter, sortRows, spreadOf, summarize,
} from "./model";
import "./benchmarks.css";

const DEFAULT_LABELS = { new: 'new', reference: 'reference', colors: {} };
const ROW_HEIGHT = 28;
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

const SideDot = ({ color }) => <span className="qa-bench-dot" style={{ background: color?.css }}/>;

// rounds × iterations, as the harness reports them
const repetitions = benchmark => {
  const { rounds, iterations, samples } = benchmark?.stats ?? {};
  if (rounds && iterations > 1) return `${formatCount(rounds)} × ${formatCount(iterations)}`;
  if (rounds) return formatCount(rounds);
  if (samples) return `${formatCount(samples)} samples`;
  if (iterations) return `${formatCount(iterations)} iter.`;
  return '';
};
const repetitionsTitle = benchmark => {
  const { rounds, iterations, samples } = benchmark?.stats ?? {};
  return [rounds && plural(rounds, 'round'), iterations && `${plural(iterations, 'iteration')}${rounds ? ' per round' : ''}`, samples && plural(samples, 'sample')]
    .filter(x => x).join(', ');
};

const relativeSpread = benchmark => {
  const spread = spreadOf(benchmark);
  if (!spread || !benchmark.value) return null;
  return { ...spread, fraction: spread.value / Math.abs(benchmark.value) };
};

const describe = (benchmark, label) => {
  if (!benchmark) return `${label}: not in the file`;
  const spread = spreadOf(benchmark);
  return `${label}: ${formatValue(benchmark.value, benchmark.unit)}${benchmark.statistic ? ` (${benchmark.statistic})` : ''}`
    + (spread ? `, ${spread.short} ${formatValue(spread.value, benchmark.unit)}` : '')
    + (repetitionsTitle(benchmark) ? `, ${repetitionsTitle(benchmark)}` : '');
};

const changeTitle = (row, labels) => {
  const b = row.benchmark ?? row.ref;
  const lines = [row.key, describe(row.benchmark, labels.new)];
  if (row.status) lines.push(describe(row.ref, labels.reference));
  if (row.status === 'noise')
    lines.push(`Within noise: the change, ${formatValue(Math.abs(row.delta), b.unit)}, is no larger than the larger spread, ${formatValue(row.noise, b.unit)}.`);
  else if (row.status === 'slower' || row.status === 'faster')
    lines.push(row.noise === null ? 'The files report no spread: any change counts.' : `Beyond noise: the change, ${formatValue(Math.abs(row.delta), b.unit)}, is larger than the larger spread, ${formatValue(row.noise, b.unit)}.`);
  const params = Object.entries(b.params ?? {});
  if (params.length) lines.push(`Parameters: ${params.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  return lines.join('\n');
};

// The change, centered: right is worse, left is better. The gray band is the noise.
const ChangeBar = ({ row, domain }) => {
  if (row.change === null) return null;
  const clip = v => Math.max(-1, Math.min(1, v / domain));
  const at = clip(row.change);
  const ref_value = row.ref ? Math.abs(row.ref.value) : 0;
  const noise = row.noise !== null && ref_value ? Math.min(1, row.noise / ref_value / domain) : 0;
  return <span className="qa-bench-bar" aria-hidden="true">
    {noise > 0 && <span className="qa-bench-bar-noise" style={{ left: `${50 - 50 * noise}%`, width: `${100 * noise}%` }}/>}
    <span className="qa-bench-bar-axis"/>
    {at !== 0 && <span
      className={`qa-bench-bar-change qa-bench-${row.status}`}
      style={at > 0 ? { left: '50%', width: `${50 * at}%` } : { right: '50%', width: `${-50 * at}%` }}
    />}
    {Math.abs(row.change) > domain && <span className={`qa-bench-bar-clip qa-bench-${row.status}`} style={at > 0 ? { right: 0 } : { left: 0 }}/>}
  </span>;
};

const ChangeCell = ({ row }) => {
  if (row.status === 'added' || row.status === 'missing' || row.status === 'unit')
    return <Tag minimal intent={STATUSES[row.status].intent} className="qa-bench-tag">{STATUSES[row.status].label}</Tag>;
  if (row.change === null) return null;
  return <span className={`qa-bench-change qa-bench-${row.status}`}>
    {row.status === 'noise' && <span className="qa-bench-approx">≈</span>}{formatPercent(row.change)}
  </span>;
};

const Row = memo(function Row({ item, columns, domain, labels, selected, top }) {
  const style = { position: 'absolute', top: 0, left: 0, right: 0, height: ROW_HEIGHT, transform: `translateY(${top}px)` };
  if (item.kind === 'group') {
    const changes = ['slower', 'faster', 'added', 'missing'].filter(s => item.counts[s]);
    return <div role="row" data-key={item.key} className="qa-bench-row qa-bench-group" style={style} aria-expanded={item.open}>
      <span role="rowheader" className="qa-bench-cell qa-bench-col-name">
        <Icon icon={item.open ? 'chevron-down' : 'chevron-right'} size={14} className="qa-bench-muted"/>
        <span className="qa-bench-name" title={item.group || 'Without a group'}>{item.group || <span className="qa-bench-muted">Without a group</span>}</span>
        <span className="qa-bench-muted qa-bench-group-count">{item.count.toLocaleString('en-US')}</span>
        {changes.map(s => <span key={s} className={`qa-bench-group-change ${s === 'missing' ? 'qa-bench-missing-count' : `qa-bench-${s}`}`}>{item.counts[s]} {STATUSES[s].label}</span>)}
      </span>
    </div>;
  }
  const { row } = item;
  const b = row.benchmark;
  const shown = b ?? row.ref;
  const spread = relativeSpread(b);
  const ref_spread = relativeSpread(row.ref);
  return <div
    role="row" data-key={item.key} aria-selected={selected} title={changeTitle(row, labels)}
    className={`qa-bench-row${selected ? ' qa-bench-selected' : ''}${row.status === 'missing' ? ' qa-bench-missing' : ''}`} style={style}
  >
    <span role="gridcell" className={`qa-bench-cell qa-bench-col-name${item.grouped ? ' qa-bench-indent' : ''}`}>
      <span className="qa-bench-name">{row.short}</span>
      {Object.keys(shown.params ?? {}).length > 0 && !row.short.includes('[') && !Object.entries(shown.params).every(([k, v]) => row.short.includes(`${k}:${v}`) || row.short.includes(`${k}=${v}`))
        && <span className="qa-bench-params">{Object.entries(shown.params).map(([k, v]) => `${k}=${v}`).join(' ')}</span>}
    </span>
    <span role="gridcell" className="qa-bench-cell qa-bench-num qa-bench-col-new">{b ? formatValue(b.value, b.unit) : '—'}</span>
    {columns.reference && <span role="gridcell" className="qa-bench-cell qa-bench-num qa-bench-col-ref qa-bench-muted">{row.ref ? formatValue(row.ref.value, row.ref.unit) : '—'}</span>}
    {columns.reference && <span role="gridcell" className="qa-bench-cell qa-bench-num qa-bench-col-change"><ChangeCell row={row}/></span>}
    {columns.spread && <span role="gridcell" className="qa-bench-cell qa-bench-num qa-bench-col-spread">
      {spread && <>±{formatPercent(spread.fraction, { sign: false })}{!columns.reference && <span className="qa-bench-muted qa-bench-kind"> {spread.short}</span>}</>}
      {columns.reference && ref_spread && <span className="qa-bench-muted qa-bench-ref-spread"> / {formatPercent(ref_spread.fraction, { sign: false })}</span>}
    </span>}
    {columns.repetitions && <span role="gridcell" className="qa-bench-cell qa-bench-num qa-bench-col-rounds qa-bench-muted">{repetitions(shown)}</span>}
    {columns.throughput && <span role="gridcell" className="qa-bench-cell qa-bench-num qa-bench-col-throughput">
      {b?.throughput ? formatAmount(b.throughput.value, b.throughput.unit) : ''}
    </span>}
    {columns.reference && <span role="gridcell" className="qa-bench-cell qa-bench-col-bar"><ChangeBar row={row} domain={domain}/></span>}
  </div>;
});

const Header = ({ columns, labels, statistic }) => <div role="row" className="qa-bench-row qa-bench-header">
  <span role="columnheader" className="qa-bench-cell qa-bench-col-name">Benchmark</span>
  <span role="columnheader" className="qa-bench-cell qa-bench-num qa-bench-col-new" title={`${labels.new}${statistic ? `, ${statistic}` : ''}`}>
    <SideDot color={labels.colors?.new}/>{columns.reference ? 'New' : (statistic ? statistic[0].toUpperCase() + statistic.slice(1) : 'Time')}
  </span>
  {columns.reference && <span role="columnheader" className="qa-bench-cell qa-bench-num qa-bench-col-ref" title={labels.reference}><SideDot color={labels.colors?.reference}/>Reference</span>}
  {columns.reference && <span role="columnheader" className="qa-bench-cell qa-bench-num qa-bench-col-change">Change</span>}
  {columns.spread && <span role="columnheader" aria-label="Spread" className="qa-bench-cell qa-bench-num qa-bench-col-spread">
    <Tooltip content={<div className="qa-bench-tooltip">The spread the harness measured, relative to the value: σ for the standard deviation, else IQR, MAD or error.{columns.reference ? ' New / reference.' : ''}</div>} compact>
      <span className="qa-bench-help">Spread</span>
    </Tooltip>
  </span>}
  {columns.repetitions && <span role="columnheader" className="qa-bench-cell qa-bench-num qa-bench-col-rounds" title="Rounds × iterations per round, as the harness reports them">Rounds</span>}
  {columns.throughput && <span role="columnheader" className="qa-bench-cell qa-bench-num qa-bench-col-throughput">Throughput</span>}
  {columns.reference && <span role="columnheader" className="qa-bench-cell qa-bench-col-bar" title="The change: right is worse, left is better. The gray band is the noise.">
    <span className="qa-bench-muted">better</span><span className="qa-bench-muted">worse</span>
  </span>}
</div>;

const Context = ({ context, labels, color }) => {
  const parts = [
    context.machine,
    context.cpu,
    context.cpu_count && plural(context.cpu_count, 'CPU'),
    context.os,
    context.harness,
    context.date && context.date.replace('T', ' ').replace(/(\.\d+)?(\+00:00|Z)$/, ' UTC').replace(/(:\d\d)(\.\d+)/, '$1'),
  ].filter(x => x);
  if (!parts.length) return null;
  return <div className="qa-bench-context">
    <SideDot color={color}/><span className="qa-bench-muted">{labels}:</span> {parts.join(' · ')}
  </div>;
};

const Details = ({ row, labels, onClose }) => {
  const b = row.benchmark ?? row.ref;
  const keys = STATS.filter(k => k in (row.benchmark?.stats ?? {}) || k in (row.ref?.stats ?? {}));
  const show = (benchmark, key) => {
    const value = benchmark?.stats?.[key];
    if (value === undefined) return '';
    if (['rounds', 'iterations', 'samples'].includes(key)) return value.toLocaleString('en-US');
    if (key === 'ops') return formatAmount(value, 'ops/s');
    if (key === 'bytes_per_op') return formatAmount(value, 'B');
    if (key === 'allocs_per_op') return value.toLocaleString('en-US');
    return formatValue(value, benchmark.unit);
  };
  const params = Object.entries(b.params ?? {});
  return <div className="qa-bench-details" aria-label="Benchmark details">
    <div className="qa-bench-details-title">
      <strong className="qa-bench-wrap">{row.key}</strong>
      <Button variant="minimal" size="small" icon="cross" aria-label="Close the details" onClick={onClose}/>
    </div>
    {params.length > 0 && <div className="qa-bench-muted">{params.map(([k, v]) => `${k}=${v}`).join(', ')}</div>}
    <table className="qa-bench-facts">
      <thead><tr><th className="qa-bench-muted">Statistic</th><th><SideDot color={labels.colors?.new}/>{labels.new}</th>{row.status && <th><SideDot color={labels.colors?.reference}/>{labels.reference}</th>}</tr></thead>
      <tbody>
        <tr><td>Value{b.statistic ? ` (${b.statistic})` : ''}</td><td>{row.benchmark ? formatValue(row.benchmark.value, row.benchmark.unit) : 'not in the file'}</td>{row.status && <td>{row.ref ? formatValue(row.ref.value, row.ref.unit) : 'not in the file'}</td>}</tr>
        {keys.map(k => <tr key={k}><td>{k.replace(/_/g, ' ')}</td><td>{show(row.benchmark, k)}</td>{row.status && <td>{show(row.ref, k)}</td>}</tr>)}
        {(row.benchmark?.throughput || row.ref?.throughput) && <tr><td>throughput</td>
          <td>{row.benchmark?.throughput ? formatAmount(row.benchmark.throughput.value, row.benchmark.throughput.unit) : ''}</td>
          {row.status && <td>{row.ref?.throughput ? formatAmount(row.ref.throughput.value, row.ref.throughput.unit) : ''}</td>}
        </tr>}
      </tbody>
    </table>
    {row.status && <div className="qa-bench-note">{STATUSES[row.status].label[0].toUpperCase() + STATUSES[row.status].label.slice(1)}{row.change !== null ? ` (${formatPercent(row.change)})` : ''}. {NOISE_RULE}</div>}
  </div>;
};

// The header, then the rows in view. Click a group to close or open it, a benchmark for its details; ↑ ↓ move.
function Table({ items, header, empty, columns, domain, labels, height, selected_key, onToggleGroup, onSelect }) {
  const scroll = useRef(null);
  // oxlint-disable-next-line react/incompatible-library -- the compiler doesn't memoize this component: fine, it renders the rows in view
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    // jsdom (the tests) has no layout
    initialRect: { width: 900, height },
  });
  const onClick = e => {
    const element = e.target.closest('[data-key]');
    const item = element && items.find(i => i.key === element.dataset.key);
    if (!item) return;
    if (item.kind === 'group') onToggleGroup(item.group);
    else onSelect(item.row.key === selected_key ? null : item.row.key);
  };
  const selected_index = items.findIndex(i => i.row?.key === selected_key);
  useEffect(() => {
    if (selected_index >= 0) virtualizer.scrollToIndex(selected_index, { align: 'auto' });
  }, [selected_index, virtualizer]);
  const move = direction => {
    for (let i = selected_index + direction; i >= 0 && i < items.length; i += direction)
      if (items[i].kind === 'benchmark') return onSelect(items[i].row.key);
  };
  const onKeyDown = e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const handled = { ArrowDown: () => move(1), ArrowUp: () => move(-1), Escape: () => onSelect(null) }[e.key];
    if (handled) {
      e.preventDefault();
      handled();
    }
  };
  return <div className="qa-bench-table" role="grid" aria-label="Benchmarks" tabIndex={0} onClick={onClick} onKeyDown={onKeyDown}>
    {header}
    {items.length === 0
      ? empty
      : <div ref={scroll} className="qa-bench-scroll" style={{ height: Math.min(height, items.length * ROW_HEIGHT + 2) }}>
          <div role="rowgroup" className="qa-bench-rows" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map(v => {
              const item = items[v.index];
              return <Row key={item.key} item={item} columns={columns} domain={domain} labels={labels} selected={item.row?.key === selected_key} top={v.start}/>;
            })}
          </div>
        </div>}
  </div>;
}

// - text, ref_text: the files' content (ref_text: null without a reference)
// - labels: {new, reference, colors: {new, reference}}: what to call each side, colors with a `css` field
// - format: one of FORMATS, else it's detected from the content
// - fallback(message): what to show instead of a warning when the file can't be read
export function BenchmarksReport({ text, ref_text, labels: labels_, height = 440, path, format: format_, fallback }) {
  const labels = labels_ ?? DEFAULT_LABELS;
  // `type: benchmarks/go` forces a format; `benchmarks/json` and the like don't
  const format = FORMATS.includes(format_) ? format_ : undefined;
  const parsed = useMemo(() => parseBenchmarks(text, { format }), [text, format]);
  const parsed_ref = useMemo(() => ref_text === null || ref_text === undefined ? null : parseBenchmarks(ref_text, { format }), [ref_text, format]);
  const has_reference = !!parsed_ref && !parsed_ref.error;
  const rows = useMemo(
    () => compareBenchmarks(parsed.benchmarks, has_reference ? parsed_ref.benchmarks : null),
    [parsed, parsed_ref, has_reference],
  );
  const summary = useMemo(() => summarize(rows), [rows]);
  const domain = useMemo(() => changeDomain(rows), [rows]);

  const [search, setSearch] = useState('');
  const [only_changed, setOnlyChanged] = useState(false);
  const [statuses, setStatuses] = useState(() => new Set());
  const [sort_state, setSort] = useState(null);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [selected_key, setSelectedKey] = useState(null);
  const deferred_search = useDeferredValue(search);
  const sort = sort_state ?? (has_reference ? 'regressions' : 'name');

  const filter = useMemo(() => rowFilter({ search: deferred_search, only_changed, statuses }), [deferred_search, only_changed, statuses]);
  const shown = useMemo(() => filter ? rows.filter(filter) : rows, [rows, filter]);
  const items = useMemo(() => groupRows(sortRows(shown, sort), collapsed), [shown, sort, collapsed]);
  const selected = selected_key ? rows.find(r => r.key === selected_key) : null;

  const columns = useMemo(() => ({
    reference: has_reference,
    spread: rows.some(r => spreadOf(r.benchmark) || spreadOf(r.ref)),
    repetitions: rows.some(r => repetitions(r.benchmark ?? r.ref)),
    throughput: rows.some(r => r.benchmark?.throughput),
  }), [rows, has_reference]);
  const statistics = new Set(parsed.benchmarks.map(b => b.statistic));
  const statistic = statistics.size === 1 ? [...statistics][0] : null;
  const differences = useMemo(
    () => has_reference ? contextDifferences(parsed.context, parsed_ref.context) : { warnings: [], notes: [] },
    [has_reference, parsed, parsed_ref],
  );

  if (parsed.error && fallback)
    return fallback(parsed.error);
  if (parsed.error)
    return <Callout compact intent={Intent.WARNING} icon="warning-sign">Could not read <code>{path}</code>: {parsed.error}</Callout>;

  const toggleStatus = status => setStatuses(current => current.size === 1 && current.has(status) ? new Set() : new Set([status]));
  const toggleGroup = group => setCollapsed(current => {
    const next = new Set(current);
    if (next.has(group)) next.delete(group); else next.add(group);
    return next;
  });
  const clear = () => { setSearch(''); setOnlyChanged(false); setStatuses(new Set()); };
  const { counts } = summary;
  const benchmark_count = parsed.benchmarks.length;

  return <div className="qa-bench">
    <div className="qa-bench-summary" role="toolbar" aria-label="Summary">
      <strong>{plural(benchmark_count, 'benchmark')}</strong>
      {has_reference && <>
        <span className="qa-bench-muted">vs <SideDot color={labels.colors?.reference}/>{labels.reference}:</span>
        {STATUS_ORDER.filter(s => counts[s]).map(s => {
          const chip = <Tag
            key={s} interactive round minimal={!statuses.has(s)} intent={STATUSES[s].intent}
            aria-pressed={statuses.has(s)} onClick={() => toggleStatus(s)} className="qa-bench-chip"
          >
            {counts[s].toLocaleString('en-US')} {STATUSES[s].label}
          </Tag>;
          return s === 'noise' ? <Tooltip key={s} content={<div className="qa-bench-tooltip">{NOISE_RULE}</div>}>{chip}</Tooltip> : chip;
        })}
        {summary.geomean !== null && summary.compared > 1 && <Tooltip content={<div className="qa-bench-tooltip">The geometric mean of the {summary.compared.toLocaleString('en-US')} benchmarks' ratios, new / reference: each weighs the same. Positive is slower.</div>}>
          <span className="qa-bench-muted qa-bench-help">overall {formatPercent(summary.geomean)}</span>
        </Tooltip>}
      </>}
    </div>
    <div className="qa-bench-contexts">
      <Context context={parsed.context} labels={labels.new} color={labels.colors?.new}/>
      {has_reference && <Context context={parsed_ref.context} labels={labels.reference} color={labels.colors?.reference}/>}
    </div>
    {differences.warnings.length > 0 && <Callout compact intent={Intent.WARNING} icon="warning-sign" className="qa-bench-warning">
      The new and reference benchmarks ran on different machines ({differences.warnings.map(([what, a, b]) => `${what}: ${a} vs ${b}`).join('; ')}): their numbers may not be comparable.
    </Callout>}
    {differences.warnings.length === 0 && differences.notes.length > 0 && <div className="qa-bench-muted qa-bench-note">
      <Icon icon="info-sign" size={12}/> Different hosts with the same CPU ({differences.notes.map(([, a, b]) => `${a} vs ${b}`).join('')}).
    </div>}
    {parsed_ref?.error && <div className="qa-bench-muted qa-bench-note">
      <Icon icon="info-sign" size={12}/> The reference's file could not be read ({parsed_ref.error}): showing the new benchmarks alone.
    </div>}
    <div className="qa-bench-toolbar">
      <InputGroup
        size="small" leftIcon="search" className="qa-bench-search" placeholder="Filter benchmarks, -word to exclude"
        value={search} onChange={e => setSearch(e.target.value)} aria-label="Filter the benchmarks"
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); clear(); } }}
        rightElement={search ? <Button variant="minimal" size="small" icon="cross" aria-label="Clear the filter" onClick={() => setSearch('')}/> : undefined}
      />
      {has_reference && <Switch
        checked={only_changed} onChange={e => setOnlyChanged(e.target.checked)} label="Only changed" className="qa-bench-switch"
      />}
      <HTMLSelect
        minimal value={sort} onChange={e => setSort(e.target.value)} aria-label="Sort"
        options={SORTS.filter(s => has_reference || !s.needs_reference).map(({ value, label }) => ({ value, label }))}
      />
      <span className="qa-bench-spacer"/>
      {filter && <span className="qa-bench-muted qa-bench-shown" aria-live="polite">{shown.length.toLocaleString('en-US')} of {plural(rows.length, 'benchmark')}</span>}
      {filter && <Button size="small" variant="minimal" icon="filter-remove" onClick={clear}>Clear</Button>}
    </div>
    <Table
      items={items} columns={columns} domain={domain} labels={labels} height={height} selected_key={selected_key}
      onToggleGroup={toggleGroup} onSelect={setSelectedKey}
      header={<Header columns={columns} labels={labels} statistic={statistic}/>}
      empty={<div className="qa-bench-empty">
        {rows.length === 0
          ? <NonIdealState icon="dashboard" title="No benchmarks" description="The file has no benchmark results."/>
          : <NonIdealState icon="search" title="No benchmarks match" action={<Button icon="filter-remove" onClick={clear}>Clear the filters</Button>}/>}
      </div>}
    />
    {selected && <Details row={selected} labels={labels} onClose={() => setSelectedKey(null)}/>}
  </div>;
}

export default BenchmarksReport;
