import { Fragment, memo, useContext, useDeferredValue, useMemo, useState } from "react";
import { interpolateRdYlGn, interpolateBlues } from "d3-scale-chromatic";
import {
  Button,
  Callout,
  Classes,
  Intent,
  Switch,
  Tag,
  Tooltip,
} from "@blueprintjs/core";

import { VirtualTbody } from "./VirtualTbody";
import { PlatformTag, ConfigurationsTags, RunBadges, RunBadge, MismatchTags } from './tags'
import { RunName, RunOriginsContext, runLabel, runNameShown } from './runNames'
import { metric_formatter, percent_formatter } from "./metrics"
import { AddedMetricMark, addedMetricsHint } from "./AddedMetricMark"
import { diff_cell, is_number } from "../utils/compare"
import { metric_info } from "../utils"
import { useLabels, updateSelected } from "../hooks"
import { copyWithToast } from "../utils/clipboard"
import { TableArea, Toolbar, Table } from "./metricsTable/styles"
import { TableScroller } from "./metricsTable/TableScroller"
import { kpi_column_stats, diff_column_stats, has_changes, format_fixed, target_check } from "./metricsTable/stats"
import { MetricColumnHeader, SortButton, DistributionSummary, ChangesSummary, sort_state, aria_sort, is_direction_unknown, has_target } from "./metricsTable/columns"
import { kpi_tsv, diff_tsv } from "./metricsTable/tsv"


// Cells colored by quality (App.css .heat-cell): in the light theme, light colors with dark text; in the dark theme,
// the same hues tinted onto the card, so that the table doesn't glare
// `strength`: from 0 (neutral, yellow) to 1 (as good or bad as it gets)
const colored_cell = (background, quality) => background
  ? { className: 'heat-cell', style: { '--heat': background, '--heat-strength': Math.abs(2 * quality - 1).toFixed(2) } }
  : {};

// For metrics that don't say which way is better: a neutral hue, from 0 (light) to 1 (strong)
const neutral_cell = strength => ({
  className: 'heat-cell',
  style: { '--heat': interpolateBlues(0.06 + 0.44 * strength), '--heat-strength': strength.toFixed(2) },
});

// How much a metric changed, from 0 to 1. Like the colors of improvements, it saturates around ±20%
const change_strength = delta_relative => Math.min(Math.abs(Math.tanh(delta_relative / 0.1)), 1);

// How values rank among those of a column: 0 for the smallest, 1 for the largest. null if they're all the same.
const lower_bound = (sorted, value, strict) => {
  let low = 0, high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (strict ? sorted[mid] < value : sorted[mid] <= value) low = mid + 1;
    else high = mid;
  }
  return low;
};
const ranker = values => {
  const sorted = values.filter(is_number).sort((a, b) => a - b);
  if (sorted.length < 2 || sorted[0] === sorted[sorted.length - 1]) return null;
  return value => {
    const rank = (lower_bound(sorted, value, true) + lower_bound(sorted, value, false) - 1) / 2 / (sorted.length - 1);
    return Math.max(0, Math.min(rank, 1));
  };
};

// A cell without a value: a muted dash, that screen readers read as "No value"
const EmptyCell = () => <td aria-label="No value"><span className="empty" aria-hidden>–</span></td>;

const RowHeaderCell = ({ output }) => {
  if (output === undefined || output === null)
    return <th scope="row" aria-label="No run"></th>
  return (
    <th scope="row">
      <RunName output={output}/>{' '}
      <RunBadges output={output}></RunBadges>
      <PlatformTag platform={output.platform}/>
      <ConfigurationsTags configurations={output.configurations} tuning={output.extra_parameters} mismatch={output.reference_mismatch}/>
      <MismatchTags mismatch={output.reference_mismatch} configurations={output.configurations} tuning={output.extra_parameters}/>
      {output.is_failed && <Tag style={{marginLeft: '5px'}} intent={Intent.DANGER}>Failed</Tag>}
    </th>
  );
};

// Changes of a few % are common: the colors saturate around ±20% instead of ±100%
const improvement_quality = (delta_relative, smaller_is_better) => {
  const improvement = smaller_is_better ? -delta_relative : delta_relative;
  return Math.max(Math.min(0.5 + 0.5 * Math.tanh(improvement / 0.1), 0.9), 0.08);
};

// e.g. "-50%", or "-0.39%" for small changes instead of "-0%"
const small_percent_formatter = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 2 });
const format_percent = percent => Math.abs(percent) >= 1 || percent === 0 ? percent_formatter.format(percent) : small_percent_formatter.format(percent);

// labels: what the cells' tooltips call the new and reference runs
// added_new, added_ref: whether scripts added the values after the runs (their `added_metrics` entries)
const ColumnsMetricImprovement = ({ metrics_new, metrics_ref, metric, labels, added_new, added_ref }) => {
  const metric_new = metrics_new?.[metric.key]
  const metric_ref = metrics_ref?.[metric.key]
  if (!metrics_new || metric_new === undefined || metric_new === null)
    return <EmptyCell/>;
  if (!metrics_ref || metric_ref === undefined || metric_ref === null)
    return <EmptyCell/>;

  const is_numeric = !isNaN(metric_new) || !isNaN(metric_ref)
  if (is_numeric) {
    // The same numbers as GET /api/v1/commit/<sha>/compare, see utils/compare.js
    const { delta, delta_relative } = diff_cell(metric_new, metric_ref);
    const title = `${labels[0]}: ${metric_new * metric.scale}${metric.suffix}\n${labels[1]}: ${metric_ref * metric.scale}${metric.suffix}`;
    // nothing to look at: not colored
    if (delta === 0)
      return <td title={title}>
        <span className="same">=</span>
        <AddedMarks added_new={added_new} added_ref={added_ref} metric={metric} labels={labels}/>
      </td>;
    const quality = improvement_quality(delta_relative, metric.smaller_is_better);
    const colors = is_direction_unknown(metric)
      ? (Number.isFinite(delta_relative) ? neutral_cell(change_strength(delta_relative)) : {})
      : colored_cell(metric_ref && interpolateRdYlGn(quality), quality);
    // native tooltips: tables can have thousands of cells
    return <td {...colors} title={title}>
      <span>{metric_formatter(delta * (metric.scale ?? 1), metric)} ({format_percent(100 * delta_relative)}%)</span>
      <AddedMarks added_new={added_new} added_ref={added_ref} metric={metric} labels={labels}/>
    </td>
  } else {
    return <td>
        {metric_new === metric_ref ? <span className="same">=</span> : <ul>
          <li><RunBadge badge={metric_new}/></li>
          <li><RunBadge badge={metric_ref}/></li>
        </ul>}
      <AddedMarks added_new={added_new} added_ref={added_ref} metric={metric} labels={labels}/>
    </td>
  }
};

// A difference of values that scripts added: the marks say which run's
const AddedMarks = ({ added_new, added_ref, metric, labels }) => <>
  <AddedMetricMark native metric={metric} added={added_new} label={labels[0]}/>
  <AddedMetricMark native metric={metric} added={added_ref} label={labels[1]}/>
</>;

// Colored by how far the value is from the metric's target, else in a neutral hue by how it ranks in the column (`rank`)
// label_new: what the "=" of the reference's cells says it's the same as. added: if a script added the value after the run
// decimals: the column's, so that numbers line up (column_decimals)
const QualityCell = ({ metric_info, metric, metric_ref, rank, label_new, added, decimals }) => {
  if (
    metric_info === undefined ||
    metric === undefined || metric === null
  )
    return <EmptyCell/>;
  const delta_relative = metric_info.target ? (metric_info.target - metric) / (metric_info.target + 0.000001) : 0;
  const raw_quality = metric_info.target_passfail
    ? Number(metric_info.smaller_is_better ? metric_info.target >= metric : metric_info.target < metric)
    : (metric_info.smaller_is_better ? (0.5 + delta_relative/2) : (0.5 - delta_relative/2));
  const quality = Math.max(Math.min(raw_quality, 0.9), 0.08)
  const color = interpolateRdYlGn(quality)
  const is_numeric = !isNaN(metric)
  const metric_for_display = is_numeric ? metric * metric_info.scale : metric
  let colors = {};
  if (is_numeric && has_target(metric_info) && !is_direction_unknown(metric_info))
    colors = colored_cell(color, quality);
  else if (is_number(metric) && rank)
    colors = neutral_cell(rank(metric));
  return (
    <td
      {...colors}
      title={is_numeric ? `${metric_for_display}${metric_info.suffix}` : undefined}
    >
      {is_numeric
        ? (metric_ref === metric ? <span className="same" title={`Same as ${label_new}`}>=</span> : <span>{format_fixed(metric_for_display, decimals, v => metric_formatter(v, metric_info))}</span>)
        : <span><RunBadge badge={metric}/></span>}
      <AddedMetricMark native added={added} metric={metric_info}/>
    </td>
  );
};

// The outputs shown in the tables, and the metrics we can show for them
const useTableData = ({ new_batch, metrics, available_metrics, with_refs_only }) => {
  const outputs = useMemo(() => (new_batch?.filtered?.outputs ?? [])
    .map(id => [id, new_batch.outputs[id]])
    .filter(([, o]) => !o.is_pending && o.output_type !== "optim_iteration"),
  [new_batch]);
  // callers often give us new arrays with the same metrics
  const metrics_key = metrics.join('\n');
  const used_metrics = new_batch?.used_metrics;
  const metrics_with_refs = new_batch?.metrics_with_refs;
  const { metrics_, hidden_count } = useMemo(() => {
    const keys = metrics_key ? metrics_key.split('\n') : Object.keys(available_metrics);
    const shown = keys
      .filter(m => used_metrics?.has(m) && (!with_refs_only || metrics_with_refs?.has(m)))
      .map(m => metric_info(available_metrics, m));
    if (metrics_key)
      return { metrics_: shown, hidden_count: 0 };
    // Without a selection: the declared metrics, and the others while there is room
    const declared = shown.filter(m => m.declared !== false);
    const undeclared = shown.filter(m => m.declared === false).slice(0, Math.max(0, max_default_columns - declared.length));
    const metrics_ = [...declared, ...undeclared];
    return { metrics_, hidden_count: shown.length - metrics_.length };
  }, [metrics_key, available_metrics, used_metrics, metrics_with_refs, with_refs_only]);
  // e.g. "3 runs have values added by scripts", in the metrics' headers
  const added_hints = useMemo(() => Object.fromEntries(metrics_
    .map(m => [m.key, addedMetricsHint(outputs.map(([, o]) => o), m.key)])
    .filter(([, hint]) => hint)),
  [metrics_, outputs]);
  return { outputs, metrics_, hidden_count, added_hints };
};

// Runs can have hundreds of metrics
const max_default_columns = 20;

const HiddenMetrics = ({ count, shown }) => count > 0 && <p className={Classes.TEXT_MUTED} style={{ margin: 0 }}>
  {shown} of {shown + count} metrics. Pick others above.
</p>;

// Instead of a table with headers only
const NoRuns = ({ new_batch }) => {
  const is_filtered = Object.keys(new_batch.outputs).length > (new_batch.filtered?.outputs?.length ?? 0);
  return <Callout icon={is_filtered ? "filter" : "inbox"}>
    {is_filtered
      ? <><span>No finished run matches the filter.</span>{' '}
        <Button size="small" variant="minimal" intent={Intent.PRIMARY} text="Clear the filter" onClick={() => updateSelected({ filter_batch_new: undefined })}/></>
      : <><span>No finished run yet.</span> <span className={Classes.TEXT_MUTED}>Runs show up here when they finish.</span></>}
  </Callout>;
};

// The metric picker (`input`), with the table's actions on its right
const TableToolbar = ({ input, children }) => <Toolbar>
  {input && <div className="input">{input}</div>}
  <div className="actions">{children}</div>
</Toolbar>;

// The table as tab-separated values, for spreadsheets. tsv(): computed on click, it can have thousands of rows
const CopyButton = ({ tsv, count }) => <Button
  size="small"
  variant="minimal"
  icon="clipboard"
  text="Copy"
  title="Copy the table, to paste in a spreadsheet (tab-separated values)"
  onClick={() => copyWithToast(tsv(), { what: `the table (${count} run${count === 1 ? '' : 's'})` })}
/>;

// The runs' names in copies, as the table shows them: e.g. after their batch
const useRunNames = () => {
  const origins = useContext(RunOriginsContext);
  return output => runLabel(output, runNameShown(output, origins));
};

// The header over the runs: sorts them by name. shown/total: how many runs the table shows, e.g. "5 of 20 runs"
const runs_header_cells = ({ sorting, onSort, shown, total, failed }) => {
  const order = onSort ? sort_state(sorting, 'test_input_path') : null;
  return {
    name: <th scope="col" aria-sort={aria_sort(order)} aria-label={onSort ? undefined : "Run"} className={order !== null ? 'sorted' : undefined}>
      {onSort && <Tooltip placement="top" hoverOpenDelay={250} content="Sort the runs by name">
        <SortButton sort_key="test_input_path" sorting={sorting} onSort={onSort}><span className="run-label">Run</span></SortButton>
      </Tooltip>}
    </th>,
    count: <th scope="col">
      <span className={Classes.TEXT_MUTED}>
        {shown === total ? '' : `${shown} of `}{total} run{total === 1 ? '' : 's'}{failed > 0 ? `, ${failed} failed` : ''}
      </span>
    </th>,
  };
};

// Highlights the sorted column, under the cells that have no color
const ColumnGroup = ({ metrics, spans, sorted_key }) => <colgroup>
  <col/>
  {metrics.map(m => <col key={m.key} span={spans?.(m) ?? 1} className={m.key === sorted_key ? 'sorted' : undefined}/>)}
</colgroup>;


const CompareRow = memo(({ output, output_ref, metrics, index, measure, labels }) =>
  <tr data-index={index} ref={measure} data-failed={output.is_failed ? '' : undefined}>
    <RowHeaderCell output={output} />
    {metrics.map(m => (
      <ColumnsMetricImprovement
        key={m.key}
        metric={m}
        metrics_new={output.metrics}
        metrics_ref={output_ref?.metrics}
        labels={labels}
        added_new={output.added_metrics?.[m.key]}
        added_ref={output_ref?.added_metrics?.[m.key]}
      />
    ))}
  </tr>
);

// The columns' summaries, by metric. Sorting gives us new outputs with the same numbers: the rows show first, in their
// new order, then the summaries are computed again (about 50ms for 5,000 runs and 30 metrics)
const useColumnStats = (column_stats, outputs, ref_batch, metrics) => {
  const deferred_outputs = useDeferredValue(outputs);
  const deferred_ref = useDeferredValue(ref_batch);
  return useMemo(
    () => Object.fromEntries(metrics.map(m => [m.key, column_stats(deferred_outputs, deferred_ref, m)])),
    [column_stats, deferred_outputs, deferred_ref, metrics],
  );
};

const no_metrics = [];
const no_metrics_object = {};
const no_refs = new Set();
// labels: what the columns call the new and reference results, [new, reference], by default the page's (useLabels)
const useTableLabels = labels => {
  const page = useLabels();
  return useMemo(() => labels ?? [page.new, page.reference], [labels, page]);
};

// sorting: how the runs are sorted, { by, order, default_by } (useComparison().sorting)
// onSort({ by, order }): clicking headers sorts the runs. Without it, headers don't sort.
// stickyTop: the height of the page's fixed headers, in pixels: the table's header stays under them. Without it, it scrolls away.
const TableCompare = ({
  new_batch,
  ref_batch,
  metrics = no_metrics,
  available_metrics = no_metrics_object,
  input,
  labels: labels_,
  sorting,
  onSort,
  stickyTop,
}) => {
  const labels = useTableLabels(labels_);
  const { outputs, metrics_, hidden_count, added_hints } = useTableData({ new_batch, metrics, available_metrics, with_refs_only: true });
  const [only_changed, setOnlyChanged] = useState(false);
  const stats = useColumnStats(diff_column_stats, outputs, ref_batch, metrics_);
  const changed_outputs = useMemo(
    () => only_changed ? outputs.filter(([, o]) => has_changes(o, ref_batch?.outputs?.[o.reference_id], metrics_)) : outputs,
    [only_changed, outputs, ref_batch, metrics_],
  );
  const name = useRunNames();
  if (new_batch === undefined || new_batch === null || new_batch.outputs === undefined || new_batch.outputs === null) return <span />;
  const [label_new, label_ref] = labels;

  if (outputs.length === 0)
    return <TableArea>{input}<NoRuns new_batch={new_batch}/></TableArea>;
  // metrics are compared only when runs have a matching reference run
  if (metrics_.length === 0)
    return <TableArea>
      {input}
      <Callout icon="comparison" intent={Intent.WARNING} title="No metric to compare">
        {new_batch.metrics_with_refs?.size > 0
          ? "The reference runs don't have the metrics you picked. Pick other metrics above."
          : "The reference has no matching runs. Pick another reference in the second navbar."}
      </Callout>
    </TableArea>;

  const runs = runs_header_cells({ sorting, onSort, shown: changed_outputs.length, total: outputs.length, failed: outputs.filter(([, o]) => o.is_failed).length });
  const tsv = () => diff_tsv({
    rows: changed_outputs.map(([, output]) => ({ output, output_ref: ref_batch?.outputs?.[output.reference_id] })),
    metrics: metrics_,
    labels,
    name,
  });
  return (
    <TableArea>
      <TableToolbar input={input}>
        <Switch
          checked={only_changed}
          onChange={e => setOnlyChanged(e.target.checked)}
          label="Only runs that changed"
          title="Hide the runs whose metrics are the same as their reference run's"
        />
        <CopyButton tsv={tsv} count={changed_outputs.length}/>
      </TableToolbar>
      <HiddenMetrics count={hidden_count} shown={metrics_.length}/>
      <TableScroller stickyTop={stickyTop} label="Metrics diff">
        <Table compact>
          <ColumnGroup metrics={metrics_} sorted_key={onSort ? sorting?.by : undefined}/>
          <thead>
            <tr className="stick">
              {runs.name}
              {metrics_.map(m => (
                <MetricColumnHeader
                  key={m.key}
                  metric={m}
                  sorting={sorting}
                  onSort={onSort}
                  hint={added_hints[m.key]}
                  sorts_by={`the ${label_new} runs' values, not by the change`}
                />
              ))}
            </tr>
            <tr className="stick stick-last">
              {runs.count}
              {metrics_.map(m => (
                <th scope="col" key={m.key} aria-label={`${label_new} − ${label_ref}`} className={onSort && sorting?.by === m.key ? 'sorted' : undefined}>
                  <Tooltip placement="top" content={is_direction_unknown(m)
                    ? "Difference with the matching reference run (relative change). The darker, the larger the change: QA-Board doesn't know which way is better."
                    : "Difference with the matching reference run (relative change). Green is better, red is worse."}>
                    <span className={Classes.TEXT_MUTED}>{label_new} − {label_ref}</span>
                  </Tooltip>
                </th>
              ))}
            </tr>
            <tr className="summary-row">
              <th scope="row" title="How many runs changed vs their reference run. Hover a summary for the numbers.">Changes</th>
              {metrics_.map(m => <ChangesSummary key={m.key} changes={stats[m.key].changes} metric={m}/>)}
            </tr>
          </thead>
          {changed_outputs.length === 0
            ? <tbody><tr><td colSpan={metrics_.length + 1} style={{ textAlign: 'left' }} className={Classes.TEXT_MUTED}>
              None of the runs changed: their metrics are the same as their reference run's.{' '}
              <Button variant="minimal" size="small" text="Show all runs" onClick={() => setOnlyChanged(false)}/>
            </td></tr></tbody>
            : <VirtualTbody items={changed_outputs} renderRow={([id, output], index, measure) =>
              <CompareRow key={id} index={index} measure={measure} output={output} output_ref={ref_batch?.outputs?.[output.reference_id]} metrics={metrics_} labels={labels}/>
            }/>}
        </Table>
      </TableScroller>
    </TableArea>
  );
};


const KpiRow = memo(({ output, output_ref, metrics, metrics_with_refs, rankers, decimals, index, measure, label_new }) =>
  <tr data-index={index} ref={measure} data-failed={output.is_failed ? '' : undefined}>
    <RowHeaderCell output={output} />
    {metrics.map(m => (
      <Fragment key={m.key}>
        <QualityCell metric_info={m} metric={output.metrics[m.key]} rank={rankers[m.key]} added={output.added_metrics?.[m.key]} decimals={decimals[m.key]}/>
        {metrics_with_refs.has(m.key) && <QualityCell metric_info={m} metric={output_ref?.metrics?.[m.key]} metric_ref={output.metrics[m.key]} rank={rankers[m.key]} label_new={label_new} added={output_ref?.added_metrics?.[m.key]} decimals={decimals[m.key]}/>}
      </Fragment>
    ))}
  </tr>
);

// sorting, onSort, stickyTop: like TableCompare's
const TableKpi = ({
  new_batch,
  ref_batch,
  metrics = no_metrics,
  available_metrics = no_metrics_object,
  input,
  labels: labels_,
  sorting,
  onSort,
  stickyTop,
}) => {
  const labels = useTableLabels(labels_);
  const { outputs, metrics_, hidden_count, added_hints } = useTableData({ new_batch, metrics, available_metrics, with_refs_only: false });
  // Metrics we can't color by their target are shaded by how values rank among the new runs'
  const rankers = useMemo(() => Object.fromEntries(metrics_
    .filter(m => !has_target(m) || is_direction_unknown(m))
    .map(m => [m.key, ranker(outputs.map(([, o]) => o.metrics?.[m.key]))])),
  [metrics_, outputs]);
  const stats = useColumnStats(kpi_column_stats, outputs, ref_batch, metrics_);
  const decimals = useMemo(() => Object.fromEntries(Object.entries(stats).map(([key, s]) => [key, s.decimals])), [stats]);
  const name = useRunNames();
  if (new_batch?.outputs === undefined || new_batch?.outputs === null) return <span />;
  const [label_new, label_ref] = labels;
  if (outputs.length === 0)
    return <TableArea>{input}<NoRuns new_batch={new_batch}/></TableArea>;
  const with_refs = new_batch.metrics_with_refs ?? no_refs;
  const runs = runs_header_cells({ sorting, onSort, shown: outputs.length, total: outputs.length, failed: outputs.filter(([, o]) => o.is_failed).length });
  const tsv = () => kpi_tsv({
    rows: outputs.map(([, output]) => ({ output, output_ref: ref_batch?.outputs?.[output.reference_id] })),
    metrics: metrics_,
    with_refs,
    labels,
    name,
  });
  const sorted_key = onSort ? sorting?.by : undefined;
  return (
    <TableArea>
      <TableToolbar input={input}>
        <CopyButton tsv={tsv} count={outputs.length}/>
      </TableToolbar>
      <HiddenMetrics count={hidden_count} shown={metrics_.length}/>
      <TableScroller stickyTop={stickyTop} label="Metrics table">
        <Table compact>
          <ColumnGroup metrics={metrics_} spans={m => with_refs.has(m.key) ? 2 : 1} sorted_key={sorted_key}/>
          <thead>
            <tr className="stick">
              {runs.name}
              {metrics_.map(m => (
                <MetricColumnHeader
                  key={m.key}
                  metric={m}
                  colSpan={with_refs.has(m.key) ? 2 : 1}
                  sorting={sorting}
                  onSort={onSort}
                  hint={[
                    rankers[m.key] && "Cells are darker for larger values, compared with the other runs.",
                    added_hints[m.key],
                  ].filter(Boolean).join(' ') || undefined}
                  target_hint={is_direction_unknown(m) ? undefined : "Cells are green when runs meet it, red when they don't"}
                  sorts_by={with_refs.has(m.key) ? `the ${label_new} runs' values` : undefined}
                />
              ))}
            </tr>
            <tr className="stick stick-last">
              {runs.count}
              {/* a cell per column of the rows below: metrics without references have one, empty */}
              {metrics_.map(m => {
                const sorted = m.key === sorted_key ? 'sorted' : undefined;
                return <Fragment key={m.key}>
                  {with_refs.has(m.key) ? <>
                    <th scope="col" className={sorted}>{label_new}</th>
                    <th scope="col" className={sorted}><span className={Classes.TEXT_MUTED}>{label_ref}</span></th>
                  </> : <th scope="col" aria-label={label_new} className={sorted}/>}
                </Fragment>;
              })}
            </tr>
            <tr className="summary-row">
              <th scope="row" title="Each column's distribution (the line is the median), and how many runs meet the target. Hover a summary for the numbers.">Summary</th>
              {metrics_.map(m => {
                const meets = target_check(m);
                return <Fragment key={m.key}>
                  <DistributionSummary stats={stats[m.key].new} metric={m} side={with_refs.has(m.key) ? label_new : undefined} decimals={decimals[m.key]} meets={meets}/>
                  {with_refs.has(m.key) && <DistributionSummary stats={stats[m.key].ref} metric={m} side={label_ref} decimals={decimals[m.key]} meets={meets}/>}
                </Fragment>;
              })}
            </tr>
          </thead>
          <VirtualTbody items={outputs} renderRow={([id, output], index, measure) =>
            <KpiRow key={id} index={index} measure={measure} output={output} output_ref={ref_batch?.outputs?.[output.reference_id]} metrics={metrics_} metrics_with_refs={with_refs} rankers={rankers} decimals={decimals} label_new={label_new}/>
          }/>
        </Table>
      </TableScroller>
    </TableArea>
  );
};

export { TableKpi, TableCompare };
