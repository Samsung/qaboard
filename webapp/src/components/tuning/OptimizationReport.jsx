// The Tuning Analysis view of an automated tuning (`qa optimize`): how the search went, the best parameters, what to do
// next, and plots to understand why. Written for people who aren't optimization experts: every plot says how to read it.
// The logic is in optimization.js.
import { useEffect, useMemo, useState } from "react";
import {
  Button, ButtonGroup, Callout, Card, Classes, Colors, HTMLTable, Icon, Intent,
  ProgressBar, SegmentedControl, Spinner, Tag, Tooltip,
} from "@blueprintjs/core";

import Plot from "../Plot";
import { format } from "../../utils";
import { useIsDark } from "../../theme";
import { updateSelected, useRefreshCommit, useSiteConfig } from "../../hooks";
import { usePrefsStore } from "../../stores/prefs";
import { formatDuration } from "../../activity/format";
import {
  iterations as get_iterations, search_space, summarize, insights as get_insights, pareto_iterations,
  metric_bests, objective_definitions,
} from "./optimization";
import { from_batch } from "./optimize_config";
import {
  plot_config, num, value_text, hover_params, plural, Code, metric_label, metric_value, Report, Header, Tiles, Columns, Small, Scroll, ParamTable, RangeBar, ImportanceBar, useTryParameters, CopyMenu, InsightList, intents,
} from "./report";
import Learn from "./learn";
import ParallelCoordinatesPlot from "./ParallelCoordinatesPlot";

const StatusTag = ({ status }) => {
  const tags = {
    running: { intent: Intent.PRIMARY, icon: <Spinner size={12}/>, text: 'Running' },
    done: { intent: Intent.SUCCESS, icon: 'tick-circle', text: 'Done' },
    stopped_early: { intent: Intent.SUCCESS, icon: 'tick-circle', text: 'Stopped early' },
    failed: { intent: Intent.DANGER, icon: 'error', text: 'Failed' },
    interrupted: { intent: Intent.WARNING, icon: 'pause', text: 'Interrupted' },
  };
  const tag = tags[status];
  if (!tag) return null;
  return <Tag intent={tag.intent} icon={tag.icon} minimal round size="large" data-testid="optimization-status">{tag.text}</Tag>;
};

const sampler_names = { gp: 'Gaussian processes', tpe: 'TPE', random: 'random search' };

const duration = (start, end) => {
  if (!start) return null;
  const seconds = ((end ? new Date(end) : new Date()) - new Date(start)) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? formatDuration(seconds) : null;
};


// "Continue the search": the Automated tuning form, with the same configuration and label (qa optimize resumes), and a bigger budget
const useContinue = (project, batch, done) => {
  const updateTuning = usePrefsStore(state => state.updateTuning);
  const yaml = from_batch(batch, { evaluations: done + Math.max(10, Math.round(done / 2)) });
  if (!yaml) return null;
  return () => {
    updateTuning(project, {
      search_type: 'optimize',
      optimize_mode: 'guided',
      experiment_name: batch.label,
      parameter_search_auto: yaml,
      ...(batch.data?.optimization_config?.batches?.[0] ? { selected_group: batch.data.optimization_config.batches[0] } : {}),
    });
    updateSelected({ selected_views: 'tuning' });
  };
};

// What an insight says: {icon, title, text, action}. optimization.js decides which apply.
const insight_content = (insight, { onOpenLogs }) => {
  const { kind } = insight;
  if (kind === 'failed') {
    const n = insight.iterations.length;
    return {
      icon: 'error', title: `${plural(n, 'evaluation')} failed`,
      text: <>Iteration{n > 1 ? 's' : ''} {insight.iterations.slice(0, 8).join(', ')}{n > 8 ? '…' : ''}: the search skipped {n > 1 ? 'them' : 'it'} and went on. Their runs are kept: the logs say what went wrong.</>,
      action: <Button size="small" icon="console" text="Open the logs" onClick={onOpenLogs}/>,
    };
  }
  const better = insight.pareto ? 'new best trade-off' : 'better parameters';
  if (kind === 'stopped_early')
    return {
      icon: 'tick-circle', title: 'Converged: it stopped early',
      text: <>No {better} in the last {plural(insight.since, 'evaluation')}, so it stopped before using its whole budget (<Code>early_stopping</Code>).</>,
    };
  if (kind === 'still_improving')
    return {
      icon: 'trending-up', title: insight.running ? 'Still improving' : 'Still improving: more evaluations would likely help',
      text: insight.running
        ? <>The latest {insight.pareto ? 'best trade-off' : 'best'} came at iteration {insight.best} of {insight.last}: the search keeps finding {insight.pareto ? 'better trade-offs' : 'better parameters'}.</>
        : <>The {insight.pareto ? 'latest best trade-off' : 'best parameters'} came at iteration {insight.best} of {insight.last}, near the end. Raise <Code>evaluations</Code> and start the experiment again with the same batch label: it continues from these {plural(insight.last, 'evaluation')}.</>,
    };
  if (kind === 'converged')
    return {
      icon: 'tick-circle', title: 'The search has likely converged',
      text: <>No {better} in the last {plural(insight.since, 'evaluation')}: more evaluations are unlikely to help much. To refine, narrow the ranges around the best values. Next time, <Code>early_stopping</Code> would save those runs.</>,
    };
  if (kind === 'slowing')
    return {
      icon: 'trending-down', title: 'Improvements are slowing down',
      text: <>The {insight.pareto ? 'latest best trade-off' : 'best'} came at iteration {insight.best} of {insight.last}, and the last {plural(insight.since, 'evaluation')} found nothing better. A few more evaluations could still help a little; narrowing the ranges around the best values would help more.</>,
    };
  if (kind === 'edge') {
    const { name, side, value, dimension } = insight;
    const bound = side === 'low' ? dimension.low : dimension.high;
    return {
      icon: 'arrows-horizontal', title: <>The best <Code>{name}</Code> is at the edge of its range</>,
      text: <>Its best value, {value_text(value, dimension)}, is at the {side === 'low' ? 'bottom' : 'top'} of the range searched ({num(dimension.low)} to {num(dimension.high)}): better values may be {side === 'low' ? 'below' : 'above'} {num(bound)}. If they make sense for your code, {side === 'low' ? 'lower' : 'raise'} its <Code>{side}</Code> and start the experiment again with the same batch label: it continues from what it already tried.</>,
    };
  }
  if (kind === 'unimportant')
    return {
      icon: 'filter', title: <>{insight.names.map((n, i) => <span key={n}>{i > 0 && (i === insight.names.length - 1 ? ' and ' : ', ')}<Code>{n}</Code></span>)} barely matter{insight.names.length === 1 ? 's' : ''}</>,
      text: <>{insight.names.length === 1 ? 'It explains' : 'Each explains'} under 5% of how the objective varies. Fix {insight.names.length === 1 ? 'it' : 'them'} with <Code>preset_params</Code> (e.g. to the best value{insight.names.length === 1 ? '' : 's'}): with fewer parameters, the search needs fewer evaluations.</>,
    };
  if (kind === 'exploring')
    return {
      icon: 'search-around', title: 'Exploring',
      text: <>The first {insight.startup} evaluations try random parameters, to see what the objective looks like ({insight.completed} done). After that, each evaluation uses what the previous ones learned.</>,
    };
  return null;
};

const Insights = ({ insights, onOpenLogs }) => <InsightList>
  {insights.map((insight, i) => {
    const content = insight_content(insight, { onOpenLogs });
    if (!content) return null;
    return <li key={i} data-testid={`insight-${insight.kind}`}>
      <Icon icon={content.icon} intent={intents[insight.intent]}/>
      <div>
        <div className="qa-insight-title">{content.title}</div>
        <p className={`qa-insight-text ${Classes.TEXT_MUTED}`}>{content.text}</p>
      </div>
      <div>{content.action}</div>
    </li>;
  })}
</InsightList>;


const ConvergencePlot = ({ evaluations, space, summary, dark, best_ids }) => {
  const completed = evaluations.filter(e => !e.failed);
  if (completed.length === 0) return <p className={Classes.TEXT_MUTED}>No evaluation finished yet.</p>;
  const primary = dark ? Colors.BLUE4 : Colors.BLUE3;
  const muted = dark ? Colors.GRAY3 : Colors.GRAY3;
  // the best objective after each evaluation
  const steps = completed.reduce((steps, e) => [...steps, Math.min(steps.at(-1) ?? Infinity, e.objective)], []);
  const hover = e => hover_params(e.params, space);
  const top = Math.max(...completed.map(e => e.objective));
  const failed = evaluations.filter(e => e.failed);
  const traces = [
    {
      type: 'scatter', mode: 'markers', name: 'Evaluation',
      x: completed.map(e => e.iteration), y: completed.map(e => e.objective),
      text: completed.map(hover),
      marker: { color: completed.map(e => best_ids.has(e.iteration) ? primary : muted), size: completed.map(e => best_ids.has(e.iteration) ? 9 : 7), opacity: 0.85 },
      hovertemplate: 'Iteration %{x}<br>Objective %{y:.4g}<br>%{text}<extra></extra>',
    },
    {
      type: 'scatter', mode: 'lines', name: 'Best so far',
      x: completed.map(e => e.iteration), y: steps,
      line: { shape: 'hv', color: primary, width: 2.5 },
      hovertemplate: 'Best after %{x}: %{y:.4g}<extra></extra>',
    },
  ];
  if (summary.best)
    traces.push({
      type: 'scatter', mode: 'markers', name: 'Best',
      x: [summary.best.iteration], y: [summary.best.objective],
      marker: { symbol: 'star', size: 16, color: primary, line: { color: dark ? Colors.DARK_GRAY3 : Colors.WHITE, width: 1.5 } },
      hovertemplate: 'Best: iteration %{x}<br>Objective %{y:.4g}<extra></extra>',
    });
  if (failed.length > 0)
    traces.push({
      type: 'scatter', mode: 'markers', name: 'Failed',
      x: failed.map(e => e.iteration), y: failed.map(() => top),
      marker: { symbol: 'x-thin', size: 10, line: { color: dark ? Colors.RED4 : Colors.RED3, width: 2 } },
      hovertemplate: 'Iteration %{x} failed<extra></extra>',
    });
  const shapes = [], annotations = [];
  if (summary.startup && summary.startup > 1) {
    shapes.push({ type: 'rect', xref: 'x', yref: 'paper', x0: 0.5, x1: Math.min(summary.startup, summary.last) + 0.5, y0: 0, y1: 1, fillcolor: dark ? 'rgba(255,255,255,0.05)' : 'rgba(17,20,24,0.04)', line: { width: 0 }, layer: 'below' });
    annotations.push({ xref: 'x', yref: 'paper', x: (Math.min(summary.startup, summary.last) + 1) / 2, y: 1, yanchor: 'bottom', text: 'random exploration', showarrow: false, font: { size: 11, color: muted } });
  }
  const layout = {
    height: 320, margin: { t: 24, r: 16, b: 46, l: 64 },
    showlegend: true, legend: { orientation: 'h', x: 1, xanchor: 'right', y: 1.12 },
    xaxis: { title: { text: 'Iteration' }, range: [0.5, Math.max(summary.budget ?? 0, summary.last) + 0.5], zeroline: false },
    yaxis: { title: { text: 'Objective (lower is better)' }, zeroline: false },
    shapes, annotations, hovermode: 'closest',
  };
  return <Plot data={traces} layout={layout} config={plot_config} style={{ width: '100%' }} useResizeHandler/>;
};


// Each parameter against the objective: where the good values are. Later evaluations are darker.
const ParameterEffect = ({ dimension, evaluations, summary, importance, dark, target = null, available_metrics }) => {
  // the objective, or in Pareto mode a metric
  const y_of = e => target ? e.metrics[target] * (available_metrics?.[target]?.scale ?? 1) : e.objective;
  const y_title = target ? metric_label(available_metrics, target) : 'Objective';
  const completed = evaluations.filter(e => !e.failed && e.params[dimension.name] !== undefined && typeof y_of(e) === 'number' && !Number.isNaN(y_of(e)));
  const primary = dark ? Colors.BLUE4 : Colors.BLUE3;
  const categorical = dimension.type === 'categorical';
  const x = completed.map(e => categorical ? value_text(e.params[dimension.name], dimension) : e.params[dimension.name]);
  const traces = [{
    type: 'scatter', mode: 'markers',
    x, y: completed.map(y_of),
    marker: {
      size: 7, opacity: 0.85,
      color: completed.map(e => e.iteration),
      colorscale: dark ? [[0, '#404854'], [1, Colors.BLUE5]] : [[0, '#d3d8de'], [1, Colors.BLUE1]],
      cmin: 1, cmax: Math.max(2, summary.last),
    },
    hovertemplate: `${dimension.name}: %{x}<br>${y_title} %{y:.4g}<br>Iteration %{marker.color}<extra></extra>`,
  }];
  if (!target && summary.best && summary.best.params[dimension.name] !== undefined)
    traces.push({
      type: 'scatter', mode: 'markers',
      x: [categorical ? value_text(summary.best.params[dimension.name], dimension) : summary.best.params[dimension.name]], y: [summary.best.objective],
      marker: { symbol: 'star', size: 15, color: primary, line: { color: dark ? Colors.DARK_GRAY3 : Colors.WHITE, width: 1.5 } },
      hovertemplate: `Best: ${dimension.name} %{x}<br>Objective %{y:.4g}<extra></extra>`,
    });
  const layout = {
    height: 220, margin: { t: 8, r: 10, b: 40, l: 52 }, showlegend: false, hovermode: 'closest',
    xaxis: categorical
      ? { type: 'category', categoryorder: 'array', categoryarray: dimension.choices.map(c => value_text(c, dimension)), zeroline: false, automargin: true, tickangle: dimension.choices.some(c => String(c).length > 8) ? -25 : 0 }
      : { type: dimension.log ? 'log' : 'linear', zeroline: false, ...(dimension.inferred ? {} : { range: dimension.log ? [Math.log10(dimension.low), Math.log10(dimension.high)] : [dimension.low - 0.02 * (dimension.high - dimension.low), dimension.high + 0.02 * (dimension.high - dimension.low)] }) },
    yaxis: { title: { text: y_title }, zeroline: false, ticksuffix: target ? (available_metrics?.[target]?.suffix ?? '') : '' },
  };
  return <Card compact className="qa-optim-small" data-testid={`effect-${dimension.name}`}>
    <h4><Code>{dimension.name}</Code>{typeof importance === 'number' && <span className={Classes.TEXT_MUTED} style={{ fontWeight: 400 }}>{Math.round(importance * 100)}% of the variation</span>}</h4>
    <Plot data={traces} layout={layout} config={plot_config} style={{ width: '100%' }} useResizeHandler/>
  </Card>;
};


// Pareto mode: the metrics' trade-offs, the front highlighted
const ParetoPlot = ({ evaluations, space, data, available_metrics, dark }) => {
  const metrics = Object.keys(data?.optimization_config?.objective ?? {}).filter(m => m !== 'target');
  if (metrics.length < 2) return null;
  const [mx, my] = metrics;
  const front_ids = pareto_iterations(data);
  const completed = evaluations.filter(e => !e.failed && typeof e.metrics[mx] === 'number' && typeof e.metrics[my] === 'number');
  const scale = m => available_metrics?.[m]?.scale ?? 1;
  const front = completed.filter(e => front_ids.has(e.iteration)).sort((a, b) => a.metrics[mx] - b.metrics[mx]);
  const primary = dark ? Colors.BLUE4 : Colors.BLUE3;
  const hover = e => hover_params(e.params, space);
  const direction = m => available_metrics?.[m]?.smaller_is_better === false ? 'higher is better' : 'lower is better';
  const traces = [
    { type: 'scatter', mode: 'markers', name: 'Evaluation', x: completed.map(e => e.metrics[mx] * scale(mx)), y: completed.map(e => e.metrics[my] * scale(my)), text: completed.map(hover), marker: { color: Colors.GRAY3, size: 7, opacity: 0.6 }, hovertemplate: 'Iteration %{customdata}<br>%{text}<extra></extra>', customdata: completed.map(e => e.iteration) },
    { type: 'scatter', mode: 'lines+markers', name: 'Best trade-offs', x: front.map(e => e.metrics[mx] * scale(mx)), y: front.map(e => e.metrics[my] * scale(my)), text: front.map(hover), customdata: front.map(e => e.iteration), line: { color: primary, width: 2, dash: 'dot' }, marker: { color: primary, size: 11 }, hovertemplate: 'Iteration %{customdata}<br>%{text}<extra></extra>' },
  ];
  const layout = {
    height: 360, margin: { t: 24, r: 16, b: 50, l: 70 }, hovermode: 'closest',
    legend: { orientation: 'h', x: 1, xanchor: 'right', y: 1.1 },
    xaxis: { title: { text: `${metric_label(available_metrics, mx)} (${direction(mx)})` }, ticksuffix: available_metrics?.[mx]?.suffix ?? '' },
    yaxis: { title: { text: `${metric_label(available_metrics, my)} (${direction(my)})` }, ticksuffix: available_metrics?.[my]?.suffix ?? '' },
  };
  return <Plot data={traces} layout={layout} config={plot_config} style={{ width: '100%' }} useResizeHandler/>;
};


const IterationsTable = ({ evaluations, space, metrics, available_metrics, best_iteration, front_ids, pareto }) => {
  const [sort, setSort] = useState(pareto ? 'iteration' : 'objective');
  const [all, setAll] = useState(false);
  const sorted = useMemo(() => [...evaluations].sort(sort === 'objective'
    ? (a, b) => (a.failed - b.failed) || (a.objective ?? Infinity) - (b.objective ?? Infinity)
    : (a, b) => a.iteration - b.iteration), [evaluations, sort]);
  const shown = all ? sorted : sorted.slice(0, 10);
  const header = (key, label) => <th style={{ cursor: 'pointer', whiteSpace: 'nowrap' }} onClick={() => setSort(key)} aria-sort={sort === key ? 'ascending' : undefined}>
    {label}{sort === key && <Icon icon="sort-asc" size={12} style={{ marginLeft: 4 }}/>}
  </th>;
  return <>
    <Scroll>
      <HTMLTable compact striped interactive style={{ width: '100%' }} data-testid="iterations-table">
        <thead>
          <tr>
            {header('iteration', 'Iteration')}
            {!pareto && header('objective', 'Objective')}
            {metrics.map(m => <th key={m} style={{ whiteSpace: 'nowrap' }}>{metric_label(available_metrics, m)}</th>)}
            {space.map(d => <th key={d.name}><Code>{d.name}</Code></th>)}
          </tr>
        </thead>
        <tbody>
          {shown.map(e => <tr key={e.iteration} style={e.iteration === best_iteration ? { fontWeight: 600 } : undefined}>
            <td className="qa-optim-num" style={{ whiteSpace: 'nowrap' }}>
              {e.iteration}
              {pareto && e.failed && <Tag minimal intent={Intent.DANGER} icon="error" style={{ marginLeft: 6 }}>failed</Tag>}
              {!pareto && e.iteration === best_iteration && <Tooltip content="The best parameters" hoverOpenDelay={200}><Icon icon="crown" size={12} intent={Intent.PRIMARY} style={{ marginLeft: 6 }}/></Tooltip>}
              {front_ids.has(e.iteration) && <Tooltip content="On the Pareto front: a best trade-off" hoverOpenDelay={200}><Icon icon="star" size={12} intent={Intent.PRIMARY} style={{ marginLeft: 6 }}/></Tooltip>}
            </td>
            {!pareto && <td className="qa-optim-num">{e.failed ? <Tag minimal intent={Intent.DANGER} icon="error">failed</Tag> : num(e.objective)}</td>}
            {metrics.map(m => <td key={m} className="qa-optim-num">{metric_value(available_metrics, m, e.metrics[m])}</td>)}
            {space.map(d => <td key={d.name} className="qa-optim-num">{value_text(e.params[d.name], d)}</td>)}
          </tr>)}
        </tbody>
      </HTMLTable>
    </Scroll>
    {sorted.length > 10 && <Button variant="minimal" size="small" icon={all ? 'chevron-up' : 'chevron-down'} onClick={() => setAll(!all)} style={{ marginTop: 6 }}>
      {all ? 'Show the 10 best' : `Show all ${sorted.length}`}
    </Button>}
  </>;
};


const no_data = {};

// `code` in qa optimize's messages
const WithCode = ({ text }) => String(text).split(/`([^`]+)`/).map((part, i) => i % 2 ? <code key={i}>{part}</code> : part);

const OptimizationReport = ({ batch, project, commit_id, available_metrics: declared_metrics }) => {
  const dark = useIsDark();
  const { docs_root } = useSiteConfig();
  const refresh = useRefreshCommit();
  const [color_by, setColorBy] = useState(null);
  // Pareto mode: the metric the parameters' effects are plotted against
  const [effect_metric, setEffectMetric] = useState(null);
  const data = batch?.data ?? no_data;
  const label = batch?.label ?? '';
  // which way is better: what qa optimize used, maybe declared by the code once it ran
  const available_metrics = useMemo(() => objective_definitions(declared_metrics, data), [declared_metrics, data]);

  const evaluations = useMemo(() => get_iterations(batch?.outputs), [batch?.outputs]);
  const space = useMemo(() => search_space(data, evaluations), [data, evaluations]);
  const summary = useMemo(() => summarize(data, evaluations), [data, evaluations]);
  const insights = useMemo(() => get_insights(summary, space), [summary, space]);
  const front_ids = useMemo(() => pareto_iterations(data), [data]);
  const tryParameters = useTryParameters(project, label);
  const continueSearch = useContinue(project, batch, evaluations.length);

  // A running search updates its batch after each evaluation, but its own runs aren't pending: we refresh ourselves
  const running = summary.status === 'running';
  useEffect(() => {
    if (!running || !project || !commit_id) return;
    const interval = setInterval(() => refresh(project, commit_id), 30 * 1000);
    return () => clearInterval(interval);
  }, [running, project, commit_id, refresh]);

  const objective_metrics = Object.keys(data.optimization_config?.objective ?? data.best_metrics ?? {}).filter(m => m !== 'target' && m !== 'objective');
  const best = summary.best;
  const best_params = best ? Object.fromEntries(space.map(d => [d.name, best.params[d.name]]).filter(([, v]) => v !== undefined)) : (data.best_params ?? {});
  const all_best_params = best?.params ?? data.best_params ?? {};
  const importances = summary.importances ?? {};
  const pareto = summary.pareto;
  const bests = pareto ? metric_bests(evaluations, objective_metrics, available_metrics) : {};
  const effect_target = pareto ? (effect_metric ?? objective_metrics[0]) : null;
  const by_importance = [...space].sort((a, b) => (importances[b.name] ?? -1) - (importances[a.name] ?? -1));
  const elapsed = duration(summary.started_at, running ? null : summary.ended_at);
  const budget = summary.budget;
  const progress = budget ? Math.min(1, summary.evaluated / budget) : null;
  const metric_delta = m => {
    if (!best || !summary.first || typeof best.metrics[m] !== 'number' || typeof summary.first.metrics[m] !== 'number') return null;
    const delta = best.metrics[m] - summary.first.metrics[m];
    const info = available_metrics?.[m] ?? {};
    const better = info.smaller_is_better === false ? delta > 0 : delta < 0;
    if (Math.abs(delta) < 1e-12) return null;
    return <span style={{ color: better ? (dark ? Colors.GREEN5 : Colors.GREEN3) : (dark ? Colors.RED5 : Colors.RED3), fontWeight: 600 }}>
      {delta > 0 ? '+' : '−'}{format(Math.abs(delta) * (info.scale ?? 1), { precision: 3 })}{info.suffix ?? ''}
    </span>;
  };

  // every evaluation across the objective, its metrics and the parameters
  const parallel = useMemo(() => {
    const columns = [
      ...(pareto ? [] : [{ key: 'objective', label: 'Objective', group: 'Metrics', better: 'lower' }]),
      ...objective_metrics.map(m => {
        const info = available_metrics?.[m] ?? {};
        return { key: `metric:${m}`, label: info.short_label ?? info.label ?? m, group: 'Metrics', suffix: info.suffix ?? '', better: info.smaller_is_better === false ? 'higher' : info.smaller_is_better ? 'lower' : undefined };
      }),
      ...space.map(d => ({ key: `param:${d.name}`, label: d.name, group: 'Parameters', type: d.type === 'categorical' ? 'category' : 'number', log: d.log || undefined, choices: d.type === 'categorical' ? d.choices : undefined })),
      { key: 'iteration', label: 'Iteration', group: 'Search' },
    ];
    const rows = evaluations.filter(e => !e.failed).map(e => ({
      id: e.iteration,
      label: `Iteration ${e.iteration}`,
      values: {
        iteration: e.iteration,
        objective: e.objective,
        ...Object.fromEntries(objective_metrics.map(m => [`metric:${m}`, typeof e.metrics[m] === 'number' ? e.metrics[m] * (available_metrics?.[m]?.scale ?? 1) : undefined])),
        ...Object.fromEntries(space.map(d => [`param:${d.name}`, e.params[d.name]])),
      },
    }));
    return { columns, rows };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evaluations, space, available_metrics, pareto, objective_metrics.join('\n')]);
  const marks = useMemo(() => pareto
    ? Object.fromEntries([...front_ids].map(i => [i, { label: '' }]))
    : best ? { [best.iteration]: { label: 'Best' } } : {}, [pareto, front_ids, best]);

  return <Report data-testid="optimization-report">
    <Header>
      <div>
        <h2><Icon icon="predictive-analysis" className={Classes.TEXT_MUTED}/> Automated tuning <StatusTag status={summary.status}/></h2>
        <div className={`qa-optim-meta ${Classes.TEXT_MUTED}`}>
          <span><Icon icon="repeat" size={12}/>{budget ? `${summary.evaluated} of ${budget} evaluations` : plural(summary.evaluated, 'evaluation')}</span>
          {summary.failed.length > 0 && <span><Icon icon="error" size={12}/>{summary.failed.length} failed</span>}
          {summary.sampler && <Tooltip content="How the search picks the next parameters to try" hoverOpenDelay={200}><span><Icon icon="search-around" size={12}/>{sampler_names[summary.sampler] ?? summary.sampler}{summary.pareto ? ', Pareto' : ''}</span></Tooltip>}
          <span><Learn topic="search" label="How the search works"/></span>
          {summary.parallel > 1 && <span><Icon icon="layers" size={12}/>{summary.parallel} at a time</span>}
          {elapsed && <span><Icon icon="time" size={12}/>{elapsed}{running ? ' so far' : ''}</span>}
          <a href={`${docs_root}docs/user-guide/automated-tuning`} target="_blank" rel="noopener noreferrer"><Icon icon="manual" size={12}/>How to read this page</a>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {continueSearch && !running && <Tooltip content="Opens Automated tuning with the same settings and a bigger budget: it continues from these evaluations" hoverOpenDelay={300}>
        <Button icon="history" text="Continue the search…" onClick={continueSearch} data-testid="continue-search"/>
      </Tooltip>}
      {best && !pareto && <ButtonGroup>
        <CopyMenu params={best_params}/>
        <Tooltip content="Opens Run Tests / Tuning with these parameters, to run them on any batch of tests" hoverOpenDelay={300}>
          <Button intent={Intent.PRIMARY} icon="play" text="Run the best parameters…" onClick={() => tryParameters(all_best_params)} data-testid="run-best"/>
        </Tooltip>
      </ButtonGroup>}
      </div>
    </Header>
    {progress !== null && summary.status !== 'done' && summary.status !== 'stopped_early' && <ProgressBar value={progress} intent={running ? Intent.PRIMARY : Intent.NONE} stripes={running} animate={running}/>}
    {data.optimization_error && <Callout intent={Intent.DANGER} icon="error" title="The search stopped" data-testid="optimization-error">
      <p style={{ marginBottom: 4 }}><WithCode text={data.optimization_error}/></p>
      <p className={Classes.TEXT_MUTED} style={{ marginBottom: 0 }}>Fix it, then start the experiment again with the same batch label: it continues from the evaluations it did.</p>
    </Callout>}

    {evaluations.length === 0
      ? <Callout icon={running ? <Spinner size={16}/> : 'time'} title={running ? 'The first evaluation is running' : 'No evaluation yet'}>
          <p>Each evaluation runs your batch with the parameters the search picks. The results show here as they arrive: this page refreshes by itself.</p>
        </Callout>
      : <>
        {pareto ? <Tiles>
          <Card compact data-testid="tile-front">
            <div className={`label ${Classes.TEXT_MUTED}`}>Best trade-offs</div>
            <div className="value">{summary.front.length}</div>
            <div className={`detail ${Classes.TEXT_MUTED}`}>on the Pareto front, see below</div>
          </Card>
          <Card compact data-testid="tile-front-changed">
            <div className={`label ${Classes.TEXT_MUTED}`}>Front last changed</div>
            <div className="value">{summary.last_improvement ? `iteration ${summary.last_improvement}` : '—'}</div>
            <div className={`detail ${Classes.TEXT_MUTED}`}>{summary.since_improvement > 0 ? `no new trade-off in the ${plural(summary.since_improvement, 'evaluation')} since` : summary.last_improvement ? 'the latest evaluation' : ''}</div>
          </Card>
          {objective_metrics.slice(0, 3).map(m => <Card compact key={m} data-testid={`tile-metric-${m}`}>
            <div className={`label ${Classes.TEXT_MUTED}`}>Best {metric_label(available_metrics, m)}</div>
            <div className="value">{metric_value(available_metrics, m, bests[m]?.value)}</div>
            <div className={`detail ${Classes.TEXT_MUTED}`}>{bests[m] ? `iteration ${bests[m].iteration}` : ''}</div>
          </Card>)}
        </Tiles> : <Tiles>
          <Card compact data-testid="tile-best">
            <div className={`label ${Classes.TEXT_MUTED}`}>Best objective</div>
            <div className="value">{best ? num(best.objective) : '—'}</div>
            <div className={`detail ${Classes.TEXT_MUTED}`}>lower is better{summary.gain > 0 ? <>, {num(summary.gain)} better than the first evaluation</> : null}</div>
          </Card>
          <Card compact data-testid="tile-found">
            <div className={`label ${Classes.TEXT_MUTED}`}>Found at</div>
            <div className="value">{best ? `iteration ${best.iteration}` : '—'}</div>
            <div className={`detail ${Classes.TEXT_MUTED}`}>{summary.since_improvement > 0 ? `nothing better in the ${plural(summary.since_improvement, 'evaluation')} since` : best ? 'the latest evaluation' : ''}</div>
          </Card>
          {objective_metrics.slice(0, 3).map(m => <Card compact key={m} data-testid={`tile-metric-${m}`}>
            <div className={`label ${Classes.TEXT_MUTED}`}>{metric_label(available_metrics, m)}</div>
            <div className="value">{metric_value(available_metrics, m, best?.metrics[m] ?? data.best_metrics?.[m])}</div>
            <div className={`detail ${Classes.TEXT_MUTED}`}>{metric_delta(m)}{metric_delta(m) && ' vs the first evaluation'}</div>
          </Card>)}
        </Tiles>}

        {insights.length > 0 && <Card compact className="qa-optim-section" aria-labelledby="optim-insights" data-testid="optimization-insights">
          <header><h3 id="optim-insights"><Icon icon="lightbulb" className={Classes.TEXT_MUTED}/>What this tells you</h3></header>
          <Insights insights={insights} onOpenLogs={() => updateSelected({ selected_views: 'logs' })}/>
        </Card>}

        <Columns>
          <section className="qa-optim-section" aria-labelledby="optim-best">
            <header><h3 id="optim-best"><Icon icon={pareto ? 'properties' : 'crown'} className={Classes.TEXT_MUTED}/>{pareto ? 'Parameters' : 'Best parameters'}</h3></header>
            <p className={`qa-optim-how ${Classes.TEXT_MUTED}`}>
              The bar is each parameter's range: {pareto ? '' : 'the dot is the best value, '}the ticks every value tried. <strong>Impact</strong> says
              how much each parameter changes the objective. <Learn topic="importance"/>
            </p>
            <Scroll><ParamTable compact data-testid="best-parameters">
              <thead><tr><th>Parameter</th>{!pareto && <th>Best</th>}<th>Range searched</th><th>Impact</th></tr></thead>
              <tbody>
                {by_importance.map(d => <tr key={d.name}>
                  <td className="qa-optim-name"><Code>{d.name}</Code></td>
                  {!pareto && <td className="qa-optim-best">{best ? value_text(best.params[d.name], d) : '—'}</td>}
                  <td><RangeBar dimension={d} values={evaluations.filter(e => !e.failed).map(e => e.params[d.name])} best={pareto ? undefined : best?.params[d.name]}/></td>
                  <td><ImportanceBar value={importances[d.name]}/></td>
                </tr>)}
                {Object.entries(data.optimization_config?.preset_params ?? {}).map(([k, v]) => <tr key={k} className={Classes.TEXT_MUTED}>
                  <td className="qa-optim-name"><Code>{k}</Code></td>
                  <td className="qa-optim-best">{typeof v === 'string' ? v : JSON.stringify(v)}</td>
                  <td colSpan={pareto ? 1 : 2}>fixed (<Code>preset_params</Code>)</td>
                </tr>)}
              </tbody>
            </ParamTable></Scroll>
          </section>

          <section className="qa-optim-section" aria-labelledby="optim-objective">
            <header><h3 id="optim-objective"><Icon icon="locate" className={Classes.TEXT_MUTED}/>What it optimizes <Learn topic="objective"/></h3></header>
            <p className={`qa-optim-how ${Classes.TEXT_MUTED}`}>
              {pareto
                ? <>Each metric is optimized on its own, averaged over the batch's runs: the search looks for the best trade-offs between them.</>
                : <>The objective combines these metrics, averaged over the batch's runs. Metrics where bigger is better count negatively,
                  so the search always looks for the lowest objective.</>}
            </p>
            <HTMLTable compact style={{ width: '100%' }} data-testid="objective-metrics">
              <thead><tr><th>Metric</th><th>Better</th>{!pareto && <th>Weight</th>}<th>{pareto ? 'Best' : 'At the best'}</th></tr></thead>
              <tbody>
                {objective_metrics.map(m => {
                  const info = available_metrics?.[m] ?? {};
                  return <tr key={m}>
                    <td>{metric_label(available_metrics, m)}</td>
                    <td className={Classes.TEXT_MUTED}>{info.smaller_is_better === false ? <><Icon icon="arrow-up" size={12}/> higher</> : info.smaller_is_better ? <><Icon icon="arrow-down" size={12}/> lower</> : '—'}</td>
                    {!pareto && <td className="qa-optim-num">{num(data.optimization_config?.objective?.[m]?.weight ?? 1)}</td>}
                    <td className="qa-optim-num">{metric_value(available_metrics, m, pareto ? bests[m]?.value : (best?.metrics[m] ?? data.best_metrics?.[m]))}</td>
                  </tr>;
                })}
              </tbody>
            </HTMLTable>
          </section>
        </Columns>

        {summary.pareto && <section className="qa-optim-section" aria-labelledby="optim-pareto" data-testid="pareto">
          <header><h3 id="optim-pareto"><Icon icon="scatter-plot" className={Classes.TEXT_MUTED}/>Best trade-offs (Pareto front) <Learn topic="pareto"/></h3></header>
          <p className={`qa-optim-how ${Classes.TEXT_MUTED}`}>
            Each metric is optimized on its own. The highlighted evaluations are the best trade-offs: none of them can get better
            on one metric without getting worse on another. Pick the one that suits you.
          </p>
          <ParetoPlot evaluations={evaluations} space={space} data={data} available_metrics={available_metrics} dark={dark}/>
          <Scroll><HTMLTable compact style={{ width: '100%' }}>
            <thead><tr><th>Iteration</th>{objective_metrics.map(m => <th key={m}>{metric_label(available_metrics, m)}</th>)}<th>Parameters</th><th aria-label="Actions"/></tr></thead>
            <tbody>
              {evaluations.filter(e => front_ids.has(e.iteration)).map(e => <tr key={e.iteration}>
                <td className="qa-optim-num">{e.iteration}</td>
                {objective_metrics.map(m => <td key={m} className="qa-optim-num">{metric_value(available_metrics, m, e.metrics[m])}</td>)}
                <td>{space.map(d => <Tag key={d.name} minimal round style={{ margin: 2 }}>{d.name}: {value_text(e.params[d.name], d)}</Tag>)}</td>
                <td style={{ whiteSpace: 'nowrap' }}><Button size="small" icon="play" text="Run…" onClick={() => tryParameters(e.params)}/></td>
              </tr>)}
            </tbody>
          </HTMLTable></Scroll>
        </section>}

        {!pareto && <section className="qa-optim-section" aria-labelledby="optim-convergence">
          <header><h3 id="optim-convergence"><Icon icon="timeline-line-chart" className={Classes.TEXT_MUTED}/>Convergence <Learn topic="convergence"/></h3></header>
          <p className={`qa-optim-how ${Classes.TEXT_MUTED}`}>
            Each dot is an evaluation, the line the best objective so far. A line that keeps dropping near the end means more
            evaluations would help; a flat line, that the search converged.
          </p>
          <ConvergencePlot evaluations={evaluations} space={space} summary={summary} dark={dark} best_ids={front_ids}/>
        </section>}

        {parallel.rows.length > 1 && <section className="qa-optim-section" aria-labelledby="optim-parallel" data-testid="optim-parallel">
          <header><h3 id="optim-parallel"><Icon icon="flows" className={Classes.TEXT_MUTED}/>Every evaluation at a glance <Learn topic="parallel"/></h3></header>
          <p className={`qa-optim-how ${Classes.TEXT_MUTED}`}>
            Each line is an evaluation, across {pareto ? 'its metrics' : 'the objective, its metrics'} and the parameters. Follow the best-colored lines to see which values
            they share. Drag along an axis to keep a range, like the lowest objectives.
          </p>
          <ParallelCoordinatesPlot
            columns={parallel.columns}
            rows={parallel.rows}
            colorBy={color_by ?? (pareto ? `metric:${objective_metrics[0]}` : 'objective')}
            onColorByChange={setColorBy}
            marks={marks}
            height={380}
            dark={dark}
          />
        </section>}

        {space.length > 0 && <section className="qa-optim-section" aria-labelledby="optim-effects">
          <header>
            <h3 id="optim-effects"><Icon icon="layout-grid" className={Classes.TEXT_MUTED}/>How each parameter affects {pareto ? metric_label(available_metrics, effect_target) : 'the objective'}</h3>
            {pareto && <SegmentedControl size="small" aria-label="Metric" options={objective_metrics.map(m => ({ label: metric_label(available_metrics, m), value: m }))} value={effect_target} onValueChange={setEffectMetric}/>}
          </header>
          <p className={`qa-optim-how ${Classes.TEXT_MUTED}`}>
            Each dot is an evaluation, darker ones came later: as the search learns, it tries more values where the objective is
            low. A clear valley shows a good value; a flat cloud, a parameter that doesn't matter much.
          </p>
          <Small>
            {by_importance.map(d => <ParameterEffect key={d.name} dimension={d} evaluations={evaluations} summary={summary} importance={pareto ? undefined : importances[d.name]} dark={dark} target={effect_target} available_metrics={available_metrics}/>)}
          </Small>
        </section>}

        <section className="qa-optim-section" aria-labelledby="optim-iterations">
          <header><h3 id="optim-iterations"><Icon icon="th-list" className={Classes.TEXT_MUTED}/>All evaluations</h3></header>
          <IterationsTable evaluations={evaluations} space={space} metrics={objective_metrics} available_metrics={available_metrics} best_iteration={best?.iteration} front_ids={front_ids} pareto={summary.pareto}/>
        </section>
      </>}

  </Report>;
};

export default OptimizationReport;
