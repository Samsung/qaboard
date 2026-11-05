// Metrics a script added to a finished run, after the fact (`run.log_metrics()`, PATCH /api/v1/output/<id>/metrics):
// the server records who added them, when and with which script in the run's `data.added_metrics` (api/normalize.js).
import { Classes, Icon, Tooltip } from "@blueprintjs/core";

import { format } from "../utils";
import { parseDate, relativeTime } from "../settings/format";


const format_value = (value, metric) => typeof value === 'number' && metric
  ? `${format(value * (metric.scale ?? 1), { precision: metric.precision ?? 3 })}${metric.suffix ?? ''}`
  : JSON.stringify(value);

// e.g. "Added 2 days ago by alice with sharpness.py. It replaced the run's value, 30."
// `added`: an entry of the run's `added_metrics`, `metric`: how to show the replaced value (scale, suffix…)
export const addedMetricText = (added, metric) => {
  const date = parseDate(added.at);
  const parts = ['Added'];
  if (date?.isValid) parts.push(relativeTime(date));
  if (added.user) parts.push(`by ${added.user}`);
  if (added.script) parts.push(`with ${added.script}`);
  if (parts.length === 1) parts.push('by a script');
  let text = `${parts.join(' ')}.`;
  if (added.replaced !== undefined) text += ` It replaced the run's value, ${format_value(added.replaced, metric)}.`;
  if (added.note) text += ` Note: ${added.note}`;
  return text;
};

const mark_style = { marginLeft: 3, verticalAlign: 'baseline' };

// Next to a metric value that a script added. Quiet, so that it doesn't compete with the colors saying better or worse.
// `native`: a native tooltip, for tables, that can have thousands of cells. `label`: which run, when cells show several
export const AddedMetricMark = ({ added, metric, native = false, label }) => {
  if (!added) return null;
  const text = `${label ? `${label}: ` : ''}${addedMetricText(added, metric)}`;
  const icon = <Icon icon="edit" size={10} className={Classes.TEXT_MUTED} style={mark_style}
    aria-label={text} title={native ? text : undefined} data-testid="added-metric"/>;
  if (native) return icon;
  return <Tooltip content={text} hoverOpenDelay={200}>{icon}</Tooltip>;
};

// For the tables' headers: e.g. "3 runs have values added by scripts."
export const addedMetricsHint = (outputs, key) => {
  const count = outputs.filter(o => o?.added_metrics?.[key]).length;
  if (count === 0) return undefined;
  return `${count === 1 ? '1 run has a value' : `${count} runs have values`} added by scripts after they ran.`;
};
