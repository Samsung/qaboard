// A run that was done again: `qa` saves each attempt in its own directory, and the server remembers how the earlier
// attempts ended (data.attempt, data.previous_attempts: backend/attempts.py). A run shows its latest attempt's results.
import { Classes, Intent, Tag, Tooltip } from "@blueprintjs/core";
import { DateTime } from "luxon";

const status_text = { success: 'succeeded', failed: 'failed', unfinished: "didn't finish" };

export const previousAttemptText = ({ attempt, status, started_at, user } = {}) => {
  const when = started_at ? DateTime.fromISO(started_at, { zone: 'utc' }) : null;
  return [
    `Attempt ${attempt ?? '?'} ${status_text[status] ?? 'ended'}`,
    user ? `by ${user}` : null,
    when?.isValid ? when.toLocal().toLocaleString(DateTime.DATETIME_MED) : null,
  ].filter(Boolean).join(', ');
};

// `data`: the run's data. Nothing for runs done once.
export const AttemptTag = ({ data, style }) => {
  const attempt = data?.attempt;
  const previous = (data?.previous_attempts ?? []).filter(a => a && typeof a === 'object');
  if (!(attempt > 1) && previous.length === 0) return null;
  const has_failures = previous.some(a => a.status === 'failed');
  const content = <div style={{ maxWidth: 380 }}>
    <div>This run was done again: these are the results of its latest attempt.</div>
    {previous.length > 0 && <ul className={Classes.LIST} style={{ margin: '6px 0 0', paddingLeft: 18 }}>
      {previous.map((a, index) => <li key={index}>{previousAttemptText(a)}</li>)}
    </ul>}
  </div>;
  return <Tooltip content={content} hoverOpenDelay={200}>
    <Tag minimal round icon="repeat" intent={has_failures ? Intent.WARNING : Intent.NONE} style={style} data-testid="attempt-tag">
      {attempt > 1 ? `attempt ${attempt}` : 'done again'}
    </Tag>
  </Tooltip>;
};

export default AttemptTag;
