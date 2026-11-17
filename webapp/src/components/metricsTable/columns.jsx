// The metrics tables' column headers: what each metric is, which way is better, its target, how to sort by it,
// and a summary of the column (its distribution, or how runs changed).
import { Classes, Colors, Tooltip } from "@blueprintjs/core";

import { metric_formatter } from "../metrics";
import { default_sort_order, order_labels } from "../../selectors/sorting";
import { format_fixed } from "./stats";


const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
export const is_direction_unknown = metric => metric.smaller_is_better === null;
export const has_target = metric => metric.target !== undefined && metric.target !== null;

const unit = metric => (metric.suffix ?? '').trim();
// e.g. "26.7 dB", for tooltips
export const with_unit = (value, metric) => `${metric_formatter(value * (metric.scale ?? 1), metric)}${metric.suffix ?? ''}`;
// e.g. "≥ 30 dB"
export const target_text = metric => `${is_direction_unknown(metric) ? '' : metric.smaller_is_better ? '≤ ' : '≥ '}${with_unit(metric.target, metric)}`;

const direction_glyph = metric => is_direction_unknown(metric) ? '?' : metric.smaller_is_better ? '↓' : '↑';
const direction_text = metric => is_direction_unknown(metric)
  ? "Higher or lower is better? QA-Board doesn't know: declare it where your code computes the metric, to color cells green or red."
  : metric.smaller_is_better ? 'Lower is better.' : 'Higher is better.';


// sorting: { by, order } (useComparison().sorting), onSort({ by, order }): without it, headers don't sort
export const sort_state = (sorting, key) => sorting?.by === key ? sorting.order ?? default_sort_order(key) : null;
export const next_sort = (sorting, key) => {
  const order = sort_state(sorting, key);
  return { by: key, order: order === null ? default_sort_order(key) : -order };
};
export const aria_sort = order => order === 1 ? 'ascending' : order === -1 ? 'descending' : undefined;
// e.g. "Highest first. Click for lowest first."
const sort_hint = (sorting, key) => {
  const order = sort_state(sorting, key);
  const [ascending, descending] = order_labels(key);
  const next = next_sort(sorting, key).order === 1 ? ascending : descending;
  return order === null
    ? `Click to sort the runs by it, ${next.toLowerCase()}.`
    : `The runs are sorted by it, ${(order === 1 ? ascending : descending).toLowerCase()}. Click for ${next.toLowerCase()}.`;
};

// A button when the header sorts, else text. The sort's arrow is drawn in CSS (data-sort).
// props: e.g. from a Tooltip around it
export const SortButton = ({ sort_key, sorting, onSort, children, className, ...props }) => {
  const order = sort_state(sorting, sort_key);
  if (!onSort) return <span className={className} {...props}>{children}</span>;
  return <button
    type="button"
    {...props}
    className={className ? `sort-button ${className}` : 'sort-button'}
    data-sort={aria_sort(order)}
    onClick={() => onSort(next_sort(sorting, sort_key))}
  >{children}</button>;
};

// The header over a metric's column(s): its label, then which way is better and its target, or its unit.
// sorts_by: what sorting by it sorts by, e.g. "the new runs' values, not by the change"
// hint: how the table shows it, e.g. that cells are shaded by rank
export const MetricColumnHeader = ({ metric: m, sorting, onSort, colSpan, hint, sorts_by, target_hint }) => {
  const order = onSort ? sort_state(sorting, m.key) : null;
  const details = has_target(m)
    ? (is_direction_unknown(m) ? `? target ${with_unit(m.target, m)}` : target_text(m))
    : `${direction_glyph(m)}${unit(m) ? ` ${unit(m)}` : ''}`;
  // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- labeled by the metric's name, inside the tooltip
  return <th
    scope={colSpan > 1 ? 'colgroup' : 'col'}
    colSpan={colSpan}
    aria-sort={aria_sort(order)}
    className={order !== null ? 'metric-header sorted' : 'metric-header'}
  >
    <Tooltip
      placement="top"
      hoverOpenDelay={250}
      content={<div style={{ maxWidth: 360 }}>
        <strong>{m.label}</strong>{m.description && <> {m.description}</>}
        {m.label !== m.key && <div className={Classes.TEXT_MUTED}><code>{m.key}</code></div>}
        <div>{direction_text(m)}</div>
        {has_target(m) && <div>Target: {target_text(m)}{target_hint ? `. ${target_hint}` : ''}</div>}
        {hint && <div>{hint}</div>}
        {onSort && <div>{sort_hint(sorting, m.key)}{sorts_by ? ` It sorts by ${sorts_by}.` : ''}</div>}
      </div>}
    >
      <SortButton sort_key={m.key} sorting={sorting} onSort={onSort}>
        <span className="metric-label">{m.short_label}</span>
        <span className="metric-details">{details}</span>
      </SortButton>
    </Tooltip>
  </th>;
};


// A tiny histogram of a column's values. Bars are green where runs meet the target, red where they miss it.
// The median is the line.
const width = 64, height = 16;
const Histogram = ({ stats, meets }) => {
  const { bins, min, max, median } = stats;
  const highest = Math.max(...bins);
  const step = width / bins.length;
  const bin_value = i => bins.length === 1 ? min : min + (i + 0.5) * (max - min) / bins.length;
  const fill = i => meets === null ? 'var(--qa-text-muted)' : meets(bin_value(i)) ? Colors.GREEN4 : Colors.RED4;
  const median_x = max === min ? width / 2 : width * (median - min) / (max - min);
  return <svg width={width} height={height} aria-hidden className="histogram">
    {bins.map((count, i) => count > 0 && <rect
      key={i}
      x={bins.length === 1 ? width / 2 - 3 : i * step + 0.5}
      width={bins.length === 1 ? 6 : Math.max(1, step - 1)}
      y={height - Math.max(1.5, (height - 2) * count / highest)}
      height={Math.max(1.5, (height - 2) * count / highest)}
      fill={fill(i)}
      opacity={meets === null ? 0.55 : 0.8}
    />)}
    <line x1={median_x} x2={median_x} y1={0} y2={height} stroke="var(--qa-text)" strokeWidth={1.5}/>
  </svg>;
};

// The thin bar of how many runs meet the target
const MetBar = ({ met, count }) => <span className="met-bar" aria-hidden>
  <span style={{ width: `${100 * met / count}%` }}/>
</span>;

// A Metrics Table column's summary: the distribution of its values, their median, and how many runs meet the target.
// side: what the column shows, e.g. "new". decimals: the column's (column_decimals)
export const DistributionSummary = ({ stats, metric, side, decimals, meets }) => {
  if (stats.count === 0)
    return <td className="summary" aria-label="No values"><span className="empty" aria-hidden>–</span></td>;
  const scale = metric.scale ?? 1;
  const number = value => format_fixed(value * scale, decimals, v => metric_formatter(v, metric));
  const title = [
    `${metric.label}${side ? ` (${side})` : ''}: ${plural(stats.count, 'run')}${stats.missing ? `, ${stats.missing} without a value` : ''}`,
    `median ${with_unit(stats.median, metric)}`,
    `from ${with_unit(stats.min, metric)} to ${with_unit(stats.max, metric)}`,
    stats.met !== null && `${stats.met} of ${stats.count} meet the target (${target_text(metric)})`,
  ].filter(Boolean).join('\n');
  return <td className="summary" title={title}>
    {stats.count > 1 && <Histogram stats={stats} meets={meets}/>}
    <div><span className="number">{number(stats.median)}</span> <span className="muted">{stats.count > 1 ? 'median' : ''}</span></div>
    {stats.met !== null && <div className={stats.met === stats.count ? 'met all' : 'met'}>
      <MetBar met={stats.met} count={stats.count}/>
      <span className="number">{stats.met}/{stats.count}</span> met
    </div>}
  </td>;
};

// A Metrics Diff column's summary: how many runs got better, worse, or didn't change
export const ChangesSummary = ({ changes: c, metric }) => {
  const total = c.changed + c.unchanged;
  if (total === 0)
    return <td className="summary" aria-label="No values"><span className="empty" aria-hidden>–</span></td>;
  const known = c.better !== null;
  const title = [
    `${metric.label}: ${plural(total, 'run')} compared with their reference run`,
    known ? `${c.better} better, ${c.worse} worse, ${c.unchanged} the same` : `${c.changed} changed, ${c.unchanged} the same`,
    c.missing > 0 && `${c.missing} without a value on both sides`,
    c.median_change !== null && c.changed > 0 && `median change ${c.median_change > 0 ? '+' : ''}${metric_formatter(100 * c.median_change)}%`,
    !known && "QA-Board doesn't know if higher or lower is better",
  ].filter(Boolean).join('\n');
  // with a known direction, badges can still change: neither better nor worse
  const other = known ? c.changed - c.better - c.worse : c.changed;
  const segments = [['better', c.better], ['worse', c.worse], ['changed', other], ['same', c.unchanged]];
  return <td className="summary" title={title}>
    <span className="changes-bar" aria-hidden>
      {segments.map(([kind, count]) => count > 0 && <span key={kind} className={`segment-${kind}`} style={{ flexGrow: count }}/>)}
    </span>
    <div>
      {c.changed === 0
        ? <span className="muted">all the same</span>
        : [
          c.better > 0 && <span key="better" className="better"><span className="number">{c.better}</span> better</span>,
          c.worse > 0 && <span key="worse" className="worse"><span className="number">{c.worse}</span> worse</span>,
          other > 0 && <span key="changed"><span className="number">{other}</span> changed</span>,
        ].filter(Boolean).flatMap((part, i) => i > 0 ? [' · ', part] : [part])}
    </div>
  </td>;
};
