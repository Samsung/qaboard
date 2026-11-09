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


// Status colors are for fills: as text, the light ones (orange) are hard to read. This is the text.
const text_colors = {
  waiting: [Colors.ORANGE2, Colors.ORANGE5],
  running: [Colors.BLUE2, Colors.BLUE5],
  done: [Colors.GREEN2, Colors.GREEN5],
  failed: [Colors.RED2, Colors.RED5],
};
export const StatusText = styled.span`
  color: ${props => text_colors[props.$status]?.[0] ?? 'inherit'};
  .bp6-dark & { color: ${props => text_colors[props.$status]?.[1] ?? 'inherit'}; }
`;


const Chart = styled.figure`
  margin: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 6px;
  .axis { font-size: 11px; font-variant-numeric: tabular-nums; text-align: right; display: flex; flex-direction: column; justify-content: space-between; }
  .plot { position: relative; min-width: 0; }
  .columns { display: flex; gap: 2px; }
  .column { flex: 1 1 0; min-width: 3px; display: flex; flex-direction: column; }
  .load, .ended { display: flex; overflow: hidden; }
  .load { flex-direction: column-reverse; border-radius: 2px 2px 0 0; border-bottom: 1px solid var(--qa-border, ${Colors.GRAY4}); }
  .ended { flex-direction: column; border-radius: 0 0 2px 2px; }
  .column:hover .load, .column:hover .ended { filter: brightness(1.15); }
  .gridline { position: absolute; left: 0; right: 0; top: 0; border-top: 1px dashed var(--qa-border, ${Colors.LIGHT_GRAY1}); pointer-events: none; }
  .ticks { position: relative; height: 16px; font-size: 11px; margin-top: 2px; }
  .ticks > span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
`;

const bar_time = (iso, step_seconds) => {
  const date = parseDate(iso);
  if (!date?.isValid) return '';
  const end = date.plus({ seconds: step_seconds });
  const same_day = date.hasSame(end, 'day');
  return `${date.toLocaleString(DateTime.DATETIME_SHORT)} – ${end.toLocaleString(same_day ? DateTime.TIME_SIMPLE : DateTime.DATETIME_SHORT)}`;
};

// A few readable times under the bars, in local time: hours, or days for long windows
const ticks = (bars, step_seconds) => {
  const total = bars.length * step_seconds;
  const every = total <= 3 * 3600 ? 15 * 60 : total <= 12 * 3600 ? 2 * 3600 : total <= 48 * 3600 ? 6 * 3600 : 24 * 3600;
  const start = parseDate(bars[0]?.at);
  if (!start?.isValid) return [];
  const answer = [];
  for (let date = start.startOf('day'); date.diff(start, 'seconds').seconds < total; date = date.plus({ seconds: every })) {
    const offset = date.diff(start, 'seconds').seconds;
    // not too close to the edges, where the label would be cut
    if (offset < total * 0.03 || offset > total * 0.97) continue;
    const midnight = date.hour === 0 && date.minute === 0;
    answer.push({ left: 100 * offset / total, text: every >= 24 * 3600 ? date.toFormat('ccc d') : midnight ? date.toFormat('ccc') : date.toFormat('HH:mm') });
  }
  return answer;
};

// a bar for a few failures still shows
const height = (count, max) => count > 0 ? `max(2px, ${100 * count / max}%)` : '0';

// The load over the window: runs that waited and ran during each bar (above), and the runs that ended (below)
export const Timeline = ({ timeline, height: plot_height = 90 }) => {
  const bars = timeline?.bars ?? [];
  if (!bars.length) return null;
  const max_load = Math.max(1, ...bars.map(b => b.waiting + b.running));
  const max_ended = Math.max(1, ...bars.map(b => b.done + b.failed));
  const ended_height = Math.round(plot_height / 3);
  const tooltip = bar => <div style={{ fontVariantNumeric: 'tabular-nums' }}>
    <div style={{ marginBottom: 4 }}>{bar_time(bar.at, timeline.step_seconds)}</div>
    <div>{formatNumber(bar.running)} running, {formatNumber(bar.waiting)} waiting</div>
    <div>{formatNumber(bar.done)} done, {formatNumber(bar.failed)} failed</div>
  </div>;
  const legend = s => <span key={s} style={{ whiteSpace: 'nowrap' }}>
    <span aria-hidden="true" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: statuses[s].color, marginRight: 4 }}/>
    {statuses[s].label}
  </span>;
  return <Chart aria-label="Runs over time">
    <div className={`axis ${Classes.TEXT_MUTED}`} style={{ height: plot_height }} aria-hidden="true">
      <span title="The most runs waiting and running at once">{formatNumber(max_load)}</span><span>0</span>
    </div>
    <div className="plot">
      <div className="gridline" aria-hidden="true"/>
      <div className="columns" role="img" aria-label="Runs waiting and running over time">
        {bars.map(bar => <Tooltip key={bar.at} content={tooltip(bar)} hoverOpenDelay={50} targetTagName="div" targetProps={{ className: 'column' }}>
          <div data-testid="timeline-bar" style={{ display: 'contents' }}>
            <div className="load" style={{ height: plot_height }}>
              <div style={{ height: height(bar.running, max_load), background: statuses.running.color, flexShrink: 0 }}/>
              <div style={{ height: height(bar.waiting, max_load), background: statuses.waiting.color, flexShrink: 0 }}/>
            </div>
            <div className="ended" style={{ height: ended_height, marginTop: 1 }}>
              <div style={{ height: height(bar.failed, max_ended), background: statuses.failed.color, flexShrink: 0 }}/>
              <div style={{ height: height(bar.done, max_ended), background: statuses.done.color, opacity: 0.7, flexShrink: 0 }}/>
            </div>
          </div>
        </Tooltip>)}
      </div>
      <div className={`ticks ${Classes.TEXT_MUTED}`} aria-hidden="true">
        {ticks(bars, timeline.step_seconds).map(t => <span key={t.left} style={{ left: `${t.left}%` }}>{t.text}</span>)}
      </div>
    </div>
    <span/>
    <figcaption className={Classes.TEXT_MUTED} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, gap: 8, flexWrap: 'wrap' }}>
      <span style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <span>Pending:</span>{legend('running')}{legend('waiting')}
        <span style={{ marginLeft: 6 }}>Ended (below):</span>{legend('done')}{legend('failed')}
      </span>
      <span title={`Each bar is ${formatDuration(timeline.step_seconds)}`}>{formatDuration(timeline.step_seconds)} bars</span>
    </figcaption>
  </Chart>;
};
