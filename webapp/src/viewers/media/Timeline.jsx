// The run's timeline: where each key logged media (a tick per step, a row per key, or a density strip when there are
// many), the run's main series faintly behind, the reference run's steps under it. Hovering previews the media at the
// step, clicking (or ←/→, Home/End) selects it.
import { useState } from "react";
import { Classes, HTMLSelect, Icon } from "@blueprintjs/core";

import { KIND_ICONS } from "./kinds";
import { STEP_CURSOR_COLOR } from "../../sideColors";
import { axisTicks } from "./axis";
import { formatStep, nextStep, snap, stepRange } from "./media";
import { useWidth } from "../audio/hooks";

const ROW = 14;
const MAX_ROWS = 6;
const DENSITY = 44;
const REF_ROW = 7;
const AXIS = 16;
const LABELS = 132;

const nearest = (steps, step) => {
  const before = snap(steps, step);
  const after = steps.find(s => s >= step);
  if (before === null) return after ?? null;
  if (after === undefined) return before;
  return step - before <= after - step ? before : after;
};

// Keys logged at the same steps share a row: one row per key repeats the same ticks, and says nothing more.
// Rows of several keys say how many, with every key in their title.
export const mergeRows = rows => {
  const groups = new Map();
  for (const row of rows) {
    const signature = `${row.only_ref ? 'ref' : 'new'}:${row.steps.join(',')}`;
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push(row);
  }
  return [...groups.values()].map(group => ({
    ...group[0],
    keys: group.map(row => row.key),
    label: group.length > 1 ? `${group.length} keys` : group[0].key,
    kind: group.every(row => row.kind === group[0].kind) ? group[0].kind : null,
  }));
};

// rows: [{ key, kind, steps, only_ref }] (only_ref: a key only the reference logged, its steps are the reference's);
// steps: the run's, ref_steps: the reference's; choices: the steps users can pick, either run's (media.js mediaSteps);
// series: { step, value } or null; preview(step): { src, label } of what to show on hover, or null
// header: what goes on the row above it, left of the series' picker (the step and its buttons)
const Timeline = ({ rows: logged_rows, steps, ref_steps, choices = steps, header, step, onStep, series, series_names = [], series_name, onSeriesChange, preview, names, colors }) => {
  const [container, width] = useWidth(800);
  const [hover, setHover] = useState(null);
  const rows = mergeRows(logged_rows);
  const labels = width >= 560 ? LABELS : 0;
  const plot = Math.max(80, width - labels - 8);
  const { min, max } = stepRange(steps, ref_steps);
  const x = s => max > min ? (s - min) / (max - min) * plot : plot / 2;
  const dense = rows.length > MAX_ROWS;
  const rows_height = dense ? DENSITY : Math.max(DENSITY, rows.length * ROW + 4);
  const has_ref = ref_steps.length > 0;
  const height = rows_height + (has_ref ? REF_ROW + 3 : 0) + AXIS;

  // one path per row: thousands of steps stay cheap
  const tick_path = (row_steps, y, h) => row_steps.map(s => `M${x(s).toFixed(1)} ${y}v${h}`).join('');
  let ticks;
  if (dense) {
    // how many keys logged at each step
    const counts = new Map();
    for (const row of logged_rows) for (const s of row.steps) counts.set(s, (counts.get(s) ?? 0) + 1);
    // at the bottom, under the series: the more keys logged at a step, the darker
    ticks = steps.map(s => <line key={s} x1={x(s)} x2={x(s)} y1={rows_height - 11} y2={rows_height - 2} stroke={colors.new} strokeOpacity={0.15 + 0.6 * (counts.get(s) ?? 0) / logged_rows.length} strokeWidth={1}/>);
  } else {
    ticks = rows.map((row, i) => <path key={row.key} d={tick_path(row.steps, 2 + i * ROW + 3, ROW - 6)} stroke={row.only_ref ? colors.reference : colors.new} strokeWidth={1.5} strokeOpacity={0.9} strokeDasharray={row.only_ref ? '2 1' : undefined}/>);
  }
  let series_path = null;
  if (series?.step?.length > 1) {
    const { min: low, max: high } = stepRange(series.value.filter(Number.isFinite));
    // dense: above the ticks
    const bottom = dense ? rows_height - 13 : rows_height - 2;
    const y = v => bottom - (high > low ? (v - low) / (high - low) : 0.5) * (bottom - 3);
    const points = series.step.map((s, i) => Number.isFinite(series.value[i]) && s >= min && s <= max ? `${x(s).toFixed(1)},${y(series.value[i]).toFixed(1)}` : null).filter(Boolean);
    if (points.length > 1) series_path = `M${points.join('L')}`;
  }
  const selected = x(step);
  const move = e => {
    const { left } = e.currentTarget.getBoundingClientRect();
    const at = nearest(choices, min + (e.clientX - left) / plot * (max - min));
    setHover(at === null ? null : { step: at });
  };
  const onKeyDown = e => {
    const target = { ArrowLeft: nextStep(choices, step, -1), ArrowRight: nextStep(choices, step, 1), Home: choices[0], End: choices.at(-1) }[e.key];
    if (target === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    onStep(target);
  };
  const shown = hover && preview ? preview(hover.step) : null;
  const tip_left = hover ? Math.min(Math.max(0, labels + x(hover.step) - 60), width - 128) : 0;

  return <div data-testid="media-timeline">
   <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0 8px', minHeight: 26, marginBottom: 2 }}>
    {header}
    {series_names.length > 0 && <div style={{ marginLeft: 'auto', minWidth: 0, maxWidth: '100%' }}>
      <HTMLSelect minimal value={series_name ?? ''} onChange={e => onSeriesChange(e.target.value || null)} aria-label="Series behind the timeline" style={{ fontSize: 11, maxWidth: '100%' }}
        options={[{ value: '', label: 'No series' }, ...series_names.map(name => ({ value: name, label: name }))]}/>
    </div>}
   </div>
   <div ref={container} style={{ position: 'relative', userSelect: 'none' }}>
    <div style={{ display: 'flex' }}>
      {labels > 0 && <div style={{ width: labels, flex: 'none', fontSize: 11, lineHeight: `${ROW}px`, paddingTop: 2, overflow: 'hidden' }} className={Classes.TEXT_MUTED}>
        {dense
          ? <div style={{ height: DENSITY - 2, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}><span>{series_path ? series_name : ''}</span><span>{logged_rows.length} keys</span></div>
          : rows.map(row => <div key={row.key} title={row.keys.join('\n')} style={{ height: ROW, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
              <Icon icon={KIND_ICONS[row.kind] ?? 'layers'} size={10} style={{ flex: 'none', opacity: 0.8 }}/>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.label}</span>
            </div>)}
        {has_ref && <div style={{ height: REF_ROW + 3, lineHeight: `${REF_ROW + 3}px`, marginTop: dense ? 0 : rows_height - rows.length * ROW - 2 }}>{names.reference}</div>}
      </div>}
      <svg
        width={plot}
        height={height}
        role="slider"
        tabIndex={0}
        aria-label="Step"
        aria-valuemin={choices[0]}
        aria-valuemax={choices.at(-1)}
        aria-valuenow={step}
        aria-valuetext={`step ${step}`}
        onKeyDown={onKeyDown}
        onMouseMove={move}
        onMouseLeave={() => setHover(null)}
        onClick={() => hover && onStep(hover.step)}
        className="qa-media-timeline-svg"
        style={{ display: 'block', cursor: 'pointer', overflow: 'visible' }}
      >
        <rect x={0} y={0} width={plot} height={rows_height} fill="currentColor" fillOpacity={0.035} rx={2}/>
        {series_path && <path d={series_path} fill="none" stroke="currentColor" strokeOpacity={dense ? 0.6 : 0.5} strokeWidth={1.5}><title>{series_name}</title></path>}
        {ticks}
        {has_ref && <path d={tick_path(ref_steps, rows_height + 3, REF_ROW)} stroke={colors.reference} strokeWidth={1.5} strokeOpacity={0.8}/>}
        {axisTicks(min, max, plot).map(t => <g key={t} transform={`translate(${x(t)},${height - AXIS})`}>
          <line y1={0} y2={3} stroke="currentColor" strokeOpacity={0.4}/>
          <text y={13} textAnchor={x(t) < 20 ? 'start' : x(t) > plot - 20 ? 'end' : 'middle'} fontSize={10} fill="currentColor" fillOpacity={0.6}>{formatStep(t)}</text>
        </g>)}
        {hover && <line x1={x(hover.step)} x2={x(hover.step)} y1={0} y2={height - AXIS} stroke="currentColor" strokeOpacity={0.35} strokeDasharray="2 2"/>}
        <line x1={selected} x2={selected} y1={-3} y2={height - AXIS + 2} stroke={STEP_CURSOR_COLOR} strokeWidth={2}/>
        <path d={`M${selected - 5} -7h10l-5 6z`} fill={STEP_CURSOR_COLOR}/>
      </svg>
    </div>
    {hover && <div role="tooltip" className={Classes.ELEVATION_2} style={{ position: 'absolute', left: tip_left, top: height + 4, width: 128, padding: 4, borderRadius: 3, background: 'var(--qa-surface, white)', zIndex: 20, pointerEvents: 'none', fontSize: 11 }}>
      <div style={{ fontWeight: 600 }}>step {formatStep(hover.step)}</div>
      {shown?.src && <div style={{ width: 120, height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(128,128,128,0.12)', margin: '3px 0' }}>
        <img src={shown.src} alt="" style={{ maxWidth: 120, maxHeight: 80, imageRendering: 'pixelated' }}/>
      </div>}
      {shown?.label && <div className={Classes.TEXT_MUTED} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{shown.label}</div>}
    </div>}
   </div>
  </div>;
};

export default Timeline;
