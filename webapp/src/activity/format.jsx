// How runs activity looks: statuses, their colors, durations, the bars that compare them, and the timeline
import { Classes, Colors, Spinner, Tag, Tooltip } from "@blueprintjs/core";
import { DateTime } from "luxon";
import styled from "styled-components";

import { parseDate } from "../settings/format";


// "45s", "7min", "2h 30min", "9d 3h": as precise as people need
export const formatDuration = seconds => {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '';
  const s = Math.max(0, Math.round(seconds));
  const days = Math.floor(s / 86400), hours = Math.floor(s % 86400 / 3600), minutes = Math.floor(s % 3600 / 60);
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours) return minutes ? `${hours}h ${minutes}min` : `${hours}h`;
  if (minutes) return `${minutes}min`;
  return `${s}s`;
};


export const statuses = {
  waiting: { label: 'Waiting', icon: 'time', intent: 'warning', color: Colors.ORANGE4, description: "Queued, e.g. by LSF: the cluster didn't start them yet." },
  running: { label: 'Running', intent: 'primary', color: Colors.BLUE3, description: "Started, not ended yet." },
  done: { label: 'Done', icon: 'tick', intent: 'success', color: Colors.GREEN4, description: "Ended successfully." },
  failed: { label: 'Failed', icon: 'cross', intent: 'danger', color: Colors.RED3, description: "Ended with an error, were stopped, or were marked as failed." },
};
export const status_order = ['running', 'waiting', 'failed', 'done'];

export const formatNumber = value => (value ?? 0).toLocaleString('en-US');
export const plural = (count, word, words = `${word}s`) => `${formatNumber(count)} ${count === 1 ? word : words}`;

// Seconds since a date, from the server's clock if we have it
export const secondsSince = (iso, now_iso) => {
  const date = parseDate(iso);
  if (!date?.isValid) return null;
  const now = parseDate(now_iso);
  return ((now?.isValid ? now : DateTime.local()).diff(date, 'seconds').seconds);
};

export const RunStatus = ({ status, minimal = true }) => {
  const s = statuses[status] ?? { label: status };
  return <Tag minimal={minimal} intent={s.intent} icon={status === 'running' ? <Spinner size={12}/> : s.icon} style={{ whiteSpace: 'nowrap' }}>{s.label}</Tag>;
};


const Stack = styled.div`
  display: flex;
  height: 8px;
  border-radius: 4px;
  overflow: hidden;
  min-width: 90px;
  background: var(--qa-border, ${Colors.LIGHT_GRAY3});
  > div { height: 100%; }
`;

// How many runs wait, run, ended and failed, as one bar, with the counts
export const StatusBar = ({ counts, style }) => {
  const total = status_order.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
  const parts = status_order.filter(s => counts[s] > 0);
  return <div style={{ minWidth: 150, ...style }}>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontVariantNumeric: 'tabular-nums', fontSize: 12, marginBottom: 3 }}>
      {parts.length === 0 && <span className={Classes.TEXT_MUTED}>No runs</span>}
      {parts.map(s => <span key={s} style={{ whiteSpace: 'nowrap' }}>
        <span aria-hidden="true" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: statuses[s].color, marginRight: 4 }}/>
        <strong>{formatNumber(counts[s])}</strong> {statuses[s].label.toLowerCase()}
      </span>)}
    </div>
    <Stack aria-hidden="true">
      {parts.map(s => <div key={s} style={{ width: `${100 * counts[s] / total}%`, background: statuses[s].color }}/>)}
    </Stack>
  </div>;
};


const Bars = styled.div`
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: ${props => props.$height}px;
  > div {
    flex: 1 1 0;
    min-width: 3px;
    height: 100%;
    display: flex;
    flex-direction: column-reverse;
    border-radius: 2px 2px 0 0;
    overflow: hidden;
  }
`;

const bar_time = (iso, step_seconds) => {
  const date = parseDate(iso);
  if (!date?.isValid) return '';
  const end = date.plus({ seconds: step_seconds });
  const same_day = date.hasSame(end, 'day');
  return `${date.toLocaleString(DateTime.DATETIME_SHORT)} – ${end.toLocaleString(same_day ? DateTime.TIME_SIMPLE : DateTime.DATETIME_SHORT)}`;
};

// The load over the window: runs that waited and ran during each bar (above), and the runs that ended (below)
export const Timeline = ({ timeline, height = 90 }) => {
  const bars = timeline?.bars ?? [];
  if (!bars.length) return null;
  const max_load = Math.max(1, ...bars.map(b => b.waiting + b.running));
  const max_ended = Math.max(1, ...bars.map(b => b.done + b.failed));
  const tooltip = bar => <div style={{ fontVariantNumeric: 'tabular-nums' }}>
    <div style={{ marginBottom: 4 }}>{bar_time(bar.at, timeline.step_seconds)}</div>
    <div>{formatNumber(bar.running)} running, {formatNumber(bar.waiting)} waiting</div>
    <div>{formatNumber(bar.done)} done, {formatNumber(bar.failed)} failed</div>
  </div>;
  return <figure style={{ margin: 0 }} aria-label="Runs over time">
    <Bars $height={height} role="img" aria-label="Runs waiting and running over time">
      {bars.map(bar => <div key={bar.at}>
        <Tooltip content={tooltip(bar)} hoverOpenDelay={50} targetTagName="div" targetProps={{ style: { height: '100%', display: 'flex', flexDirection: 'column-reverse' } }}>
          <div data-testid="timeline-bar" style={{ height: '100%', display: 'flex', flexDirection: 'column-reverse' }}>
            <div style={{ height: `${100 * bar.running / max_load}%`, background: statuses.running.color }}/>
            <div style={{ height: `${100 * bar.waiting / max_load}%`, background: statuses.waiting.color }}/>
          </div>
        </Tooltip>
      </div>)}
    </Bars>
    <Bars $height={Math.round(height / 3)} aria-hidden="true" style={{ alignItems: 'flex-start', marginTop: 2 }}>
      {bars.map(bar => <div key={bar.at} style={{ flexDirection: 'column', borderRadius: '0 0 2px 2px' }}>
        <div style={{ height: `${100 * bar.done / max_ended}%`, background: statuses.done.color, opacity: 0.7 }}/>
        <div style={{ height: `${100 * bar.failed / max_ended}%`, background: statuses.failed.color }}/>
      </div>)}
    </Bars>
    <figcaption className={Classes.TEXT_MUTED} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginTop: 4, gap: 8, flexWrap: 'wrap' }}>
      <span>{parseDate(bars[0].at)?.toRelative()}</span>
      <span>
        {['running', 'waiting', 'done', 'failed'].map(s => <span key={s} style={{ marginRight: 10, whiteSpace: 'nowrap' }}>
          <span aria-hidden="true" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: statuses[s].color, marginRight: 4 }}/>
          {s === 'running' || s === 'waiting' ? `${statuses[s].label}` : `${statuses[s].label} (below)`}
        </span>)}
      </span>
      <span>now</span>
    </figcaption>
  </figure>;
};
