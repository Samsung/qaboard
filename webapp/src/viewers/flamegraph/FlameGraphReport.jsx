// The flame graph viewer, given the files' text: the new run's profile against the reference's, a differential
// flame graph by default, with a search, the layout's options and a table of the top functions.
// flame-graph.jsx fetches the files; the playground (/flame-graph-viewer.html) gives generated ones.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  ButtonGroup,
  Callout,
  Classes,
  Colors,
  HTMLSelect,
  Icon,
  InputGroup,
  Intent,
  PopoverNext,
  SegmentedControl,
  Tooltip,
} from "@blueprintjs/core";

import FlameChart from './FlameChart';
import { TopFunctions } from './TopFunctions';
import { parseProfile, selectTree } from './formats';
import { MAX_DEPTH_DRAWN, drawnTree, formatDelta, formatPoints, formatShare, formatValue, makeMatcher, matchedValue, topFunctions } from './profile';


const parse = (text, path, unit) => {
  if (text === undefined || text === null) return {};
  try {
    return { profile: parseProfile(text, path, { unit }) };
  } catch (error) {
    return { error };
  }
};

// Matches drawn in the main graph, the biggest first: what "next" and "previous" go through
const drawnMatches = (tree, matches) => {
  if (!tree || !matches) return [];
  const found = [];
  const stack = [tree];
  while (stack.length) {
    const node = stack.pop();
    if (matches(node.name)) found.push(node);
    for (const child of node.children) stack.push(child);
  }
  return found.sort((a, b) => b.value - a.value).slice(0, 1000);
};

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The chart's width: its container's
const useWidth = () => {
  const ref = useRef(null);
  const [width, setWidth] = useState(1180);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const measured = Math.floor(entry.contentRect.width);
      // small changes (scrollbars...) don't redraw the graph
      if (measured > 200) setWidth(current => Math.abs(current - measured) > 8 ? measured : current);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
};


export const FlameGraphReport = ({ text_new, text_ref, path = '', path_ref, unit, labels, max_width = 1180 }) => {
  const [comparaison, setComparaison] = useState('diff-what-did-happen'); // 'diff-what-will-happen' | 'new' | 'ref' | 'both'
  const [mode, setMode] = useState('share'); // or 'absolute'
  const [inverted, setInverted] = useState(true);
  const [sort, setSort] = useState('name'); // or 'heaviest'
  const [which, setWhich] = useState('all');
  const [query, setQuery] = useState('');
  const [regex, setRegex] = useState(true);
  const [matchCase, setMatchCase] = useState(false);
  const [current, setCurrent] = useState(-1);
  const [zoomTo, setZoomTo] = useState(null);
  const [selected, setSelected] = useState(null);
  const [ref, measured] = useWidth();
  const width = Math.min(max_width, measured);

  // Large profiles take a while to parse (about 300 ms for 250,000 stacks): we don't do it again when the search
  // or the options change. useMemo is explicit: the React Compiler didn't memoize these.
  const parsed_new = useMemo(() => parse(text_new, path, unit), [text_new, path, unit]);
  const parsed_ref = useMemo(() => parse(text_ref, path_ref ?? path, unit), [text_ref, path_ref, path, unit]);
  const profile_new = parsed_new.profile;
  const profile_ref = parsed_ref.profile;
  const tree_new = useMemo(() => selectTree(profile_new, which), [profile_new, which]);
  const tree_ref = useMemo(() => selectTree(profile_ref, profile_ref?.profiles?.[which] ? which : 'all'), [profile_ref, which]);
  const has_ref = !!tree_new && !!tree_ref && tree_ref.value > 0;
  const view = has_ref ? comparaison : 'new';

  const drawn_new = useMemo(() => tree_new ? drawnTree(tree_new, has_ref ? tree_ref : undefined, { mode }) : undefined, [tree_new, tree_ref, has_ref, mode]);
  const drawn_ref = useMemo(() => has_ref ? drawnTree(tree_ref, tree_new, { mode, side: 'reference' }) : undefined, [tree_new, tree_ref, has_ref, mode]);
  const main_tree = view === 'diff-what-will-happen' || view === 'ref' ? drawn_ref : drawn_new;

  const matcher = useMemo(() => makeMatcher(query, { regex, matchCase }), [query, regex, matchCase]);
  const search = useMemo(() => ({ query, matches: matcher }), [query, matcher]);
  const matched = drawnMatches(main_tree, matcher);
  const share_new = matcher && tree_new?.value ? matchedValue(tree_new, matcher) / tree_new.value : undefined;
  const share_ref = matcher && has_ref ? matchedValue(tree_ref, matcher) / tree_ref.value : undefined;
  const rows = useMemo(() => tree_new ? topFunctions(tree_new, has_ref ? tree_ref : undefined, { mode }) : [], [tree_new, tree_ref, has_ref, mode]);

  if (parsed_new.error) return <Callout compact intent={Intent.WARNING} icon="warning-sign" style={{ margin: '5px 0' }}>
    Could not read <code>{path}</code> as a profile: {parsed_new.error.message}
  </Callout>;
  if (!profile_new) return null;

  const unit_name = profile_new.unit;
  const { new: label_new = 'new', reference: label_ref = 'reference' } = labels ?? {};
  const total_new = tree_new?.value ?? 0;
  const total_ref = tree_ref?.value ?? 0;

  // what tooltips and screen readers say about a frame: total and self, in the unit and %, against the other profile
  const describer = side => data => {
    const [total, other_total, other_label] = side === 'reference' ? [total_ref, total_new, label_new] : [total_new, total_ref, label_ref];
    const self = data.self ?? 0;
    const lines = [
      ['Total', `${formatValue(data.value, unit_name)} · ${formatShare(data.value / total)}`],
      ['Self', `${formatValue(self, unit_name)} · ${formatShare(self / total)}`],
    ];
    if (!has_ref) return lines;
    if (data.other_value === undefined) {
      lines.push([other_label, side === 'reference' ? 'not there: removed' : 'not there: new']);
      return lines;
    }
    lines.push([`${other_label}, total`, `${formatValue(data.other_value, unit_name)} · ${formatShare(data.other_value / other_total)}`]);
    lines.push([`${other_label}, self`, `${formatValue(data.other_self ?? 0, unit_name)} · ${formatShare((data.other_self ?? 0) / other_total)}`]);
    const [now, now_total, before, before_total] = side === 'reference'
      ? [data.other_value, other_total, data.value, total]
      : [data.value, total, data.other_value, other_total];
    lines.push([`Change vs ${label_ref}`, mode === 'share' ? formatPoints(now / now_total - before / before_total) : formatDelta(now - before, unit_name)]);
    return lines;
  };

  const go = step => {
    if (!matched.length) return;
    const next = (current + step + matched.length) % matched.length;
    setCurrent(next);
    setZoomTo({ key: matched[next].key });
  };
  const onQuery = value => {
    setQuery(value);
    setCurrent(-1);
    setSelected(null);
  };
  const onSelect = name => {
    setSelected(name);
    setRegex(true);
    setQuery(name === null ? '' : `^${escapeRegex(name)}$`);
    setCurrent(-1);
  };

  const charts = [];
  const chart = (key, data, props) => charts.push(<FlameChart
    key={key}
    data={data}
    width={width}
    inverted={inverted}
    sort={sort}
    search={search}
    zoomTo={zoomTo}
    {...props}
  />);
  if (view === 'diff-what-did-happen')
    chart('new-diff', drawn_new, { differential: true, describe: describer('new') });
  else if (view === 'diff-what-will-happen')
    chart('ref-diff', drawn_ref, { differential: true, describe: describer('reference') });
  else {
    if (view === 'new' || view === 'both')
      chart('new', drawn_new, { title: view === 'both' ? label_new : undefined, describe: describer('new') });
    if (view === 'ref' || view === 'both')
      chart('ref', drawn_ref, { title: view === 'both' ? label_ref : undefined, describe: describer('reference') });
  }

  const differential = view.startsWith('diff');
  const profiles = profile_new.profiles;
  return <div className="qa-flame-graph" ref={ref}>
    <div className="qa-flame-toolbar">
      <InputGroup
        value={query}
        type="search"
        aria-label="Highlight frames: a function's name, or a regular expression"
        placeholder="Highlight frames"
        intent={query ? (matched.length || share_new ? Intent.PRIMARY : Intent.WARNING) : undefined}
        leftIcon="search"
        onChange={e => onQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1); }
          if (e.key === 'Escape') onQuery('');
        }}
        style={{ width: 260 }}
        rightElement={<ButtonGroup variant="minimal">
          <Tooltip content={regex ? 'Regular expression (lock|wait): on' : 'Regular expression: off, plain text'} openOnTargetFocus={false}>
            <Button size="small" active={regex} aria-pressed={regex} aria-label="Regular expression" onClick={() => setRegex(!regex)} text=".*"/>
          </Tooltip>
          <Tooltip content={matchCase ? 'Match case: on' : 'Match case: off'} openOnTargetFocus={false}>
            <Button size="small" active={matchCase} aria-pressed={matchCase} aria-label="Match case" onClick={() => setMatchCase(!matchCase)} text="Aa"/>
          </Tooltip>
        </ButtonGroup>}
      />
      {query && <>
        <ButtonGroup>
          <Button size="small" icon="chevron-up" aria-label="Previous match (Shift+Enter)" title="Previous match (Shift+Enter)" disabled={!matched.length} onClick={() => go(-1)}/>
          <Button size="small" icon="chevron-down" aria-label="Next match (Enter)" title="Next match (Enter)" disabled={!matched.length} onClick={() => go(1)}/>
        </ButtonGroup>
        <span role="status" className="qa-flame-muted">
          {matched.length ? `${current >= 0 ? `${current + 1} of ` : ''}${matched.length.toLocaleString('en-US')}${matched.length === 1000 ? '+' : ''} frame${matched.length === 1 ? '' : 's'}` : 'No frames'}
          {share_new !== undefined && <> · <strong>{formatShare(share_new)}</strong> of {has_ref ? label_new : 'the profile'}</>}
          {share_ref !== undefined && <> · {formatShare(share_ref)} of {label_ref}</>}
          {matcher?.invalid && ' · not a valid regular expression: searched as text'}
        </span>
      </>}
      <span style={{ flex: 1 }}/>
      <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {has_ref && <Tooltip content="Two runs rarely take the same number of samples: by default colors and changes compare each function's share of its profile." placement="top" openOnTargetFocus={false}>
          <SegmentedControl
            aria-label="Compare"
            size="small"
            options={[{ value: 'share', label: 'Shares' }, { value: 'absolute', label: 'Absolute' }]}
            value={mode}
            onValueChange={setMode}
          />
        </Tooltip>}
        <SegmentedControl
          aria-label="Layout"
          size="small"
          options={[{ value: 'icicle', label: 'Icicle', icon: 'chevron-down' }, { value: 'flame', label: 'Flame', icon: 'chevron-up' }]}
          value={inverted ? 'icicle' : 'flame'}
          onValueChange={value => setInverted(value === 'icicle')}
        />
        <Tooltip content="By name, the same function is in the same place in both profiles. Heaviest first puts the widest frames on the left." placement="top" openOnTargetFocus={false}>
          <SegmentedControl
            aria-label="Order"
            size="small"
            options={[{ value: 'name', label: 'By name' }, { value: 'heaviest', label: 'Heaviest first' }]}
            value={sort}
            onValueChange={setSort}
          />
        </Tooltip>
      </span>
    </div>

    {charts}

    <div className="qa-flame-legend">
      {differential && <span>
        <span className="qa-flame-swatch" style={{ background: 'rgb(220,90,90)' }}/>more than {label_ref}{' '}
        <span className="qa-flame-swatch" style={{ background: 'rgb(90,90,220)', marginLeft: 8 }}/>less{' '}
        <span className="qa-flame-swatch" style={{ background: 'rgb(255,190,90)', marginLeft: 8 }}/>new{' '}
        <span className="qa-flame-swatch" style={{ background: 'rgb(220,220,220)', marginLeft: 8 }}/>same
      </span>}
      <span>
        {has_ref
          ? <>{mode === 'share' ? 'Comparing shares of each profile' : 'Comparing absolute values'}: {label_new} {formatValue(total_new, unit_name)}, {label_ref} {formatValue(total_ref, unit_name)}</>
          : <>{formatValue(total_new, unit_name)}</>}
        {profile_new.note && ` · values in ${unit_name} ${profile_new.note}`}
      </span>
      {main_tree?.too_deep && <span>Frames deeper than {MAX_DEPTH_DRAWN.toLocaleString('en-US')} are not drawn: the search and the table count them.</span>}
      {parsed_ref.error && <span>The reference's profile could not be read: {parsed_ref.error.message}</span>}
    </div>

    <div>
      <HTMLSelect
        onChange={e => setComparaison(e.currentTarget.value)}
        value={view}
        style={{ marginBottom: '8px' }}
        disabled={!has_ref}
        options={[
          { value: 'diff-what-did-happen', label: `What did happen (runtimes from ${label_new}, colored by the improvement vs ${label_ref})` },
          { value: 'diff-what-will-happen', label: `What will happen (runtimes from ${label_ref}, colored by the change in ${label_new})` },
          { value: 'new', label: `After (${label_new})` },
          { value: 'ref', label: `Before (${label_ref})` },
          { value: 'both', label: 'After & Before' },
        ]}
      />
      {profiles.length > 1 && <HTMLSelect
        aria-label="Profile"
        value={which}
        onChange={e => setWhich(e.currentTarget.value === 'all' ? 'all' : Number(e.currentTarget.value))}
        style={{ marginLeft: 8 }}
        options={[
          { value: 'all', label: `All ${profiles.length} profiles, merged` },
          ...profiles.map((p, i) => ({ value: i, label: p.name })),
        ]}
      />}
      <PopoverNext
        hoverCloseDelay={500}
        interactionKind={"hover"}
        inheritDarkTheme
        popoverClassName={Classes.DARK}
        content={<div style={{ padding: '15px', maxWidth: 420 }}>
          <p>Click a frame to zoom on it, <kbd>Esc</kbd> to zoom out. With the keyboard: <kbd>Tab</kbd> to the graph, arrows to move, <kbd>Enter</kbd> to zoom.</p>
          <p>Read about <a rel="noopener noreferrer" href="http://www.brendangregg.com/flamegraphs.html" target="_blank">Flame Graphs</a></p>
          <p>And the <a rel="noopener noreferrer" href="http://www.brendangregg.com/blog/2014-11-09/differential-flame-graphs.html" target="_blank">Differential Flame Graphs</a> versions</p>
        </div>}
      >
        <Icon icon="info-sign" tabIndex={0} aria-label="About flame graphs" style={{ marginLeft: '8px', color: Colors.GRAY2 }}/>
      </PopoverNext>
    </div>

    <TopFunctions
      rows={rows}
      unit={unit_name}
      mode={mode}
      has_reference={has_ref}
      matches={selected ? null : matcher}
      selected={selected}
      onSelect={onSelect}
      labels={labels}
    />
  </div>;
};

export default FlameGraphReport;
