// A viewer for JUnit XML test reports: the run's tests compared with the reference's, as a tree with counts, filters
// and a search, and the details of the selected test. It reads pytest, GoogleTest, CTest, Surefire... reports (see
// parse.js), and stays fast with tens of thousands of tests: only the rows in view are rendered.
import { memo, useEffect, useMemo, useRef, useState, useDeferredValue } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Button, ButtonGroup, Callout, HTMLSelect, Icon, InputGroup, Intent, NonIdealState, PopoverNext, Tag, Tooltip,
} from "@blueprintjs/core";
import copy from "copy-to-clipboard";

import { fileQuery } from "../../api/queries";
import { toaster } from "../../toaster";
import { ViewerError, ViewerLoading } from "../ViewerStates";
import { parseJunit } from "./parse";
import {
  CHANGES, CHANGE_ORDER, SORT_OPTIONS, changeCount, allGroupKeys, ancestorKeys, buildTree, compareTests, countTests,
  defaultExpanded, flatten, formatTime, isFailing, parseSearch, testFilter, visibleCounts,
} from "./model";
import "./junit.css";
import { useLabels } from "../../hooks";

const ROW_HEIGHT = 26;

const STATUS = {
  failed: { label: 'Failed', icon: 'error', className: 'qa-junit-failed' },
  error: { label: 'Errors', one: 'Error', icon: 'issue', className: 'qa-junit-failed' },
  flaky: { label: 'Flaky', icon: 'warning-sign', className: 'qa-junit-flaky' },
  skipped: { label: 'Skipped', icon: 'disable', className: 'qa-junit-skipped' },
  passed: { label: 'Passed', icon: 'tick-circle', className: 'qa-junit-passed' },
  removed: { label: 'Removed', icon: 'trash', className: 'qa-junit-skipped' },
};
// the order of the bar's segments and of the tiles
const BAR = ['failed', 'error', 'flaky', 'skipped', 'passed'];

export const SHORTCUTS = [
  ['↑ ↓', 'Previous / next row'],
  ['← →', 'Close / open a group, or go to its parent / first child'],
  ['Enter', 'Open or close a group'],
  ['n  p', 'Next / previous failure (new failures, failures, removed tests)'],
  ['/', 'Search the tests'],
  ['Esc', 'Clear the search and filters'],
  ['c', "Copy the selected test's id"],
  ['Home End', 'First / last row'],
];

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const delta = (n, ref) => {
  if (ref === undefined || ref === null || n === ref) return null;
  const d = n - ref;
  return `${d > 0 ? '+' : '−'}${Math.abs(d).toLocaleString()}`;
};

const StatusIcon = ({ status, size = 14 }) => {
  const { icon, className, label } = STATUS[status];
  return <Icon icon={icon} size={size} className={className} title={label}/>;
};

// The status of a group's tests, as a thin stacked bar
const MicroBar = ({ counts, width = 64 }) => {
  const total = BAR.reduce((n, s) => n + counts[s], 0);
  if (!total) return null;
  return <span className="qa-junit-microbar" style={{ width }} aria-hidden="true">
    {BAR.map(s => counts[s] > 0 && <span key={s} className={`qa-junit-seg-${s}`} style={{ width: `${(100 * counts[s]) / total}%` }}/>)}
  </span>;
};

// The search's words in a name, highlighted
const Highlighted = ({ text, words }) => {
  if (!words.length) return text;
  const lower = text.toLowerCase();
  const marks = [];
  for (const word of words) {
    let from = 0;
    let at;
    while ((at = lower.indexOf(word, from)) >= 0) {
      marks.push([at, at + word.length]);
      from = at + word.length;
    }
  }
  if (!marks.length) return text;
  marks.sort((a, b) => a[0] - b[0]);
  const parts = [];
  let last = 0;
  for (const [start, end] of marks) {
    if (start < last) continue;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(<mark key={start}>{text.slice(start, end)}</mark>);
    last = end;
  }
  parts.push(text.slice(last));
  return parts;
};

const ChangeTag = ({ change }) => {
  if (!change) return null;
  const { short, intent } = CHANGES[change];
  return <Tag minimal intent={intent} className={`qa-junit-change qa-junit-change-${change}`}>{short}</Tag>;
};

// One row of the tree: a group (folder, module, class, suite) or a test
// Clicks are handled by the tree (data-index): one listener for all the rows
const Row = memo(function Row({ row, selected, words, has_reference, visible, onToggle, top }) {
  const style = { position: 'absolute', top: 0, left: 0, right: 0, height: ROW_HEIGHT, transform: `translateY(${top}px)` };
  const indent = { paddingLeft: 6 + row.depth * 16 };
  if (row.kind === 'group') {
    const { node, open } = row;
    const failing = node.counts.failed + node.counts.error;
    const important = CHANGE_ORDER.find(c => node.changes[c] && !CHANGES[c].minor);
    return <div
      role="treeitem" id={`qa-junit-${row.index}`} data-index={row.index} tabIndex={-1}
      aria-level={row.depth + 1} aria-expanded={open} aria-selected={selected}
      className={`qa-junit-row qa-junit-group${selected ? ' qa-junit-selected' : ''}`} style={{ ...style, ...indent }}
    >
      <Button
        variant="minimal" size="small" className="qa-junit-caret" icon={open ? 'chevron-down' : 'chevron-right'}
        aria-label={open ? `Close ${node.name}` : `Open ${node.name}`} tabIndex={-1}
        onClick={e => { e.stopPropagation(); onToggle(row); }}
      />
      <Icon icon={node.children.length ? (open ? 'folder-open' : 'folder-close') : 'document'} size={14} className="qa-junit-muted"/>
      <span className="qa-junit-name" title={node.name}><Highlighted text={node.name} words={words}/></span>
      <span className="qa-junit-trailing">
        {failing > 0 && <span className="qa-junit-count qa-junit-failed">{failing} failed</span>}
        {node.counts.flaky > 0 && <span className="qa-junit-count qa-junit-flaky">{node.counts.flaky} flaky</span>}
        {has_reference && important && <Tooltip content={CHANGE_ORDER.filter(c => node.changes[c]).map(c => changeCount(node.changes[c], c)).join(', ')} compact>
          <Tag minimal intent={CHANGES[important].intent} className="qa-junit-change">{changeCount(node.changes[important], important)}</Tag>
        </Tooltip>}
        <MicroBar counts={node.counts}/>
        {visible
          ? <span className="qa-junit-num qa-junit-matches" title={`${visible.get(node.key)} of its ${node.counts.tests + node.counts.removed} tests match`}>
              {visible.get(node.key).toLocaleString()}<span className="qa-junit-muted">/{(node.counts.tests + node.counts.removed).toLocaleString()}</span>
            </span>
          : <span className="qa-junit-num">{node.counts.tests.toLocaleString()}</span>}
        <span className="qa-junit-time">{formatTime(node.time)}</span>
      </span>
    </div>;
  }
  const { test } = row;
  const ratio = test.ref && test.ref.time > 0 && test.status !== 'removed' ? test.time / test.ref.time : null;
  return <div
    role="treeitem" id={`qa-junit-${row.index}`} data-index={row.index} tabIndex={-1}
    aria-level={row.depth + 1} aria-selected={selected}
    className={`qa-junit-row qa-junit-test${selected ? ' qa-junit-selected' : ''}${test.status === 'removed' ? ' qa-junit-removed' : ''}`}
    style={{ ...style, ...indent }}
  >
    <span className="qa-junit-caret-space"/>
    <StatusIcon status={test.status}/>
    <span className="qa-junit-name" title={test.id}><Highlighted text={test.name} words={words}/></span>
    {test.message && isFailing(test) && <span className="qa-junit-message" title={test.message}>{test.message}</span>}
    <span className="qa-junit-trailing">
      {has_reference && <ChangeTag change={test.change}/>}
      {ratio !== null && test.change === 'slower' && <span className="qa-junit-count qa-junit-flaky">×{ratio.toFixed(1)}</span>}
      <span className="qa-junit-time">{test.status === 'removed' ? '' : formatTime(test.time)}</span>
    </span>
  </div>;
});

// The rows in view, and those just around: the list renders on its own when it scrolls
function TreeList({ rows, selected_index, words, has_reference, visible, height, tree, onToggle, onSelect, onKeyDown }) {
  const scroll = useRef(null);
  // oxlint-disable-next-line react/incompatible-library -- the compiler doesn't memoize this component: fine, it renders the rows in view
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    // jsdom (the tests) has no layout
    initialRect: { width: 800, height },
  });
  useEffect(() => {
    if (selected_index >= 0) virtualizer.scrollToIndex(selected_index, { align: 'auto' });
  }, [selected_index, virtualizer]);
  const rowAt = e => {
    const element = e.target.closest('[data-index]');
    return element ? rows[Number(element.dataset.index)] : null;
  };
  return <div ref={scroll} className="qa-junit-scroll" style={{ height: Math.min(height, rows.length * ROW_HEIGHT + 2) }}>
    <div
      ref={tree} role="tree" aria-label="Tests" tabIndex={0} className="qa-junit-tree"
      aria-activedescendant={selected_index >= 0 ? `qa-junit-${selected_index}` : undefined}
      onKeyDown={onKeyDown}
      onClick={e => { const row = rowAt(e); if (row) { onSelect(row.index); tree.current?.focus({ preventScroll: true }); } }}
      onDoubleClick={e => { const row = rowAt(e); if (row?.kind === 'group') onToggle(row); }}
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map(item => <Row
        key={rows[item.index].key} row={rows[item.index]} selected={item.index === selected_index} words={words}
        has_reference={has_reference} visible={visible} onToggle={onToggle} top={item.start}
      />)}
    </div>
  </div>;
}

// Why a test failed: the message, then the trace
const Failure = ({ test, title }) => <div className="qa-junit-failure">
  {title && <div className="qa-junit-label">{title}</div>}
  {test.message && <Callout compact intent={test.status === 'flaky' ? Intent.WARNING : Intent.DANGER} icon={null} className="qa-junit-callout">
    {test.failure_type && !test.message.startsWith(test.failure_type) && <strong>{test.failure_type}: </strong>}{test.message}
  </Callout>}
  {test.text && test.text !== test.message && <pre className="qa-junit-trace">{test.text}</pre>}
</div>;

const Output = ({ title, text }) => text ? <details className="qa-junit-output">
  <summary>{title} <span className="qa-junit-muted">({plural(text.split('\n').length, 'line')})</span></summary>
  <pre className="qa-junit-trace">{text}</pre>
</details> : null;

const SideTag = ({ color, children }) => <span className="qa-junit-side"><span className="qa-junit-dot" style={{ background: color.css }}/>{children}</span>;

// The selected test or group, in detail
const Details = ({ row, labels, has_reference, onFilter, onExpandAll }) => {
  if (!row)
    return <div className="qa-junit-details qa-junit-details-empty">
      <NonIdealState icon="select" description="Select a test to see why it failed, its time and its output."/>
    </div>;
  if (row.kind === 'group') {
    const { node } = row;
    const changes = CHANGE_ORDER.filter(c => node.changes[c]);
    return <div className="qa-junit-details">
      <div className="qa-junit-details-title"><Icon icon="folder-close" className="qa-junit-muted"/> <strong>{node.name}</strong></div>
      <div className="qa-junit-breadcrumb">{node.key.split('\u0000').join(' › ')}</div>
      <MicroBar counts={node.counts} width="100%"/>
      <table className="qa-junit-facts"><tbody>
        {BAR.filter(s => node.counts[s]).map(s => <tr key={s}><td><StatusIcon status={s}/> {STATUS[s].label}</td><td>{node.counts[s].toLocaleString()}</td></tr>)}
        {node.counts.removed > 0 && <tr><td><StatusIcon status="removed"/> Removed</td><td>{node.counts.removed}</td></tr>}
        <tr><td>Time</td><td>{formatTime(node.time)}{has_reference && node.ref_time > 0 && <span className="qa-junit-muted"> vs {formatTime(node.ref_time)}</span>}</td></tr>
      </tbody></table>
      {has_reference && changes.length > 0 && <div className="qa-junit-tags">
        {changes.map(c => <Tag key={c} minimal intent={CHANGES[c].intent}>{changeCount(node.changes[c], c)}</Tag>)}
      </div>}
      <ButtonGroup variant="minimal" size="small" className="qa-junit-actions">
        <Button icon="filter" onClick={() => onFilter(node.key.split('\u0000').join('.'))}>Search this group</Button>
        <Button icon="expand-all" onClick={() => onExpandAll(node)}>Open all below</Button>
      </ButtonGroup>
    </div>;
  }
  const { test } = row;
  const { ref } = test;
  const same_failure = ref && isFailing(ref) && ref.text === test.text && ref.message === test.message;
  return <div className="qa-junit-details">
    <div className="qa-junit-details-title">
      <StatusIcon status={test.status} size={16}/>
      <strong className="qa-junit-wrap">{test.name}</strong>
      <Tooltip content="Copy the test's id (c)" compact>
        <Button variant="minimal" size="small" icon="duplicate" aria-label="Copy the test's id" onClick={() => copyId(test)}/>
      </Tooltip>
    </div>
    <div className="qa-junit-breadcrumb">{test.classname || test.suite}</div>
    <table className="qa-junit-facts"><tbody>
      <tr>
        <td>Status</td>
        <td>
          <SideTag color={labels.colors.new}><span className="qa-junit-muted">{labels.new}:</span> {test.status === 'removed' ? 'not run' : STATUS[test.status].one ?? STATUS[test.status].label}</SideTag>
          {has_reference && <SideTag color={labels.colors.reference}><span className="qa-junit-muted">{labels.reference}:</span> {ref ? STATUS[ref.status].one ?? STATUS[ref.status].label : 'not run'}</SideTag>}
          {has_reference && <ChangeTag change={test.change}/>}
        </td>
      </tr>
      {test.status !== 'removed' && <tr>
        <td>Time</td>
        <td>{formatTime(test.time)}{ref && <span className="qa-junit-muted"> vs {formatTime(ref.time)} in {labels.reference}</span>}</td>
      </tr>}
      {test.file && <tr><td>File</td><td><code>{test.file}{test.line && `:${test.line}`}</code></td></tr>}
      {test.suite && test.suite !== test.classname && <tr><td>Suite</td><td>{test.suite}</td></tr>}
    </tbody></table>
    {(isFailing(test) || test.status === 'flaky') && <Failure test={test} title={test.status === 'flaky' ? 'Failed first, then passed when run again' : null}/>}
    {test.status === 'skipped' && test.message && <Callout compact icon="disable" className="qa-junit-callout">{test.message}</Callout>}
    {has_reference && ref && isFailing(ref) && !same_failure && <Failure test={ref} title={`In ${labels.reference}`}/>}
    {same_failure && <div className="qa-junit-muted qa-junit-note">Same failure in {labels.reference}.</div>}
    <Output title="Standard output" text={test.stdout}/>
    <Output title="Standard error" text={test.stderr}/>
  </div>;
};

const copyId = test => {
  copy(test.id);
  toaster.show({ message: `Copied ${test.id}`, icon: 'duplicate', timeout: 2000 });
};

// The numbers at the top: each status is a filter
const Summary = ({ counts, ref_counts, time, ref_time, statuses, onToggleStatus, has_reference }) => {
  const total = BAR.reduce((n, s) => n + counts[s], 0);
  return <div className="qa-junit-summary">
    <div className="qa-junit-tiles">
      <div className="qa-junit-tile qa-junit-tile-static">
        <div className="qa-junit-tile-label">Tests</div>
        <div className="qa-junit-tile-value">{counts.tests.toLocaleString()}</div>
        {has_reference && <div className="qa-junit-tile-delta">{delta(counts.tests, ref_counts.tests) ?? 'same'}</div>}
      </div>
      {BAR.map(s => {
        const pressed = statuses.has(s);
        const d = has_reference ? delta(counts[s], ref_counts[s]) : null;
        return <button
          type="button" key={s} aria-pressed={pressed}
          className={`qa-junit-tile qa-junit-tile-${s}${pressed ? ' qa-junit-tile-pressed' : ''}${counts[s] ? '' : ' qa-junit-tile-zero'}`}
          title={pressed ? 'Show all statuses' : `Show only the ${STATUS[s].label.toLowerCase()} tests (Shift-click to add them to the filter)`}
          onClick={e => onToggleStatus(s, e.shiftKey || e.metaKey || e.ctrlKey)}
        >
          <div className="qa-junit-tile-label"><StatusIcon status={s} size={12}/> {STATUS[s].label}</div>
          <div className="qa-junit-tile-value">{counts[s].toLocaleString()}</div>
          {d && <div className="qa-junit-tile-delta">{d}</div>}
        </button>;
      })}
      <div className="qa-junit-tile qa-junit-tile-static">
        <div className="qa-junit-tile-label">Time</div>
        <div className="qa-junit-tile-value">{formatTime(time)}</div>
        {has_reference && ref_time > 0 && <div className="qa-junit-tile-delta">vs {formatTime(ref_time)}</div>}
      </div>
    </div>
    {total > 0 && <div className="qa-junit-bar" role="toolbar" aria-label="Tests by status">
      {BAR.map(s => counts[s] > 0 && <button
        type="button" key={s} className={`qa-junit-bar-seg qa-junit-seg-${s}`} style={{ width: `${(100 * counts[s]) / total}%` }}
        title={`${plural(counts[s], 'test')} ${STATUS[s].label.toLowerCase()} (${((100 * counts[s]) / total).toFixed(1)}%)`}
        aria-label={`${STATUS[s].label}: ${counts[s]}`} onClick={() => onToggleStatus(s, false)}
      />)}
    </div>}
  </div>;
};

export function JunitReport({ xml, ref_xml, labels: labels_, height = 440, path }) {
  const labels = useLabels(labels_);
  const parsed = useMemo(() => parseJunit(xml), [xml]);
  const parsed_ref = useMemo(() => ref_xml ? parseJunit(ref_xml) : null, [ref_xml]);
  const has_reference = !!parsed_ref && !parsed_ref.error;
  const tests = useMemo(
    () => compareTests(parsed.tests, has_reference ? parsed_ref.tests : null),
    [parsed, parsed_ref, has_reference],
  );
  const root = useMemo(() => buildTree(tests), [tests]);
  const group_keys = useMemo(() => allGroupKeys(root), [root]);
  const totals = useMemo(() => countTests(tests), [tests]);
  const ref_totals = useMemo(() => has_reference ? countTests(parsed_ref.tests) : null, [has_reference, parsed_ref]);

  const [statuses, setStatuses] = useState(() => new Set());
  const [change, setChange] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('status');
  const [expanded_state, setExpanded] = useState(null);
  // while filtering, every group with a match is open, except those closed since the filter changed
  const [filtered_closed, setFilteredClosed] = useState({ filter: null, keys: new Set() });
  const [selected_key, setSelectedKey] = useState(null);
  const deferred_search = useDeferredValue(search);

  const filter = useMemo(() => testFilter({ statuses, change, search: deferred_search }), [statuses, change, deferred_search]);
  const visible = useMemo(() => visibleCounts(root, filter), [root, filter]);
  const expanded = useMemo(
    () => expanded_state ?? defaultExpanded(root, { has_reference }),
    [expanded_state, root, has_reference],
  );
  const closed = filtered_closed.filter === filter ? filtered_closed.keys : null;
  const open_keys = useMemo(
    () => filter ? (closed?.size ? new Set([...group_keys].filter(k => !closed.has(k))) : true) : expanded,
    [filter, closed, group_keys, expanded],
  );
  const rows = useMemo(() => {
    const rows = flatten(root, { expanded: open_keys, visible, sort, filter });
    rows.forEach((row, index) => { row.index = index; });
    return rows;
  }, [root, open_keys, visible, sort, filter]);
  const shown = filter ? visible.get('') ?? 0 : totals.counts.tests + totals.counts.removed;
  const words = useMemo(() => parseSearch(deferred_search).include, [deferred_search]);

  // What needs a look, in the order of the list: n and p jump between them
  const problems = useMemo(() => flatten(root, { expanded: true, visible: null, sort, filter: null })
    .filter(r => r.kind === 'test' && (isFailing(r.test) || r.test.change === 'new-failure' || r.test.change === 'removed')),
  [root, sort]);

  // Until people pick one: the first new failure, else the first failure. When a filter hides the selected test, the
  // first test that matches.
  const initial_key = (problems.find(r => r.test.change === 'new-failure') ?? problems[0])?.key ?? null;
  let selected_index = rows.findIndex(r => r.key === (selected_key ?? initial_key));
  if (selected_index < 0 && filter) selected_index = rows.findIndex(r => r.kind === 'test');
  const selected = selected_index >= 0 ? rows[selected_index] : null;

  const tree = useRef(null);
  const search_input = useRef(null);

  const toggle = row => {
    if (filter) {
      const keys = new Set(closed ?? []);
      if (row.open) keys.add(row.key); else keys.delete(row.key);
      setFilteredClosed({ filter, keys });
      return;
    }
    const next = new Set(expanded);
    if (next.has(row.key)) next.delete(row.key); else next.add(row.key);
    setExpanded(next);
  };
  const open = (keys, add = true) => {
    const next = new Set(expanded);
    keys.forEach(k => add ? next.add(k) : next.delete(k));
    setExpanded(next);
  };
  const select = index => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (row) setSelectedKey(row.key);
  };
  const jump = direction => {
    if (!problems.length) return;
    const current = problems.findIndex(r => r.key === selected?.key);
    const next = problems[(current + direction + problems.length) % problems.length]
      ?? problems[direction > 0 ? 0 : problems.length - 1];
    const ancestors = ancestorKeys(next.test, group_keys);
    if (filter && filter(next.test)) {
      if (closed?.size) setFilteredClosed({ filter, keys: new Set([...closed].filter(k => !ancestors.includes(k))) });
    } else {
      // a failure the filter hides: we show it anyway
      if (filter) clearFilters();
      open(ancestors);
    }
    setSelectedKey(next.key);
    tree.current?.focus({ preventScroll: true });
  };
  const clearFilters = () => { setStatuses(new Set()); setChange(''); setSearch(''); };
  const toggleStatus = (status, add) => setStatuses(current => {
    const next = new Set(add ? current : []);
    if (current.has(status)) next.delete(status); else next.add(status);
    if (!add && current.size === 1 && current.has(status)) return new Set();
    return next;
  });

  // In the search box: Esc clears the filters, ↓ goes to the list
  const onSearchKeyDown = e => {
    if (e.key === 'Escape') { e.stopPropagation(); clearFilters(); tree.current?.focus(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); tree.current?.focus(); select(Math.max(0, selected_index)); }
  };
  const onKeyDown = e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const row = selected;
    const handled = {
      ArrowDown: () => select(selected_index + 1),
      ArrowUp: () => select(selected_index - 1),
      Home: () => select(0),
      End: () => select(rows.length - 1),
      PageDown: () => select(selected_index + Math.floor(height / ROW_HEIGHT)),
      PageUp: () => select(selected_index - Math.floor(height / ROW_HEIGHT)),
      ArrowRight: () => {
        if (row?.kind !== 'group') return;
        if (!row.open) toggle(row); else select(selected_index + 1);
      },
      ArrowLeft: () => {
        if (row?.kind === 'group' && row.open) return toggle(row);
        // the parent: the closest group above, one level up
        for (let i = selected_index - 1; i >= 0; i--)
          if (rows[i].kind === 'group' && rows[i].depth < row.depth) return select(i);
      },
      Enter: () => row?.kind === 'group' && toggle(row),
      ' ': () => row?.kind === 'group' && toggle(row),
      n: () => jump(1),
      p: () => jump(-1),
      N: () => jump(-1),
      '/': () => search_input.current?.focus(),
      Escape: () => clearFilters(),
      c: () => row?.kind === 'test' && copyId(row.test),
    }[e.key];
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      handled();
    }
  };

  if (parsed.error)
    return <Callout compact intent={Intent.WARNING} icon="warning-sign">Could not read <code>{path}</code>: {parsed.error}</Callout>;

  const filtered = !!filter;
  const changes = has_reference ? CHANGE_ORDER.filter(c => totals.changes[c]) : [];
  const ref_counts = ref_totals?.counts;
  return <div className="qa-junit">
    <Summary
      counts={totals.counts} ref_counts={ref_counts} time={totals.time} ref_time={ref_totals?.time}
      statuses={statuses} onToggleStatus={toggleStatus} has_reference={has_reference}
    />
    {has_reference && <div className="qa-junit-changes" role="toolbar" aria-label="Changes">
      <span className="qa-junit-muted">
        vs <SideTag color={labels.colors.reference}>{labels.reference}</SideTag>
      </span>
      {changes.length === 0 && <span className="qa-junit-muted">no test changed status</span>}
      {changes.map(c => <Tag
        key={c} interactive minimal={change !== c} intent={CHANGES[c].intent} round
        onClick={() => setChange(change === c ? '' : c)} aria-pressed={change === c}
        className="qa-junit-change-chip"
      >
        {changeCount(totals.changes[c], c)}
      </Tag>)}
    </div>}
    <div className="qa-junit-toolbar">
      <InputGroup
        inputRef={search_input} size="small" leftIcon="search" className="qa-junit-search"
        placeholder="Search tests, -word to exclude ( / )" value={search}
        onChange={e => setSearch(e.target.value)} onKeyDown={onSearchKeyDown} aria-label="Search the tests"
        rightElement={search ? <Button variant="minimal" size="small" icon="cross" aria-label="Clear the search" onClick={() => setSearch('')}/> : undefined}
      />
      {has_reference && <HTMLSelect
        minimal value={change} onChange={e => setChange(e.target.value)} aria-label="Changes vs the reference"
        options={[
          { value: '', label: 'All tests' },
          { value: 'changed', label: 'Changed vs reference' },
          ...CHANGE_ORDER.filter(c => totals.changes[c]).map(c => ({ value: c, label: `${CHANGES[c].label} (${totals.changes[c]})` })),
        ]}
      />}
      <HTMLSelect minimal value={sort} onChange={e => setSort(e.target.value)} options={SORT_OPTIONS} aria-label="Sort"/>
      <ButtonGroup variant="minimal" size="small">
        <Tooltip content="Open all groups" compact><Button icon="expand-all" aria-label="Open all groups" disabled={filtered} onClick={() => setExpanded(new Set(group_keys))}/></Tooltip>
        <Tooltip content="Close all groups" compact><Button icon="collapse-all" aria-label="Close all groups" disabled={filtered} onClick={() => setExpanded(new Set())}/></Tooltip>
        <Tooltip content="Previous failure (p)" compact><Button icon="arrow-up" aria-label="Previous failure" disabled={!problems.length} onClick={() => jump(-1)}/></Tooltip>
        <Tooltip content="Next failure (n)" compact><Button icon="arrow-down" aria-label="Next failure" disabled={!problems.length} onClick={() => jump(1)}/></Tooltip>
      </ButtonGroup>
      <span className="qa-junit-spacer"/>
      <span className="qa-junit-muted qa-junit-shown" aria-live="polite">
        {filtered ? `${shown.toLocaleString()} of ${plural(totals.counts.tests + totals.counts.removed, 'test')}` : plural(totals.counts.tests, 'test')}
      </span>
      {filtered && <Button size="small" variant="minimal" icon="filter-remove" onClick={clearFilters}>Clear</Button>}
      <PopoverNext content={<table className="qa-junit-shortcuts"><tbody>
        {SHORTCUTS.map(([keys, action]) => <tr key={keys}><td><kbd>{keys}</kbd></td><td>{action}</td></tr>)}
      </tbody></table>} placement="bottom-end">
        <Button size="small" variant="minimal" icon="key-command" aria-label="Keyboard shortcuts"/>
      </PopoverNext>
    </div>
    <div className="qa-junit-body">
      <div className="qa-junit-tree-pane">
        {rows.length === 0
          ? <div style={{ height }} className="qa-junit-empty">
              {tests.length === 0
                ? <NonIdealState icon="lab-test" title="No tests" description="The report has no test cases."/>
                : <NonIdealState icon="search" title="No tests match" action={<Button icon="filter-remove" onClick={clearFilters}>Clear the filters</Button>}/>}
            </div>
          : <TreeList
              rows={rows} selected_index={selected_index} words={words} has_reference={has_reference} visible={visible}
              height={height} tree={tree} onToggle={toggle} onSelect={select} onKeyDown={onKeyDown}
            />}
      </div>
      <Details
        row={selected} labels={labels} has_reference={has_reference}
        onFilter={text => setSearch(text)}
        onExpandAll={node => open([node.key, ...allGroupKeys(node)])}
      />
    </div>
  </div>;
}

// The visualization: the run's report, and the reference run's
const JunitViewer = ({ output_new, output_ref, path, labels, height }) => {
  const url_new = output_new?.output_dir_url && path ? `${output_new.output_dir_url}/${path}` : undefined;
  const url_ref = url_new && output_ref?.output_dir_url ? `${output_ref.output_dir_url}/${path}` : undefined;
  const query_new = useQuery(fileQuery(url_new, { is_running: output_new?.is_running, responseType: 'text' }));
  // without the reference's report, we show the new one alone
  const query_ref = useQuery(fileQuery(url_ref, { is_running: output_ref?.is_running, responseType: 'text' }));
  if (query_new.isError) return <ViewerError path={path} error={query_new.error}/>;
  if (!url_new || query_new.isPending || (url_ref && query_ref.isPending)) return <ViewerLoading height={height}/>;
  return <JunitReport
    xml={query_new.data} ref_xml={query_ref.isSuccess ? query_ref.data : null} labels={labels} path={path}
    height={height ? parseInt(height, 10) || undefined : undefined}
  />;
};

export default JunitViewer;
