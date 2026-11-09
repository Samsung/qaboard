// A run that was done again. A run shows its latest attempt's results, and the server remembers how the earlier
// attempts ended, with their metrics (data.attempt, data.previous_attempts: backend/attempts.py).
import { Classes, Intent, Tag, Tooltip } from "@blueprintjs/core";
import { DateTime } from "luxon";

import { previousAttempts, attemptLogs } from "../utils/attempts";

const status_text = { success: 'succeeded', failed: 'failed', unfinished: "didn't finish" };
// not about what the run measured
const HIDDEN_METRICS = new Set(['is_failed', 'compute_time']);
const MAX_METRICS = 6;

export const previousAttemptText = ({ attempt, status, started_at, user, in_place } = {}) => {
  const when = started_at ? DateTime.fromISO(started_at, { zone: 'utc' }) : null;
  return [
    in_place ? `An earlier run in the same folder ${status_text[status] ?? 'ended'}` : `Attempt ${attempt ?? '?'} ${status_text[status] ?? 'ended'}`,
    user ? `by ${user}` : null,
    when?.isValid ? when.toLocal().toLocaleString(DateTime.DATETIME_MED) : null,
  ].filter(Boolean).join(', ');
};

const formatValue = value => typeof value === 'number' && !Number.isInteger(value) ? Number(value.toPrecision(4)).toString() : String(value);

// Its metrics, as a record of what it measured: "psnr 30.1 · latency 12.3 (+2 more)"
export const previousMetricsText = (metrics, max = MAX_METRICS) => {
  const entries = Object.entries(metrics ?? {}).filter(([key, value]) => !HIDDEN_METRICS.has(key) && (typeof value === 'number' || typeof value === 'boolean'));
  if (entries.length === 0) return null;
  const more = entries.length - max;
  return entries.slice(0, max).map(([key, value]) => `${key} ${formatValue(value)}`).join(' · ') + (more > 0 ? ` (+${more} more)` : '');
};

// `data`: the run's data. Nothing for runs done once.
export const AttemptTag = ({ data, style }) => {
  const attempt = data?.attempt;
  const previous = previousAttempts({ data });
  if (!(attempt > 1) && previous.length === 0) return null;
  const has_failures = previous.some(a => a.status === 'failed');
  const has_logs = attemptLogs({ data }).length > 0;
  const content = <div style={{ maxWidth: 420 }}>
    <div>This run was done again: these are the results of its latest attempt.</div>
    {previous.length > 0 && <ul className={Classes.LIST} style={{ margin: '6px 0 0', paddingLeft: 18 }}>
      {previous.map((a, index) => {
        const metrics = previousMetricsText(a.metrics);
        return <li key={index}>
          {previousAttemptText(a)}
          {metrics && <div style={{ opacity: 0.8, fontSize: 12 }}>{metrics}</div>}
        </li>;
      })}
    </ul>}
    {has_logs && <div style={{ marginTop: 6 }}>The logs of earlier attempts are in the Logs view.</div>}
  </div>;
  return <Tooltip content={content} hoverOpenDelay={200}>
    <Tag minimal round icon="repeat" intent={has_failures ? Intent.WARNING : Intent.NONE} style={style} data-testid="attempt-tag">
      {attempt > 1 ? `attempt ${attempt}` : 'done again'}
    </Tag>
  </Tooltip>;
};

export default AttemptTag;
