// The Tuning Analysis view of a batch whose runs differ by their parameters, without `qa optimize`: a grid, a sampling,
// values tried by hand. Which parameter set is the best, how sure we are, and what to do next: the same page as for an
// automated tuning (OptimizationReport.jsx), written for people who aren't optimization experts.
// The logic is in analysis.js.
import { useMemo, useState } from "react";
import styled from "styled-components";
import {
  Button, ButtonGroup, Callout, Card, Classes, Colors, HTMLSelect, HTMLTable, Icon, Intent, SegmentedControl, Tag, Tooltip,
} from "@blueprintjs/core";

import Plot from "../Plot";
import { format, metric_info } from "../../utils";
import { useIsDark } from "../../theme";
import { updateSelected, useSelected, useSiteConfig } from "../../hooks";
import { usePrefsStore } from "../../stores/prefs";
import { analyze, compare, insights as get_insights, varying_metrics, pareto_front, as_search_space, set_filter } from "./analysis";
import { from_space } from "./optimize_config";
import {
  plot_config, num, value_text, plural, Code, Report, Header, Tiles, Columns, Small, Scroll, ParamTable, RangeBar,
  ImportanceBar, useTryParameters, CopyMenu, InsightList, intents,
} from "./report";
import Learn from "./learn";
import ParallelCoordinatesPlot from "./ParallelCoordinatesPlot";
import { MetricsScript } from "../../plugins/ScriptPlugin";

const goal_options = [
  { value: 'max', label: 'Higher is better' },
  { value: 'min', label: 'Lower is better' },
];
const url_defaults = { aggregation: 'average' };
const select = changes => updateSelected(changes, { defaults: url_defaults, replace: true });

// which way is better: what the project declares, else what the user says
const declared_goal = info => info?.smaller_is_better === true ? 'min' : info?.smaller_is_better === false ? 'max' : null;

const TestTable = styled(HTMLTable)`
  && td, && th { white-space: nowrap; font-variant-numeric: tabular-nums; }
  && td.qa-tuning-heat { background: color-mix(in srgb, var(--qa-tuning-bad, #c87619) calc(var(--heat) * 45%), transparent); }
  && td.qa-tuning-test { max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
  && th.qa-tuning-best, && td.qa-tuning-best { border-left: 2px solid var(--qa-intent-primary); border-right: 2px solid var(--qa-intent-primary); }
`;

const Controls = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 10px 12px;
  border-radius: 4px;
  background: var(--qa-surface-alt);
  label { font-weight: 600; }
`;

const set_name = set => set.is_default ? 'the defaults' : `#${set.id}`;
const params_text = (set, parameters) => parameters.map(p => `${p.name}: ${value_text(set.params[p.name], p)}`).join(', ');
const ParamTags = ({ set, parameters }) => set.is_default
  ? <Tag minimal round>defaults</Tag>
  : parameters.map(p => <Tag key={p.name} minimal round style={{ margin: 2 }}>{p.name}: {set.params[p.name] === undefined ? 'default' : value_text(set.params[p.name], p)}</Tag>);


const insight_content = (insight, { metric_name, value, onOpenLogs, onRunBest, onAutomate, names }) => {
  const { kind } = insight;
  if (kind === 'failed')
    return {
      icon: 'error', title: `${plural(insight.runs, 'run')} failed`,
      text: <>In {plural(insight.sets, 'parameter set')}. Failed runs are left out; a set that misses tests is left out of the ranking. The logs say what went wrong.</>,
      action: <Button size="small" icon="console" text="Open the logs" onClick={onOpenLogs}/>,
    };
  if (kind === 'pending')
    return {
      icon: 'time', title: `${plural(insight.runs, 'run')} still running`,
      text: <>The numbers below will change: the page updates as runs finish.</>,
    };
  if (kind === 'confounded')
    return {
      icon: 'warning-sign', title: 'Each test ran with a single parameter set',
      text: <>The parameters differ from test to test, so a difference in {metric_name} can come from the test as much as from
        the parameters. To compare parameters, run the same tests with each set: <strong>Run Tests / Tuning</strong> does it.</>,
    };
  if (kind === 'partial')
    return {
      icon: 'warning-sign', title: `${plural(insight.sets, 'parameter set')} ${insight.sets === 1 ? 'is' : 'are'} missing tests`,
      text: <>{insight.sets === 1 ? 'It has' : 'They have'} {metric_name} on fewer than {plural(insight.coverage, 'test')}: comparing
        {insight.sets === 1 ? ' its' : ' their'} average with the others' wouldn't be fair, so {insight.sets === 1 ? "it isn't" : "they aren't"} ranked.
        To fill the gaps, start the batch again with <strong>Overwrite</strong> off: only the missing runs start.</>,
    };
  if (kind === 'flat')
    return {
      icon: 'minus', title: <>These parameters barely change {metric_name}</>,
      text: <>It varies by under 0.5% between parameter sets. Try wider ranges or other parameters, or compare the sets with another metric, above.</>,
    };
  if (kind === 'edge') {
    const { name, side, parameter } = insight;
    return {
      icon: 'arrows-horizontal', title: <>The best <Code>{name}</Code> is the {side === 'low' ? 'lowest' : 'highest'} value you tried</>,
      text: <>{value_text(insight.value, parameter)} is at the {side === 'low' ? 'bottom' : 'top'} of what was tried ({num(parameter.low)} to {num(parameter.high)}):
        better values may be {side === 'low' ? 'below' : 'above'} it. If they make sense for your code, try some.</>,
    };
  }
  if (kind === 'tests_disagree') {
    const { worst } = insight;
    return {
      icon: 'th-disconnect', title: <>The best on average is the best on {insight.wins} of {plural(insight.tests, 'test')}</>,
      text: <>Tests want different values.{worst && <> On <em>{names[worst.test]}</em>, {set_name(worst.set)} gets {value(worst.best)} against {value(worst.value)}.</>}
        {' '}<strong>Test by test</strong>, below, shows where the best set loses: decide whether one compromise is fine, or whether some kinds of tests need their own values.</>,
    };
  }
  if (kind === 'unimportant')
    return {
      icon: 'filter', title: <>{insight.names.map((n, i) => <span key={n}>{i > 0 && (i === insight.names.length - 1 ? ' and ' : ', ')}<Code>{n}</Code></span>)} barely matter{insight.names.length === 1 ? 's' : ''}</>,
      text: <>{insight.names.length === 1 ? 'It explains' : 'Each explains'} under 5% of how {metric_name} varies, in the range tried. Next time, leave {insight.names.length === 1 ? 'it' : 'them'} at
        one value: fewer combinations to run.</>,
      learn: 'impact',
    };
  if (kind === 'one_test')
    return {
      icon: 'eye-open', title: 'Tuned on a single test',
      text: <>The best parameters may only be the best for this one. Run them on more tests before adopting them.</>,
      learn: 'overfitting',
      action: onRunBest && <Button size="small" icon="play" text="Run on other tests…" onClick={onRunBest}/>,
    };
  if (kind === 'automate')
    return {
      icon: 'predictive-analysis', title: 'Next: let QA-Board search around the best',
      text: <>You tried {plural(insight.sets, 'parameter set')}. <strong>Automated tuning</strong> tries the values in between, and spends its runs where
        results are good: it usually finds better parameters with fewer runs than a finer grid. It starts from the ranges of this batch.</>,
      learn: 'search',
      action: onAutomate && <Button size="small" intent={Intent.PRIMARY} icon="predictive-analysis" text="Set up the search…" onClick={onAutomate} data-testid="automate"/>,
    };
  return null;
};


// One parameter against the metric: a dot per parameter set, and the average at each value
const ParameterEffect = ({ parameter, comparison, y_title, scale, suffix, importance, dark }) => {
  const sets = comparison.ranked;
  const primary = dark ? Colors.BLUE4 : Colors.BLUE3;
  const categorical = parameter.type === 'categorical';
  const x_of = set => {
    const v = set.params[parameter.name];
    if (v === undefined) return categorical ? '(default)' : null;
    return categorical ? value_text(v, parameter) : v;
  };
  const points = sets.map(set => ({ x: x_of(set), y: set.metrics[comparison.metric] * scale, set })).filter(p => p.x !== null);
  const by_value = new Map();
  for (const p of points) by_value.set(p.x, [...(by_value.get(p.x) ?? []), p.y]);
  const means = [...by_value.entries()].map(([x, ys]) => [x, ys.reduce((a, b) => a + b, 0) / ys.length]);
  if (!categorical) means.sort((a, b) => a[0] - b[0]);
  const repeated = points.length > by_value.size;
  const traces = [{
    type: 'scatter', mode: 'markers',
    x: points.map(p => p.x), y: points.map(p => p.y),
    text: points.map(p => `#${p.set.id}<br>${params_text(p.set, comparison.parameters).replace(/, /g, '<br>')}`),
    marker: { size: 7, opacity: repeated ? 0.55 : 0.9, color: repeated ? (dark ? Colors.GRAY4 : Colors.GRAY3) : primary },
    hovertemplate: `${y_title} %{y:.4g}<br>%{text}<extra></extra>`,
  }];
  if (repeated || !categorical)
    traces.push({
      type: 'scatter', mode: categorical ? 'markers' : 'lines+markers', name: 'Average',
      x: means.map(m => m[0]), y: means.map(m => m[1]),
      line: { color: primary, width: 2 }, marker: { color: primary, size: categorical ? 11 : 6, symbol: categorical ? 'line-ew-open' : 'circle', line: { color: primary, width: 3 } },
      hovertemplate: `${parameter.name}: %{x}<br>Average ${y_title} %{y:.4g}<extra></extra>`,
    });
  const best = comparison.best;
  if (best && x_of(best) !== null)
    traces.push({
      type: 'scatter', mode: 'markers',
      x: [x_of(best)], y: [best.metrics[comparison.metric] * scale],
      marker: { symbol: 'star', size: 15, color: primary, line: { color: dark ? Colors.DARK_GRAY3 : Colors.WHITE, width: 1.5 } },
      hovertemplate: `Best: ${parameter.name} %{x}<br>${y_title} %{y:.4g}<extra></extra>`,
    });
  const layout = {
    height: 220, margin: { t: 8, r: 10, b: 40, l: 56 }, showlegend: false, hovermode: 'closest',
    xaxis: categorical
      ? { type: 'category', zeroline: false, automargin: true, tickangle: parameter.values.some(c => String(c).length > 8) ? -25 : 0 }
      : { type: parameter.log ? 'log' : 'linear', zeroline: false },
    yaxis: { title: { text: y_title }, zeroline: false, ticksuffix: suffix },
  };
  return <Card compact className="qa-optim-small" data-testid={`effect-${parameter.name}`}>
    <h4><Code>{parameter.name}</Code>{typeof importance === 'number' && <span className={Classes.TEXT_MUTED} style={{ fontWeight: 400 }}>{Math.round(importance * 100)}% impact</span>}</h4>
    <Plot data={traces} layout={layout} config={plot_config} style={{ width: '100%' }} useResizeHandler/>
  </Card>;
};


// Two metrics against each other: the parameter sets nothing else beats on both are the choices worth considering
const TradeOffs = ({ comparison, parameters, metrics, info_of, goal_of, second, dark, onRun }) => {
  const mx = comparison.metric, my = second;
  const gx = comparison.goal, gy = goal_of(my);
  const sets = comparison.ranked.filter(s => typeof s.metrics[my] === 'number');
  const scale = m => info_of(m).scale ?? 1;
  const front_ids = useMemo(() => gx && gy ? new Set(pareto_front(sets, [mx, my], [gx, gy])) : new Set(), [sets, mx, my, gx, gy]);
  const front = sets.filter(s => front_ids.has(s.id)).sort((a, b) => a.metrics[mx] - b.metrics[mx]);
  const primary = dark ? Colors.BLUE4 : Colors.BLUE3;
  const hover = s => `#${s.id}<br>${params_text(s, parameters).replace(/, /g, '<br>')}`;
  const direction = g => g === 'max' ? 'higher is better' : g === 'min' ? 'lower is better' : 'which way is better?';
  const traces = [
    { type: 'scatter', mode: 'markers', name: 'Parameter set', x: sets.map(s => s.metrics[mx] * scale(mx)), y: sets.map(s => s.metrics[my] * scale(my)), text: sets.map(hover), marker: { color: Colors.GRAY3, size: 8, opacity: 0.6 }, hovertemplate: '%{text}<extra></extra>' },
    ...(front.length ? [{ type: 'scatter', mode: 'lines+markers', name: 'Best trade-offs', x: front.map(s => s.metrics[mx] * scale(mx)), y: front.map(s => s.metrics[my] * scale(my)), text: front.map(hover), line: { color: primary, width: 2, dash: 'dot' }, marker: { color: primary, size: 11 }, hovertemplate: '%{text}<extra></extra>' }] : []),
    ...(comparison.best && typeof comparison.best.metrics[my] === 'number' ? [{ type: 'scatter', mode: 'markers', name: `Best ${info_of(mx).label}`, x: [comparison.best.metrics[mx] * scale(mx)], y: [comparison.best.metrics[my] * scale(my)], marker: { symbol: 'star', size: 16, color: primary, line: { color: dark ? Colors.DARK_GRAY3 : Colors.WHITE, width: 1.5 } }, hoverinfo: 'skip' }] : []),
  ];
  const layout = {
    height: 360, margin: { t: 24, r: 16, b: 50, l: 70 }, hovermode: 'closest',
    legend: { orientation: 'h', x: 1, xanchor: 'right', y: 1.1 },
    xaxis: { title: { text: `${info_of(mx).label} (${direction(gx)})` }, ticksuffix: info_of(mx).suffix ?? '', zeroline: false },
    yaxis: { title: { text: `${info_of(my).label} (${direction(gy)})` }, ticksuffix: info_of(my).suffix ?? '', zeroline: false },
  };
  const value = (m, v) => typeof v === 'number' ? `${format(v * scale(m), { precision: 3 })}${info_of(m).suffix ?? ''}` : '—';
  return <section className="qa-optim-section" aria-labelledby="tuning-tradeoffs" data-testid="tradeoffs">
    <header>
      <h3 id="tuning-tradeoffs"><Icon icon="scatter-plot" className={Classes.TEXT_MUTED}/>Trade-offs with another metric <Learn topic="pareto"/></h3>
      <HTMLSelect aria-label="The other metric" value={my} onChange={e => select({ selected_metric2: e.target.value, goal2: undefined })} options={metrics.filter(m => m !== mx).map(m => ({ value: m, label: info_of(m).label }))}/>
    </header>
    <p className={`qa-optim-how ${Classes.TEXT_MUTED}`}>
      Each dot is a parameter set. {front.length > 0
        ? <>The highlighted ones are the best trade-offs: nothing else is better on both metrics. If the best {info_of(mx).label} costs too much {info_of(my).label}, pick another one on the line.</>
        : <>Say which way is better for {info_of(gy ? mx : my).label} to highlight the best trade-offs.</>}
    </p>
    {!gy && <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <span>For {info_of(my).label}:</span>
      <SegmentedControl size="small" aria-label={`Which way is better for ${info_of(my).label}`} options={goal_options} value={''} onValueChange={goal2 => select({ goal2 })}/>
    </div>}
    <Plot data={traces} layout={layout} config={plot_config} style={{ width: '100%' }} useResizeHandler/>
    {front.length > 1 && <Scroll><HTMLTable compact style={{ width: '100%' }}>
      <thead><tr><th>Set</th><th>{info_of(mx).label}</th><th>{info_of(my).label}</th><th>Parameters</th><th aria-label="Actions"/></tr></thead>
      <tbody>
        {front.slice(0, 12).map(s => <tr key={s.id}>
          <td className="qa-optim-num">#{s.id}{s === comparison.best && <Icon icon="crown" size={12} intent={Intent.PRIMARY} style={{ marginLeft: 6 }}/>}</td>
          <td className="qa-optim-num">{value(mx, s.metrics[mx])}</td>
          <td className="qa-optim-num">{value(my, s.metrics[my])}</td>
          <td><ParamTags set={s} parameters={parameters}/></td>
          <td style={{ whiteSpace: 'nowrap' }}><Button size="small" icon="play" text="Run…" onClick={() => onRun(s)}/></td>
        </tr>)}
      </tbody>
    </HTMLTable></Scroll>}
  </section>;
};


// Each test's metric for the best parameter sets: where the best on average loses
const TestByTest = ({ analysis, comparison, value, better }) => {
  const [all, setAll] = useState(false);
  const { best, metric } = comparison;
  const columns = comparison.ranked.slice(0, 8);
  const baseline = comparison.baseline;
  if (baseline && !columns.includes(baseline)) columns.push(baseline);
  const rows = useMemo(() => {
    const regret = new Map(comparison.regrets.map(r => [r.test, Math.abs(r.value - r.best)]));
    return analysis.tests
      .filter(test => comparison.ranked.some(s => typeof s.tests.get(test)?.metrics?.[metric] === 'number'))
      .sort((a, b) => (regret.get(b) ?? 0) - (regret.get(a) ?? 0));
  }, [analysis, comparison, metric]);
  const shown = all ? rows : rows.slice(0, 12);
  return <section className="qa-optim-section" aria-labelledby="tuning-tests" data-testid="test-by-test">
    <header><h3 id="tuning-tests"><Icon icon="th" className={Classes.TEXT_MUTED}/>Test by test</h3></header>
    <p className={`qa-optim-how ${Classes.TEXT_MUTED}`}>
      The {columns.length === comparison.ranked.length ? '' : `${columns.length} best `}parameter sets on each test, the best on average first. A cell is darker the further it is from
      that test's best. The tests where the best set loses the most come first: if it is dark there, look at those runs before adopting it.
    </p>
    <Scroll><TestTable compact striped>
      <thead><tr>
        <th>Test</th>
        {columns.map(s => <th key={s.id} className={s === best ? 'qa-tuning-best' : undefined}>
          <Tooltip content={params_text(s, analysis.parameters) || 'The defaults'} hoverOpenDelay={200}><span>{s.is_default ? 'defaults' : `#${s.id}`}{s === best && <Icon icon="crown" size={12} intent={Intent.PRIMARY} style={{ marginLeft: 4 }}/>}</span></Tooltip>
        </th>)}
      </tr></thead>
      <tbody>
        {shown.map(test => {
          const values = columns.map(s => s.tests.get(test)?.metrics?.[metric]);
          const numbers = values.filter(v => typeof v === 'number');
          const row_best = numbers.reduce((a, b) => better(b, a) ? b : a, numbers[0]);
          const row_worst = numbers.reduce((a, b) => better(a, b) ? b : a, numbers[0]);
          const range = Math.abs(row_worst - row_best);
          return <tr key={test}>
            <td className="qa-tuning-test" title={analysis.names[test]}>{analysis.names[test]}</td>
            {columns.map((s, i) => {
              const v = values[i];
              const heat = typeof v === 'number' && range > 0 ? Math.abs(v - row_best) / range : 0;
              return <td key={s.id} className={`qa-tuning-heat${s === best ? ' qa-tuning-best' : ''}`} style={{ '--heat': heat.toFixed(3), fontWeight: v === row_best ? 600 : undefined }}>{value(v)}</td>;
            })}
          </tr>;
        })}
      </tbody>
    </TestTable></Scroll>
    {rows.length > 12 && <Button variant="minimal" size="small" icon={all ? 'chevron-up' : 'chevron-down'} onClick={() => setAll(!all)} style={{ marginTop: 6 }}>
      {all ? 'Show fewer tests' : `Show all ${rows.length} tests`}
    </Button>}
  </section>;
};


const SetsTable = ({ analysis, comparison, metrics, info_of, value_of, selection, onRun }) => {
  const [all, setAll] = useState(false);
  const { best, metric } = comparison;
  const rows = [...comparison.ranked, ...comparison.partial, ...analysis.sets.filter(s => typeof s.metrics[metric] !== 'number')]
    .filter(s => !selection || selection.has(s.id));
  const shown = all ? rows : rows.slice(0, 10);
  const partial = new Set(comparison.partial);
  return <section className="qa-optim-section" aria-labelledby="tuning-sets">
    <header>
      <h3 id="tuning-sets"><Icon icon="th-list" className={Classes.TEXT_MUTED}/>All parameter sets <Learn topic="parameter_sets"/></h3>
      {selection && <Tag minimal intent={Intent.PRIMARY} data-testid="sets-selection">{selection.size} kept by the plot's filters</Tag>}
    </header>
    <Scroll>
      <HTMLTable compact striped style={{ width: '100%' }} data-testid="sets-table">
        <thead><tr>
          <th>Set</th>
          <th aria-label="Actions"/>
          {metrics.map(m => <th key={m} style={{ whiteSpace: 'nowrap' }}>{info_of(m).label}{m === metric && comparison.goal && <Icon icon={comparison.goal === 'max' ? 'sort-desc' : 'sort-asc'} size={12} style={{ marginLeft: 4 }}/>}</th>)}
          {analysis.parameters.map(p => <th key={p.name}><Code>{p.name}</Code></th>)}
          <th>Tests</th>
        </tr></thead>
        <tbody>
          {shown.map(s => <tr key={s.id} style={s === best ? { fontWeight: 600 } : undefined}>
            <td className="qa-optim-num" style={{ whiteSpace: 'nowrap' }}>
              #{s.id}
              {s === best && <Tooltip content="The best parameter set" hoverOpenDelay={200}><Icon icon="crown" size={12} intent={Intent.PRIMARY} style={{ marginLeft: 6 }}/></Tooltip>}
              {s.is_default && <Tag minimal style={{ marginLeft: 6 }}>defaults</Tag>}
            </td>
            <td style={{ whiteSpace: 'nowrap' }}>
              <ButtonGroup variant="minimal" size="small">
                {set_filter(s) && <Tooltip content="See these runs: their outputs, next to the reference's" hoverOpenDelay={300}>
                  <Button icon="media" text="Outputs" onClick={() => updateSelected({ filter_batch_new: set_filter(s), selected_views: 'output-list' })}/>
                </Tooltip>}
                <Tooltip content="Opens Run Tests / Tuning with these parameters, to run them on any batch of tests" hoverOpenDelay={300}>
                  <Button icon="play" text="Run…" onClick={() => onRun(s)}/>
                </Tooltip>
              </ButtonGroup>
            </td>
            {metrics.map(m => <td key={m} className="qa-optim-num" style={{ whiteSpace: 'nowrap' }}>{value_of(m, s.metrics[m])}</td>)}
            {analysis.parameters.map(p => <td key={p.name} className="qa-optim-num">{s.params[p.name] === undefined ? <span className={Classes.TEXT_MUTED}>default</span> : value_text(s.params[p.name], p)}</td>)}
            <td className="qa-optim-num" style={{ whiteSpace: 'nowrap' }}>
              {s.tests.size}
              {partial.has(s) && <Tooltip content={`Fewer than the ${comparison.coverage} of the others: not ranked`} hoverOpenDelay={200}><Icon icon="warning-sign" size={12} intent={Intent.WARNING} style={{ marginLeft: 6 }}/></Tooltip>}
              {s.failed > 0 && <Tag minimal intent={Intent.DANGER} style={{ marginLeft: 6 }}>{s.failed} failed</Tag>}
              {s.pending > 0 && <Tag minimal intent={Intent.PRIMARY} style={{ marginLeft: 6 }}>{s.pending} running</Tag>}
            </td>
          </tr>)}
        </tbody>
      </HTMLTable>
    </Scroll>
    {rows.length > 10 && <Button variant="minimal" size="small" icon={all ? 'chevron-up' : 'chevron-down'} onClick={() => setAll(!all)} style={{ marginTop: 6 }}>
      {all ? 'Show the 10 best' : `Show all ${rows.length}`}
    </Button>}
  </section>;
};


const TuningReport = ({ batch, outputs, project, commit_id, available_metrics, selected_metrics }) => {
  const dark = useIsDark();
  const { docs_root } = useSiteConfig();
  const { query } = useSelected();
  const updateTuning = usePrefsStore(state => state.updateTuning);
  const label = batch?.label ?? '';
  const tryParameters = useTryParameters(project, label);
  // the ids of the parameter sets the parallel coordinates' filters keep
  const [selection, setSelection] = useState(null);
  const [color_by, setColorBy] = useState(null);

  const aggregation = query.aggregation === 'median' ? 'median' : 'average';
  const analysis = useMemo(() => analyze(outputs, { aggregation }), [outputs, aggregation]);
  const metrics = useMemo(() => varying_metrics(analysis, selected_metrics ?? []), [analysis, selected_metrics]);
  const info_of = key => metric_info(available_metrics, key);
  const metric = metrics.includes(query.selected_metric) ? query.selected_metric : metrics[0];
  const second = metrics.includes(query.selected_metric2) && query.selected_metric2 !== metric ? query.selected_metric2 : metrics.find(m => m !== metric);
  const said = goal => ['min', 'max'].includes(goal) ? goal : null;
  const goal_of = key => declared_goal(info_of(key)) ?? said(key === metric ? query.goal : key === second ? query.goal2 : null);
  const goal = metric ? goal_of(metric) : null;
  const comparison = useMemo(() => ({ ...compare(analysis, metric, goal), parameters: analysis.parameters }), [analysis, metric, goal]);
  const insights = useMemo(() => get_insights(analysis, comparison), [analysis, comparison]);

  const { best, baseline, importances } = comparison;
  const info = metric ? info_of(metric) : {};
  const scale = info.scale ?? 1;
  const value_of = (m, v) => typeof v === 'number' ? `${format(v * (info_of(m).scale ?? 1), { precision: 3 })}${info_of(m).suffix ?? ''}` : '—';
  const value = v => value_of(metric, v);
  const better = goal === 'max' ? (a, b) => a > b : (a, b) => a < b;
  const by_importance = [...analysis.parameters].sort((a, b) => (importances[b.name] ?? -1) - (importances[a.name] ?? -1));
  const best_params = best ? best.params : {};

  const runSet = set => tryParameters(set.all_params);
  const automate = goal ? () => {
    updateTuning(project, {
      search_type: 'optimize',
      optimize_mode: 'guided',
      experiment_name: `${label}-auto`,
      parameter_search_auto: from_space(as_search_space(analysis, comparison), { [metric]: goal }),
    });
    updateSelected({ selected_views: 'tuning' });
  } : null;

  // the parallel coordinates: the metrics, then the parameters
  const parallel = useMemo(() => {
    const shown_metrics = metrics.slice(0, 8);
    if (metric && !shown_metrics.includes(metric)) shown_metrics.unshift(metric);
    const columns = [
      ...shown_metrics.map(m => {
        const m_info = metric_info(available_metrics, m);
        const m_goal = declared_goal(m_info) ?? (m === metric ? goal : null);
        return { key: `metric:${m}`, label: m_info.short_label ?? m_info.label ?? m, group: 'Metrics', suffix: m_info.suffix ?? '', better: m_goal === 'max' ? 'higher' : m_goal === 'min' ? 'lower' : undefined };
      }),
      ...analysis.parameters.map(p => ({ key: `param:${p.name}`, label: p.name, group: 'Parameters', type: p.type === 'categorical' ? 'category' : 'number', log: p.log || undefined })),
    ];
    const rows = [...comparison.ranked, ...comparison.partial].map(s => ({
      id: s.id,
      label: s.is_default ? `#${s.id} · the defaults` : `Parameter set #${s.id}`,
      values: {
        ...Object.fromEntries(shown_metrics.map(m => [`metric:${m}`, typeof s.metrics[m] === 'number' ? s.metrics[m] * (metric_info(available_metrics, m).scale ?? 1) : undefined])),
        ...Object.fromEntries(analysis.parameters.map(p => [`param:${p.name}`, s.params[p.name]])),
      },
    }));
    return { columns, rows };
  }, [analysis, comparison, metrics, metric, goal, available_metrics]);
  const marks = useMemo(() => best ? { [best.id]: { label: 'Best' } } : {}, [best]);

  const header = <Header>
    <div>
      <h2><Icon icon="predictive-analysis" className={Classes.TEXT_MUTED}/> {plural(analysis.sets.length, 'parameter set')}{metric ? ' compared' : ''} <Learn topic="parameter_sets"/></h2>
      <div className={`qa-optim-meta ${Classes.TEXT_MUTED}`}>
        <span><Icon icon="settings" size={12}/>{plural(analysis.parameters.length, 'parameter')}</span>
        <span><Icon icon="media" size={12}/>{plural(analysis.tests.length, 'test')}</span>
        <span><Icon icon="play" size={12}/>{plural(analysis.runs.total, 'run')}</span>
        {analysis.runs.failed > 0 && <span><Icon icon="error" size={12}/>{analysis.runs.failed} failed</span>}
        <a href={`${docs_root}docs/user-guide/running-from-the-webapp#tuning-analysis`} target="_blank" rel="noopener noreferrer"><Icon icon="manual" size={12}/>How to read this page</a>
      </div>
    </div>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {automate && <Tooltip content="Opens Automated tuning with these parameters and the ranges this batch tried" hoverOpenDelay={300}>
        <Button icon="predictive-analysis" text="Search automatically…" onClick={automate} data-testid="search-automatically"/>
      </Tooltip>}
      {best && <ButtonGroup>
        <CopyMenu params={best_params}/>
        <Tooltip content="Opens Run Tests / Tuning with these parameters, to run them on any batch of tests" hoverOpenDelay={300}>
          <Button intent={Intent.PRIMARY} icon="play" text="Run the best parameters…" onClick={() => runSet(best)} data-testid="run-best"/>
        </Tooltip>
      </ButtonGroup>}
    </div>
  </Header>;

  // Parameters to compare, but nothing to compare them with
  if (!metric)
    return <Report data-testid="tuning-report">
      {header}
      <Callout icon="timeline-line-chart" intent={Intent.PRIMARY} title={analysis.metrics.length ? "The metrics are the same for every parameter set" : "The runs have no metrics yet"} data-testid="tuning-no-metrics">
        <p>
          This batch tried {plural(analysis.sets.length, 'parameter set')}. To say which is best, QA-Board needs a metric: a number that scores each run. <Learn topic="metrics" label="What is a metric?"/>
        </p>
        <p><strong>You don't need to run again:</strong> a short script can score the runs you already have.</p>
        <MetricsScript project={project} commit_id={commit_id} batch={label}/>
      </Callout>
      <SetsTable analysis={analysis} comparison={comparison} metrics={[]} info_of={info_of} value_of={value_of} selection={null} onRun={runSet}/>
    </Report>;

  const delta = (from, to) => {
    const d = to - from;
    if (Math.abs(d) < 1e-12) return <span>the same</span>;
    return <span style={{ color: better(to, from) ? (dark ? Colors.GREEN5 : Colors.GREEN3) : (dark ? Colors.RED5 : Colors.RED3), fontWeight: 600 }}>
      {d > 0 ? '+' : '−'}{format(Math.abs(d) * scale, { precision: 3 })}{info.suffix ?? ''}
    </span>;
  };

  return <Report data-testid="tuning-report">
    {header}

    <Controls>
      <label htmlFor="tuning-metric">Compare parameter sets by</label>
      <HTMLSelect id="tuning-metric" value={metric} onChange={e => select({ selected_metric: e.target.value, goal: undefined })} options={metrics.map(m => ({ value: m, label: info_of(m).label }))}/>
      {declared_goal(info)
        ? <span className={Classes.TEXT_MUTED}><Icon icon={goal === 'max' ? 'arrow-up' : 'arrow-down'} size={12}/> {goal === 'max' ? 'higher' : 'lower'} is better</span>
        : <SegmentedControl size="small" aria-label={`Which way is better for ${info.label}`} options={goal_options} value={goal ?? ''} intent={goal ? Intent.NONE : Intent.PRIMARY} onValueChange={g => select({ goal: g })}/>}
      <span style={{ flex: 1 }}/>
      <span className={Classes.TEXT_MUTED}>over each set's tests:</span>
      <HTMLSelect aria-label="How to combine a parameter set's tests" value={aggregation} onChange={e => select({ aggregation: e.target.value })} options={[{ value: 'average', label: 'Average' }, { value: 'median', label: 'Median' }]}/>
      <Learn topic="aggregation"/>
    </Controls>

    {!goal && <Callout intent={Intent.PRIMARY} icon="help" title={<>Is a higher or a lower {info.label} better?</>} data-testid="tuning-goal">
      <p style={{ marginBottom: 8 }}>The project doesn't say, so QA-Board can't tell which parameter set is the best. Choose here; to stop being asked, declare it with the metric.</p>
      <ButtonGroup>
        <Button icon="arrow-up" text="Higher is better" onClick={() => select({ goal: 'max' })}/>
        <Button icon="arrow-down" text="Lower is better" onClick={() => select({ goal: 'min' })}/>
      </ButtonGroup>
      {' '}<a href={`${docs_root}docs/computing-quantitative-metrics#declaring-metrics`} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 8 }}>Declare metrics</a>
    </Callout>}

    {best && <Tiles>
      <Card compact data-testid="tile-best">
        <div className={`label ${Classes.TEXT_MUTED}`}>Best {info.label}</div>
        <div className="value">{value(best.metrics[metric])}</div>
        <div className={`detail ${Classes.TEXT_MUTED}`}>{aggregation} over {plural(comparison.coverage, 'test')}, parameter set #{best.id}</div>
      </Card>
      {baseline && baseline !== best
        ? <Card compact data-testid="tile-baseline">
            <div className={`label ${Classes.TEXT_MUTED}`}>Compared with the defaults</div>
            <div className="value">{delta(baseline.metrics[metric], best.metrics[metric])}</div>
            <div className={`detail ${Classes.TEXT_MUTED}`}>the runs without these parameters get {value(baseline.metrics[metric])}</div>
          </Card>
        : comparison.worst && comparison.worst !== best && <Card compact data-testid="tile-spread">
            <div className={`label ${Classes.TEXT_MUTED}`}>From worst to best</div>
            <div className="value">{delta(comparison.worst.metrics[metric], best.metrics[metric])}</div>
            <div className={`detail ${Classes.TEXT_MUTED}`}>the worst parameter set gets {value(comparison.worst.metrics[metric])}</div>
          </Card>}
      {comparison.wins !== null && <Card compact data-testid="tile-wins">
        <div className={`label ${Classes.TEXT_MUTED}`}>Best on</div>
        <div className="value">{comparison.wins} of {plural(comparison.coverage, 'test')}</div>
        <div className={`detail ${Classes.TEXT_MUTED}`}>{comparison.wins === comparison.coverage ? 'every test agrees' : 'other sets win on the others, see Test by test'}</div>
      </Card>}
      <Card compact data-testid="tile-sets">
        <div className={`label ${Classes.TEXT_MUTED}`}>Compared</div>
        <div className="value">{plural(comparison.ranked.length, 'set')}</div>
        <div className={`detail ${Classes.TEXT_MUTED}`}>{comparison.partial.length > 0 ? `${comparison.partial.length} more miss tests` : `of ${plural(analysis.parameters.length, 'parameter')}`}</div>
      </Card>
    </Tiles>}

    {insights.length > 0 && <Card compact className="qa-optim-section" aria-labelledby="tuning-insights" data-testid="tuning-insights">
      <header><h3 id="tuning-insights"><Icon icon="lightbulb" className={Classes.TEXT_MUTED}/>What this tells you</h3></header>
      <InsightList>
        {insights.map((insight, i) => {
          const content = insight_content(insight, {
            metric_name: info.label, value, names: analysis.names,
            onOpenLogs: () => updateSelected({ selected_views: 'logs' }),
            onRunBest: best ? () => runSet(best) : null,
            onAutomate: automate,
          });
          if (!content) return null;
          return <li key={i} data-testid={`insight-${insight.kind}`}>
            <Icon icon={content.icon} intent={intents[insight.intent]}/>
            <div>
              <div className="qa-insight-title">{content.title}</div>
              <p className={`qa-insight-text ${Classes.TEXT_MUTED}`}>{content.text}{content.learn && <> <Learn topic={content.learn}/></>}</p>
            </div>
            <div>{content.action}</div>
          </li>;
        })}
      </InsightList>
    </Card>}

    <Columns>
      <section className="qa-optim-section" aria-labelledby="tuning-best">
        <header><h3 id="tuning-best"><Icon icon={best ? 'crown' : 'properties'} className={Classes.TEXT_MUTED}/>{best ? 'Best parameters' : 'Parameters'}</h3></header>
        <p className={`qa-optim-how ${Classes.TEXT_MUTED}`}>
          The bar spans the values tried: {best ? 'the dot is the best one, ' : ''}the ticks are the others. <strong>Impact</strong> says how much
          each parameter changes {info.label}. <Learn topic="impact"/>
        </p>
        <Scroll><ParamTable compact data-testid="best-parameters">
          <thead><tr><th>Parameter</th>{best && <th>Best</th>}<th>Values tried</th><th>Impact</th></tr></thead>
          <tbody>
            {by_importance.map(p => <tr key={p.name}>
              <td className="qa-optim-name"><Code>{p.name}</Code></td>
              {best && <td className="qa-optim-best">{best.params[p.name] === undefined ? <span className={Classes.TEXT_MUTED}>default</span> : value_text(best.params[p.name], p)}</td>}
              <td><RangeBar dimension={p} values={comparison.ranked.map(s => s.params[p.name]).filter(v => v !== undefined)} best={best?.params[p.name]}/></td>
              <td><ImportanceBar value={importances[p.name]} missing="Needs 2 parameters or more, and enough parameter sets"/></td>
            </tr>)}
          </tbody>
        </ParamTable></Scroll>
      </section>

      <section className="qa-optim-section" aria-labelledby="tuning-metrics">
        <header><h3 id="tuning-metrics"><Icon icon="timeline-line-chart" className={Classes.TEXT_MUTED}/>What it costs on the other metrics</h3></header>
        <p className={`qa-optim-how ${Classes.TEXT_MUTED}`}>
          {best ? <>The best parameter set's metrics, and how far they go between all the sets. A best {info.label} can cost another metric.</> : <>How far each metric goes between the parameter sets.</>}
        </p>
        <HTMLTable compact style={{ width: '100%' }} data-testid="other-metrics">
          <thead><tr><th>Metric</th>{best && <th>At the best</th>}<th>Between the sets</th></tr></thead>
          <tbody>
            {metrics.slice(0, 10).map(m => {
              const values = comparison.ranked.map(s => s.metrics[m]).filter(v => typeof v === 'number');
              return <tr key={m} style={m === metric ? { fontWeight: 600 } : undefined}>
                <td>
                  <Tooltip content="Compare the parameter sets by this metric" hoverOpenDelay={400} disabled={m === metric}>
                    <button type="button" onClick={() => select({ selected_metric: m, goal: undefined })} style={{ background: 'none', border: 0, padding: 0, font: 'inherit', color: m === metric ? 'inherit' : 'var(--qa-link)', cursor: m === metric ? 'default' : 'pointer', textAlign: 'left' }}>{info_of(m).label}</button>
                  </Tooltip>
                </td>
                {best && <td className="qa-optim-num">{value_of(m, best.metrics[m])}</td>}
                <td className={`qa-optim-num ${Classes.TEXT_MUTED}`}>{values.length ? `${value_of(m, Math.min(...values))} to ${value_of(m, Math.max(...values))}` : '—'}</td>
              </tr>;
            })}
          </tbody>
        </HTMLTable>
        {metrics.length > 10 && <p className={Classes.TEXT_MUTED} style={{ fontSize: 12, marginTop: 4 }}>And {metrics.length - 10} more: pick one above to compare with it.</p>}
      </section>
    </Columns>

    <section className="qa-optim-section" aria-labelledby="tuning-parallel" data-testid="tuning-parallel">
      <header><h3 id="tuning-parallel"><Icon icon="flows" className={Classes.TEXT_MUTED}/>Every parameter set at a glance <Learn topic="parallel"/></h3></header>
      <p className={`qa-optim-how ${Classes.TEXT_MUTED}`}>
        Each line is a parameter set, across its metrics then its parameters. Follow the best-colored lines to see which values they share.
        Drag along an axis to keep a range: the table below follows.
      </p>
      <ParallelCoordinatesPlot
        columns={parallel.columns}
        rows={parallel.rows}
        colorBy={color_by ?? `metric:${metric}`}
        onColorByChange={setColorBy}
        marks={marks}
        onSelectionChange={ids => setSelection(ids ? new Set(ids) : null)}
        height={380}
        dark={dark}
      />
    </section>

    {comparison.ranked.length > 1 && <section className="qa-optim-section" aria-labelledby="tuning-effects">
      <header><h3 id="tuning-effects"><Icon icon="layout-grid" className={Classes.TEXT_MUTED}/>How each parameter affects {info.label}</h3></header>
      <p className={`qa-optim-how ${Classes.TEXT_MUTED}`}>
        Each dot is a parameter set, the line the average at each value. A clear slope or valley shows where the good values are; a flat
        line, a parameter that doesn't matter much here.
      </p>
      <Small>
        {by_importance.slice(0, 12).map(p => <ParameterEffect key={p.name} parameter={p} comparison={comparison} y_title={info.short_label ?? info.label} scale={scale} suffix={info.suffix ?? ''} importance={importances[p.name]} dark={dark}/>)}
      </Small>
      {by_importance.length > 12 && <p className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>The 12 parameters with the most impact, of {by_importance.length}.</p>}
    </section>}

    {second && comparison.ranked.length > 2 && <TradeOffs comparison={comparison} parameters={analysis.parameters} metrics={metrics} info_of={info_of} goal_of={goal_of} second={second} dark={dark} onRun={runSet}/>}

    {best && comparison.coverage > 1 && <TestByTest analysis={analysis} comparison={comparison} value={value} better={better}/>}

    <SetsTable
      analysis={analysis} comparison={comparison} metrics={[metric, ...metrics.filter(m => m !== metric)].slice(0, 5)} info_of={info_of} value_of={value_of}
      selection={selection} onRun={runSet}
    />
  </Report>;
};

export default TuningReport;
