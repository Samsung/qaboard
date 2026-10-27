import { Fragment, memo, useMemo } from "react";
import styled from "styled-components";
import { interpolateRdYlGn, interpolateBlues } from "d3-scale-chromatic";
import {
  Callout,
  Classes,
  Intent,
  Tag,
  Tooltip,
  HTMLTable,
} from "@blueprintjs/core";

import { VirtualTbody } from "./VirtualTbody";
import { PlatformTag, ConfigurationsTags, RunBadges, RunBadge, MismatchTags } from './tags'
import { metric_formatter, percent_formatter, MetricHeader } from "./metrics"
import { diff_cell, is_number } from "../utils/compare"
import { metric_info } from "../utils"
import { useLabels } from "../hooks"

// Inside the view's card: the metrics picker above the table
const TableArea = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
`;



// React warns when spreading props with a key
const without_key = ({ key: _key, ...rest }) => rest;

const Row = styled.tr`
  transition: background 0.2s;
  &:hover {
    background: var(--qa-hover);
  }
`

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
const is_direction_unknown = metric => metric.smaller_is_better === null;
const has_target = metric => metric.target !== undefined && metric.target !== null;

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

const RowHeaderCell = ({ output }) => {
  if (output === undefined || output === null)
    return <th scope="row" aria-label="No run"></th>
  const test_input = output.test_input_metadata?.label ?? `${output.test_input_database === '/' ? '/' : ''}${output.test_input_path}`
  return (
    <th scope="row">
      {test_input}{' '}
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
const ColumnsMetricImprovement = ({ metrics_new, metrics_ref, metric, labels }) => {
  const metric_new = metrics_new?.[metric.key]
  const metric_ref = metrics_ref?.[metric.key]
  if (!metrics_new || metric_new === undefined || metric_new === null)
    return <td aria-label="No value"></td>;
  if (!metrics_ref || metric_ref === undefined || metric_ref === null)
    return <td aria-label="No value"></td>;

  const is_numeric = !isNaN(metric_new) || !isNaN(metric_ref)
  if (is_numeric) {
    // The same numbers as GET /api/v1/commit/<sha>/compare, see utils/compare.js
    const { delta, delta_relative } = diff_cell(metric_new, metric_ref);
    const quality = improvement_quality(delta_relative, metric.smaller_is_better);
    const colors = is_direction_unknown(metric)
      ? (Number.isFinite(delta_relative) ? neutral_cell(change_strength(delta_relative)) : {})
      : colored_cell(metric_ref && interpolateRdYlGn(quality), quality);
    // native tooltips: tables can have thousands of cells
    return <td
      {...colors}
      title={`${labels[0]}: ${metric_new * metric.scale}${metric.suffix}\n${labels[1]}: ${metric_ref * metric.scale}${metric.suffix}`}
    >
      {delta === 0 ? "=" : <span>{metric_formatter(delta * (metric.scale ?? 1), metric)} ({format_percent(100 * delta_relative)}%)</span>}
    </td>
  } else {
    return <td>
        {metric_new === metric_ref ? "=" : <ul>
          <li><RunBadge badge={metric_new}/></li>
          <li><RunBadge badge={metric_ref}/></li>
        </ul>}
    </td>
  }
};

// Colored by how far the value is from the metric's target, else in a neutral hue by how it ranks in the column (`rank`)
// label_new: what the "=" of the reference's cells says it's the same as
const QualityCell = ({ metric_info, metric, metric_ref, rank, label_new }) => {
  if (
    metric_info === undefined ||
    metric === undefined || metric === null
  )
    return <td aria-label="No value"></td>;
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
        ? (metric_ref === metric ? <span title={`Same as ${label_new}`}>=</span> : <span>{metric_formatter(metric_for_display, metric_info)}</span>)
        : <span><RunBadge badge={metric}/></span>}
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
  return { outputs, metrics_, hidden_count };
};

// Runs can have hundreds of metrics
const max_default_columns = 20;

const HiddenMetrics = ({ count, shown }) => count > 0 && <p className={Classes.TEXT_MUTED} style={{ margin: 0 }}>
  {shown} of {shown + count} metrics. Pick others above.
</p>;

// Instead of a table with headers only
const NoRuns = ({ new_batch }) => {
  const is_filtered = Object.keys(new_batch.outputs).length > (new_batch.filtered?.outputs?.length ?? 0);
  return <Callout icon={is_filtered ? "filter" : "inbox"} style={{ marginTop: '10px' }}>
    {is_filtered ? "No finished run matches the filter." : "No finished run yet."}
  </Callout>;
};


const CompareRow = memo(({ output, output_ref, metrics, index, measure, labels }) =>
  <Row data-index={index} ref={measure}>
    <RowHeaderCell output={output} />
    {metrics.map(m => (
      <ColumnsMetricImprovement
        key={m.key}
        metric={m}
        metrics_new={output.metrics}
        metrics_ref={output_ref?.metrics}
        labels={labels}
      />
    ))}
  </Row>
);

const no_metrics = [];
const no_metrics_object = {};
// labels: what the columns call the new and reference results, [new, reference], by default the page's (useLabels)
const useTableLabels = labels => {
  const page = useLabels();
  return useMemo(() => labels ?? [page.new, page.reference], [labels, page]);
};

const TableCompare = ({
  new_batch,
  ref_batch,
  metrics = no_metrics,
  available_metrics = no_metrics_object,
  input,
  labels: labels_,
}) => {
  const labels = useTableLabels(labels_);
  const { outputs, metrics_, hidden_count } = useTableData({ new_batch, metrics, available_metrics, with_refs_only: true });
  if (new_batch === undefined || new_batch === null || new_batch.outputs === undefined || new_batch.outputs === null) return <span />;
  const [label_new, label_ref] = labels;

  if (outputs.length === 0)
    return <TableArea>{input}<NoRuns new_batch={new_batch}/></TableArea>;
  // metrics are compared only when runs have a matching reference run
  if (metrics_.length === 0)
    return <TableArea>
      {input}
      <Callout icon="comparison" intent={Intent.WARNING} title="No metric to compare" style={{ marginTop: '10px' }}>
        {new_batch.metrics_with_refs?.size > 0
          ? "The reference runs don't have the metrics you picked. Pick other metrics above."
          : "The reference has no matching runs. Pick another reference in the second navbar."}
      </Callout>
    </TableArea>;

  return (
    <TableArea>
      {input}
      <HiddenMetrics count={hidden_count} shown={metrics_.length}/>
      <HTMLTable compact>
        <thead>
          <tr>
            <th aria-label="Input"/>
            {metrics_.map(m => (
              <th key={m.key} style={{boxShadow: "inset 0 0 1px 0 var(--qa-border)"}}>
                <MetricHeader condensed {...without_key(m)}/> {!!m.suffix && <span className={Classes.TEXT_MUTED}>{m.suffix}</span>}
              </th>
            ))}
          </tr>
          <tr>
            <th scope="col">
              <span className={Classes.TEXT_MUTED}>
                {outputs.length} run{outputs.length === 1 ? '' : 's'}
              </span>
            </th>
            {metrics_.map(m => (
              <th scope="col" key={m.key} aria-label={`${label_new} − ${label_ref}`}>
                <Tooltip content={is_direction_unknown(m)
                  ? "Difference with the matching reference run (relative change). The darker, the larger the change: QA-Board doesn't know which way is better."
                  : "Difference with the matching reference run (relative change). Green is better, red is worse."}>
                  <span>{label_new} − {label_ref}</span>
                </Tooltip>
              </th>
            ))}
          </tr>
        </thead>
        <VirtualTbody items={outputs} renderRow={([id, output], index, measure) =>
          <CompareRow key={id} index={index} measure={measure} output={output} output_ref={ref_batch?.outputs?.[output.reference_id]} metrics={metrics_} labels={labels}/>
        }/>
      </HTMLTable>
    </TableArea>
  );
};


const KpiRow = memo(({ output, output_ref, metrics, metrics_with_refs, rankers, index, measure, label_new }) =>
  <Row data-index={index} ref={measure}>
    <RowHeaderCell output={output} />
    {metrics.map(m => (
      <Fragment key={m.key}>
        <QualityCell metric_info={m} metric={output.metrics[m.key]} rank={rankers[m.key]}/>
        {metrics_with_refs.has(m.key) && <QualityCell metric_info={m} metric={output_ref?.metrics?.[m.key]} metric_ref={output.metrics[m.key]} rank={rankers[m.key]} label_new={label_new}/>}
      </Fragment>
    ))}
  </Row>
);

const TableKpi = ({
  new_batch,
  ref_batch,
  metrics = no_metrics,
  available_metrics = no_metrics_object,
  input,
  labels: labels_,
}) => {
  const labels = useTableLabels(labels_);
  const { outputs, metrics_, hidden_count } = useTableData({ new_batch, metrics, available_metrics, with_refs_only: false });
  // Metrics we can't color by their target are shaded by how values rank among the new runs'
  const rankers = useMemo(() => Object.fromEntries(metrics_
    .filter(m => !has_target(m) || is_direction_unknown(m))
    .map(m => [m.key, ranker(outputs.map(([, o]) => o.metrics?.[m.key]))])),
  [metrics_, outputs]);
  if (new_batch?.outputs === undefined || new_batch?.outputs === null) return <span />;
  const [label_new, label_ref] = labels;
  if (outputs.length === 0)
    return <TableArea>{input}<NoRuns new_batch={new_batch}/></TableArea>;
  return (
    <TableArea>
      {input}
      <HiddenMetrics count={hidden_count} shown={metrics_.length}/>
      <HTMLTable compact>
        <thead>
          <tr>
            <th aria-label="Input"/>
            {metrics_.map(m => (
              <th colSpan={new_batch.metrics_with_refs.has(m.key) ? 2 : 1} key={m.key}>
                <MetricHeader condensed {...without_key(m)} hint={rankers[m.key] ? "Cells are darker for larger values, compared with the other runs." : undefined}/>
                {!!m.target && <Tooltip content={is_direction_unknown(m)
                  ? "Target. QA-Board doesn't know if higher or lower values are better: declare it to color cells by the target."
                  : "Target: cells are green when runs meet it, red when they don't."}>
                  <span className={Classes.TEXT_MUTED}>[{metric_formatter(m.target * m.scale, m)}{m.suffix}]</span>
                </Tooltip>}
                {!m.target && !!m.suffix && <span className={Classes.TEXT_MUTED}>[{m.suffix.trim()}]</span>}
              </th>
            ))}
          </tr>
          <tr>
            <th scope="col">
              <span className={Classes.TEXT_MUTED}>
                {outputs.length} run{outputs.length === 1 ? '' : 's'}
              </span>
            </th>
            {/* a cell per column of the rows below: metrics without references have one, empty */}
            {metrics_.map(m => (
              <Fragment key={m.key}>
                {new_batch.metrics_with_refs.has(m.key) ? <>
                  <th scope="col">{label_new}</th>
                  <th scope="col">{label_ref}</th>
                </> : <th scope="col" aria-label={label_new} />}
              </Fragment>
            ))}
          </tr>
        </thead>
        <VirtualTbody items={outputs} renderRow={([id, output], index, measure) =>
          <KpiRow key={id} index={index} measure={measure} output={output} output_ref={ref_batch?.outputs?.[output.reference_id]} metrics={metrics_} metrics_with_refs={new_batch.metrics_with_refs} rankers={rankers} label_new={label_new}/>
        }/>
      </HTMLTable>
    </TableArea>
  );
};

export { TableKpi, TableCompare };
