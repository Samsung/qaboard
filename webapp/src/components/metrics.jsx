import { Fragment, memo, useDeferredValue, useMemo, useState } from "react";
import styled from "styled-components";

import {
  Classes,
  NonIdealState,
  Tag,
  Button,
  Intent,
  Callout,
  MenuItem,
  Colors,
  CompoundTag,
  Tooltip,
} from "@blueprintjs/core";
import { MultiSelect } from "@blueprintjs/select";

import { logTickValues } from "./logTicks";
import { box_stats, linear_ticks, jittered_points } from "./boxPlots";
import { RunBadge } from "./tags";
import { format, plotly_palette, match_query, metric_info, with_undeclared_metrics } from "../utils";
import { summary_outputs, metric_values, summary_stats, mixed_parameters, changed_metrics } from "../utils/compare";
import { useLabels, useSiteConfig } from "../hooks";



const metric_formatter = (value, metric) => {
  if (isNaN(value)) {
    return value
  }
  // 3 significant digits by default
  return format(value, {precision: metric?.precision ?? 3})
  // This doesn't support scientific notation.. but above there
  // are not thousant separators... ^^
  // return value.toLocaleString({
  //   minimumSignificantDigits: metric?.precision ?? 3,
  //   maximumSignificantDigits: metric?.precision ?? 3,
  // })
}
const percent_formatter = new Intl.NumberFormat("en-US", {
  style: "decimal",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});

// For metrics that don't say which way is better, e.g. those that were not declared
const direction_unknown = "QA-Board doesn't know if higher or lower values are better: it shows changes in neutral colors.";
const is_direction_unknown = metric => metric.smaller_is_better === null;

// `hint`: how the view shows the metric
const MetricHeader = ({short_label, label, description, condensed=false, suffix, show_suffix=false, smaller_is_better, hint}) => {
    return <Tooltip content={<span>
      <strong>{label}</strong> {description}
      {smaller_is_better === null && <><br/>{direction_unknown}</>}
      {hint && <><br/>{hint}</>}
    </span>}>
          <>
            {condensed ? short_label: label}
            {show_suffix && `${label}${!!suffix ? ` [${suffix}]` : ''}`}
          </>
    </Tooltip>
}

const MetricTag = ({ metrics_new, metrics_ref, metric_info }) => {
  if (metric_info.key === 'is_failed')
    return <span/>;
  const value = metrics_new[metric_info.key]
  const value_tooltip = <span>{!isNaN(value) ? `${metric_info.scale * value}${metric_info.suffix}` : JSON.stringify(value)}</span>
  const value_component = isNaN(value) ? <RunBadge badge={value}/> : <Tooltip content={value_tooltip}>
    <>{metric_formatter(metric_info.scale * value, metric_info)}{metric_info.suffix}</>
  </Tooltip>

  // compare tag
  let compare_tag = <span/>;
  const value_ref = metrics_ref?.[metric_info.key];
  if (value_ref && value_ref !== value) {
    const delta_relative = (value - value_ref) / value_ref;
    const neutral_threshold = metric_info.target_passfail ? 0 : 0.01
    let intent_compare;
    if (is_direction_unknown(metric_info))
      intent_compare = Intent.DEFAULT;
    else if (delta_relative > neutral_threshold)
      intent_compare = metric_info.smaller_is_better ? Intent.DANGER : Intent.SUCCESS;
    else if (delta_relative < -neutral_threshold)
      intent_compare = metric_info.smaller_is_better ? Intent.SUCCESS : Intent.DANGER;
    else intent_compare = Intent.DEFAULT;
    compare_tag = <Tag round minimal intent={intent_compare} htmlTitle="vs the reference run">{format_delta(delta_relative)}</Tag>;
  }

  const intent =
    (value > metric_info.target && metric_info.smaller_is_better) ||
    (value < metric_info.target && !metric_info.smaller_is_better)
      ? Intent.DANGER
      : Intent.SUCCESS;
  const { key: _key, ...metric_info_rest } = metric_info;
  return <CompoundTag
    style={{margin: '3px', paddingTop: "0px", paddingBottom: "0px"}}
    minimal
    intent={metric_info.target && !is_direction_unknown(metric_info) ? intent : null}
    leftContent={<MetricHeader condensed {...metric_info_rest}/>}
  >
    {value_component}
    {compare_tag}
  </CompoundTag>;
};


// The run's metrics, declared or not. By default, the first few.
const MetricsTags = memo(({ metrics_new, metrics_ref, available_metrics = {}, selected_metrics }) => {
  const keys = selected_metrics?.length > 0
    ? selected_metrics
    : Object.keys(with_undeclared_metrics(available_metrics, Object.keys(metrics_new))).filter(key => metrics_new[key] !== undefined).slice(0, 6);
  return keys
    .filter(key => metrics_new[key] !== undefined)
    .map(key =>
      <MetricTag key={key}
        metrics_new={metrics_new}
        metrics_ref={metrics_ref}
        metric_info={metric_info(available_metrics, key)}
      />
    );
});




const MetricRow = styled.div`
  display: flex;
  align-items: center;
  &:first-child {
    margin-top: 10px;
  }
  // justify-content: space-between;
`;
const MetricTile = styled.div`
  flex: 0.1 0.1 auto;
  text-align: center;
  align-self: start;
  padding: 10px;
  // fits the largest title on wide pages, and leaves room for the box plot on narrow ones
  min-width: clamp(250px, 30%, 355px);
`;

const plot_margin = { left: 40, right: 30, top: 8, bottom: 25 };
const plot_style = {
  // next to the numbers, even when the card is much wider
  marginLeft: 24,
  flex: "0 1 auto",
  // long tick labels can be wider than the margin
  overflow: "visible",
};

// Box plots of each series of values (the new and reference runs, or the inputs' tags): the box spans the quartiles,
// with the median, the mean (dashed) and whiskers, and the values are drawn on its left. Hovering a box gives its numbers.
// Not Plotly: loading it, and drawing every value of thousands of runs for each metric, took most of the time the commit
// page needed to show the Summary, and to update it when switching references or filtering runs.
// `colors`: CSS colors of the series, e.g. the side colors' `css` (src/sideColors.js)
const BoxPlots = ({ series: series_, labels: labels_, colors: colors_, metric, width = 300, height = 100, label_size = 12 }) => {
  // drawn after the rest of the Summary, that shows first, e.g. when the page loads or switches references.
  // The values change with their names and colors.
  const shown = useDeferredValue({ series: series_, labels: labels_, colors: colors_ }, null);
  if (shown === null) return <svg width={width} height={height} style={plot_style}/>;
  const { series, labels, colors } = shown;
  const scaled = series.map(values => values.map(x => metric.scale * x).filter(Number.isFinite));
  const all = scaled.flat();
  if (all.length === 0) return null;
  const min = all.reduce((a, b) => Math.min(a, b));
  const max = all.reduce((a, b) => Math.max(a, b));
  // the values' range on each side of the target: red where runs miss it, green where they meet it
  const zones = [];
  if (metric.target && !is_direction_unknown(metric)) {
    const target = metric.target * metric.scale;
    const [miss, meet] = metric.smaller_is_better ? [[target, max], [min, target]] : [[min, target], [target, max]];
    if (miss[0] < miss[1]) zones.push({ range: miss, fill: Colors.RED5, opacity: 0.2 });
    if (meet[0] < meet[1]) zones.push({ range: meet, fill: Colors.GREEN2, opacity: 0.15 });
  }
  const low = Math.min(min, ...zones.map(zone => zone.range[0]));
  const high = Math.max(max, ...zones.map(zone => zone.range[1]));

  // log scales can't show values ≤ 0
  const log = (metric.plot_scale || "log") === "log" && low > 0;
  const to_scale = log ? Math.log10 : v => v;
  // a margin around the values, also when they're all the same (in decades on a log scale)
  const pad = 0.05 * (to_scale(high) - to_scale(low)) || (log ? 0.05 : 0.1 * Math.abs(low)) || 1;
  const [bottom, top] = [to_scale(low) - pad, to_scale(high) + pad];
  const plot_height = height - plot_margin.top - plot_margin.bottom;
  const y = v => plot_margin.top + plot_height * (top - to_scale(v)) / (top - bottom);
  // values close together may have no round log tick on the axis: round linear values label it then
  const log_ticks = log ? (logTickValues([low, high]) ?? []).filter(tick => to_scale(tick) >= bottom && to_scale(tick) <= top) : [];
  const ticks = log_ticks.length > 0 ? log_ticks : linear_ticks(low, high);
  // where Plotly drew them: the boxes centered on their label, the values on their left
  const plot_width = width - plot_margin.left - plot_margin.right;
  const step = plot_width / scaled.length;
  const half = 0.245 * step;
  const caps = 0.3 * half;
  const number = v => `${metric_formatter(v, metric)}${metric.suffix ?? ''}`;

  return <svg width={width} height={height} role="img" aria-label={`Box plots of ${metric.label}`} style={plot_style}>
    {zones.map(({ range: [from, to], fill, opacity }) =>
      <rect key={fill} x={plot_margin.left} width={plot_width} y={y(to)} height={y(from) - y(to)} fill={fill} opacity={opacity}/>
    )}
    <g fill="var(--qa-text)" stroke="var(--qa-text)" fontSize={12}>
      {ticks.map(tick => <Fragment key={tick}>
        <line x1={plot_margin.left - 5} x2={plot_margin.left} y1={y(tick)} y2={y(tick)}/>
        <text x={plot_margin.left - 7} y={y(tick)} stroke="none" textAnchor="end" dominantBaseline="central">{format(tick)}</text>
      </Fragment>)}
      {scaled.map((_, i) =>
        <text key={i} x={plot_margin.left + (i + 0.5) * step} y={height - 8} stroke="none" fontSize={label_size} textAnchor="middle">{labels[i]}</text>
      )}
    </g>
    {scaled.map((values, i) => {
      if (values.length === 0) return null;
      const { q1, median, q3, lower, upper, mean } = box_stats(values);
      const center = plot_margin.left + (i + 0.5) * step;
      return <g key={i} style={{ fill: colors[i], stroke: colors[i] }} strokeWidth={2}>
        <title>{[
          `${labels[i]}: ${values.length} run${values.length === 1 ? '' : 's'}`,
          `median ${number(median)}, mean ${number(mean)}`,
          `quartiles ${number(q1)} to ${number(q3)}`,
          `whiskers ${number(lower)} to ${number(upper)}`,
        ].join('\n')}</title>
        <g stroke="none" fillOpacity={0.4}>
          {jittered_points(values, center - 1.5 * half, half, y).map(([cx, cy], k) => <circle key={k} cx={cx} cy={cy} r={4}/>)}
        </g>
        <rect x={center - half} width={2 * half} y={y(q3)} height={y(q1) - y(q3)} fillOpacity={0.4}/>
        <path fill="none" d={`M${center - half},${y(median)}H${center + half}`
          + `M${center},${y(q3)}V${y(upper)}M${center - caps},${y(upper)}H${center + caps}`
          + `M${center},${y(q1)}V${y(lower)}M${center - caps},${y(lower)}H${center + caps}`}/>
        <path fill="none" strokeDasharray="4 2" d={`M${center - half},${y(mean)}H${center + half}`}/>
      </g>;
    })}
  </svg>;
};

// The runs that meet the target, then those that miss it. Not a Plotly plot: there are two per metric,
// and drawing them took a good part of the time the summary needs to update, e.g. when switching references.
const SuccessBarTrack = styled.span`
  display: inline-flex;
  width: 150px;
  height: 20px;
  margin: 2px 0 3px;
  vertical-align: middle;
  font-size: 12px;
  line-height: 20px;
  color: #fff;
  white-space: nowrap;
  & > :first-child {
    background: ${Colors.GREEN3};
    text-align: center;
    overflow: hidden;
  }
  & > :last-child {
    flex: 1;
    background: ${Colors.RED5};
    opacity: 0.8;
  }
`;

// e.g. "80% of runs meet the target (≤ 10ms)"
const success_tooltip = (success_frac, m) =>
  `${percent_formatter.format(100 * success_frac)}% of runs meet the target (${m.smaller_is_better ? '≤' : '≥'} ${metric_formatter(m.target * m.scale, m)}${m.suffix ?? ''})`;

const SuccessBar = ({ success_frac, metric }) => (
  <Tooltip content={success_tooltip(success_frac, metric)}>
    <SuccessBarTrack>
      <span style={{ width: `${100 * success_frac}%` }}>
        {success_frac > 0.4 && `${percent_formatter.format(100 * success_frac)}% met`}
      </span>
      {/* no label: it doesn't fit, the tooltip says it */}
      <span/>
    </SuccessBarTrack>
  </Tooltip>
);


const tags_breakdown = outputs => {
  const tags = {};
  const outputs_by_tag = {};
  outputs.forEach(output => {
    (output.test_input_metadata?.tags ?? []).forEach(tag => {
      tags[tag] = (tags[tag] ?? 0) + 1;
      (outputs_by_tag[tag] ??= []).push(output);
    });
  });
  return { tags, outputs_by_tag };
};

const no_runs = { outputs: {}, filtered: { outputs: [] } };

// labels: what the commit page calls the new and reference results, and their colors (useComparison().labels)
const MetricsSummary = ({ new_batch, ref_batch, breakdown_by_tag, metrics, selected_metrics: selected_metrics_, labels: labels_ }) => {
  const labels = useLabels(labels_);
  const { available_metrics = {}, summary_metrics = [] } = metrics ?? {};
  const used_metrics = new_batch?.used_metrics;

  // The same runs as GET /api/v1/commit/<sha>/compare, see utils/compare.js
  const { outputs_new, outputs_ref } = useMemo(
    () => new_batch?.filtered ? summary_outputs(new_batch, ref_batch?.filtered ? ref_batch : no_runs) : { outputs_new: [], outputs_ref: [] },
    [new_batch, ref_batch],
  );
  // By default we show the metrics we were given, or the project's summary metrics,
  // else those that changed the most vs the reference.
  const configured_keys = selected_metrics_?.map(m => m.key) ?? (Array.isArray(summary_metrics) && summary_metrics.length > 0 ? summary_metrics : null);
  const is_automatic = configured_keys === null;
  const changed_keys = useMemo(
    () => is_automatic ? changed_metrics(outputs_new, outputs_ref, Object.keys(available_metrics).filter(k => used_metrics?.has(k))) : [],
    [is_automatic, outputs_new, outputs_ref, available_metrics, used_metrics],
  );
  const default_keys = is_automatic ? changed_keys : configured_keys;
  // Users can change the selection, until the configuration changes: not when runs finish or are filtered.
  const default_signature = is_automatic ? '(automatic)' : configured_keys.join('\n');
  const [user_selection, setUserSelection] = useState(null);
  const selected_keys = user_selection?.default_signature === default_signature ? user_selection.keys : default_keys;
  const selected_metrics = selected_keys.map(k => metric_info(available_metrics, k));
  const setSelectedKeys = keys => setUserSelection({ default_signature, keys });
  const { tags, outputs_by_tag } = useMemo(
    () => breakdown_by_tag ? tags_breakdown(outputs_new) : { tags: {}, outputs_by_tag: {} },
    [breakdown_by_tag, outputs_new],
  );

  if (new_batch === null) return <span />;

  const batch_data = new_batch.data || {};
  const has_runs = new_batch.filtered?.outputs?.length > 0;
  const is_filtered = Object.keys(new_batch.outputs ?? {}).length > (new_batch.filtered?.outputs?.length ?? 0);
  const no_runs_state = outputs_new.length === 0 && <NonIdealState
    icon={is_filtered && !has_runs ? "filter" : "inbox"}
    title={is_filtered && !has_runs ? "No finished run matches the filter" : "No finished run to summarize yet"}
    description={has_runs ? "The summary appears once runs finish." : undefined}
  />;
  return (
    <div>
      {/* only the runs we aggregate: e.g. not after filtering on one configuration */}
      {(!batch_data.optimization && mixed_parameters(outputs_new).length > 0) && (
        <Callout intent={Intent.WARNING}>
          The aggregation below contains all runs, possibly with tuning <strong>parameters mixed together.</strong>
        </Callout>
      )}
      <MetricSelect available_metrics={available_metrics} used_metrics={new_batch.used_metrics} selected={selected_keys} onChange={setSelectedKeys}/>
      <br/>
      {breakdown_by_tag &&
        Object.entries(tags).map(([tag, count], idx) =>
          <Tag style={{ margin: '5px', background: plotly_palette(idx) }} key={tag}>
            {count} @{tag}
          </Tag>
        )}
      {no_runs_state}
      {!no_runs_state && is_automatic && default_keys.length === 0 && selected_metrics.length === 0 && <NoSummaryMetrics/>}
      {!no_runs_state && is_automatic && default_keys.length > 0 && selected_keys === default_keys && <AutomaticSummaryNote
        count={default_keys.length}
        has_reference={outputs_ref.length > 0}
      />}
      {!no_runs_state && selected_metrics.map(m =>
        <MetricSummary
          key={m.key}
          metric={m}
          outputs_new={outputs_new}
          outputs_ref={outputs_ref}
          outputs_by_tag={breakdown_by_tag ? outputs_by_tag : undefined}
          sides={labels}
        />
      )}
      {!no_runs_state && <UndeclaredMetricsNote metrics={selected_metrics}/>}
    </div>
  );
};

const NoSummaryMetrics = () => {
  const { docs_root } = useSiteConfig();
  return <NonIdealState
    icon="th-list"
    title="No metrics to summarize"
    description={<p>
      The runs don't have metrics with numbers: return them from your <code>run()</code> function.{" "}
      <a target="_blank" rel="noopener noreferrer" href={`${docs_root}docs/computing-quantitative-metrics`}>Learn more</a>
    </p>}
  />;
};

const note_style = { margin: '12px 0 0' };

// The project didn't choose which metrics to summarize
const AutomaticSummaryNote = ({ count, has_reference }) => {
  const { docs_root } = useSiteConfig();
  return <p className={Classes.TEXT_MUTED} style={note_style}>
    {has_reference
      ? `The ${count} metrics that changed the most vs the reference.`
      : `The first ${count} metrics.`}{" "}
    Pick others above, or choose those shown by default with <code>summary_metrics</code> in your metrics file.{" "}
    <a target="_blank" rel="noopener noreferrer" href={`${docs_root}docs/computing-quantitative-metrics#choosing-the-metrics-shown-by-default`}>Learn more</a>
  </p>;
};

// Helps declare metrics: the web app can't tell good from bad without knowing which way is better
const UndeclaredMetricsNote = ({ metrics }) => {
  const { docs_root } = useSiteConfig();
  const unknown = metrics.filter(is_direction_unknown);
  if (unknown.length === 0) return null;
  const names = unknown.slice(0, 3).map(m => m.label).join(', ') + (unknown.length > 3 ? ` and ${unknown.length - 3} more` : '');
  return <p className={Classes.TEXT_MUTED} style={note_style}>
    Higher or lower is better? QA-Board doesn't know for {names}: it shows their changes in neutral colors.{" "}
    <a target="_blank" rel="noopener noreferrer" href={`${docs_root}docs/computing-quantitative-metrics#declaring-metrics`}>Declare them</a> where your code computes them.
  </p>;
};

const filterMetric = (query, metric) => match_query(query)(`${metric.key} ${metric.label} ${metric.short_label}`);
const noMetrics = <MenuItem disabled={true} text="No matching metrics." />;

// Picks metrics among those the batch has.
// selected: keys of metrics, onChange(keys). Selected metrics the batch doesn't have stay selected.
const MetricSelect = ({ available_metrics = {}, used_metrics, selected, onChange }) => {
  const items = Object.values(available_metrics).filter(m => used_metrics.has(m.key));
  const shown = selected.map(k => available_metrics[k]).filter(m => m && used_metrics.has(m.key));
  const is_selected = metric => selected.includes(metric.key);
  const toggle = metric => onChange(is_selected(metric) ? selected.filter(k => k !== metric.key) : [...selected, metric.key]);
  const renderMetric = (metric, { handleClick, modifiers }) => {
    if (!modifiers.matchesPredicate)
      return null;
    const { key, ...rest } = metric;
    return <MenuItem
      active={modifiers.active}
      icon={is_selected(metric) ? "tick" : "blank"}
      key={key}
      label={key}
      text={<MetricHeader {...rest} show_suffix/>}
      onClick={handleClick}
      shouldDismissPopover={false}
    />;
  };
  return <MultiSelect
    items={items}
    itemPredicate={filterMetric}
    itemRenderer={renderMetric}
    onItemSelect={toggle}
    tagRenderer={({ key: _key, ...m }) => <MetricHeader {...m}/>}
    tagInputProps={{
      onRemove: (_tag, index) => onChange(selected.filter(k => k !== shown[index]?.key)),
      rightElement: selected.length > 0 ? <Button icon="cross" aria-label="Clear" minimal onClick={() => onChange([])}/> : null,
    }}
    noResults={noMetrics}
    selectedItems={shown}
    placeholder="Choose metrics…"
    popoverProps={{ minimal: true }}
  />;
};

// e.g. "+3%", and "0%" for tiny changes, not "-0%"
const format_delta = delta_relative => {
  const percent = 100 * delta_relative;
  if (Math.abs(percent) < 0.5) return "0%";
  return `${percent > 0 ? "+" : ""}${percent_formatter.format(percent)}%`;
};

const delta_intent = (delta_relative, smaller_is_better) => {
  if (smaller_is_better === null) return Intent.DEFAULT;
  if (delta_relative > 0.01) return smaller_is_better ? Intent.DANGER : Intent.SUCCESS;
  if (delta_relative < -0.01) return smaller_is_better ? Intent.SUCCESS : Intent.DANGER;
  return Intent.DEFAULT;
};

// A side's color in the plots, next to its numbers
const swatch = color => ({ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: color, marginRight: 8, verticalAlign: 'middle' });

// sides: the names and colors of what we compare (useComparison().labels)
const MetricSummary = ({ metric: m, outputs_new, outputs_ref, outputs_by_tag, sides }) => {
  const breakdown_by_tag = outputs_by_tag !== undefined;
  // The same numbers as GET /api/v1/commit/<sha>/compare, see utils/compare.js
  const new_values = metric_values(outputs_new, m.key);
  if (new_values.length === 0) return null;
  const ref_values = metric_values(outputs_ref, m.key);
  const { new_med, ref_med, delta_relative, new_pc_good, ref_pc_good } = summary_stats(new_values, ref_values, m);
  const intent = delta_intent(delta_relative, m.smaller_is_better);

  return (
    <MetricRow>
      <MetricTile>
        <Tooltip content={`${m.label}: median ${m.scale * new_med}${m.suffix ?? ''} over ${new_values.length} run${new_values.length === 1 ? '' : 's'}`}>
          <h3 className={Classes.HEADING}>
            {metric_formatter(m.scale * new_med, m)}{m.suffix}
            <span className={Classes.TEXT_MUTED}> median</span>
          </h3>
        </Tooltip>
        <br/>
        <Tooltip content={<span>{m.label}</span>}>
          <h5 className={Classes.HEADING}>{m.short_label}</h5>
        </Tooltip>
        <br/>
        {new_pc_good !== null && <SuccessBar success_frac={new_pc_good} metric={m}/>}
      </MetricTile>

      {!breakdown_by_tag && (
        <>
          {ref_values.length > 0 && <MetricTile>
            <Tooltip content={`Reference median: ${m.scale * ref_med}${m.suffix ?? ''} over ${ref_values.length} run${ref_values.length === 1 ? '' : 's'}`}>
              <h3 className={Classes.HEADING} style={{ fontSize: 18 }}>
                <span aria-hidden style={swatch(sides.colors.reference.css)}/>
                {metric_formatter(m.scale * ref_med, m)}{m.suffix}
                <span className={Classes.TEXT_MUTED}> {sides.reference}</span>
              </h3>
            </Tooltip>
            <h5 className={Classes.HEADING}>
              <Tooltip content={`Change of the median vs the reference: ${delta_relative > 0 ? '+' : ''}${metric_formatter(100 * delta_relative)}%. ${is_direction_unknown(m) ? direction_unknown : `${m.smaller_is_better ? 'Lower' : 'Higher'} is better.`}`}>
              <Tag intent={intent} minimal round>{format_delta(delta_relative)}</Tag>
              </Tooltip>
            </h5>
            {!!ref_pc_good && <SuccessBar success_frac={ref_pc_good} metric={m}/>}
          </MetricTile>}
          {new_values.length > 1 && <BoxPlots
            series={ref_values.length > 0 ? [new_values, ref_values] : [new_values]}
            metric={m}
            labels={[sides.new, sides.reference]}
            colors={[sides.colors.new.css, sides.colors.reference.css]}
          />}
        </>
      )}
      {/* in the colors of the tags' counts */}
      {breakdown_by_tag && (
        <BoxPlots
          series={Object.values(outputs_by_tag).map(outputs => metric_values(outputs, m.key))}
          metric={m}
          labels={Object.keys(outputs_by_tag)}
          colors={Object.keys(outputs_by_tag).map((_, i) => plotly_palette(i))}
          width={850}
          label_size={8}
        />
      )}
    </MetricRow>
  );
};

export {
  MetricSelect,
  MetricsSummary,
  MetricTag,
  MetricsTags,
  MetricHeader,
  metric_formatter,
  percent_formatter,
};
