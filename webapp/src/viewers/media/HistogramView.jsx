// Histograms logged at each step, e.g. a layer's weights: their distribution over the steps as a heatmap (x: step,
// y: value, color: how many), like TensorBoard's and W&B's "distributions", the selected step marked. Below, the
// selected step's histogram as bars, the reference's at the same step as an outline.
import { useEffect, useRef } from "react";
import { Classes } from "@blueprintjs/core";

import { colorAt } from "../../image-viewer/colormaps";
import { STEP_CURSOR_COLOR } from "../../sideColors";
import { axisTicks } from "./axis";
import { distribution, histogramRange, quantiles } from "./histogram";
import { formatStep, nextStep, snap } from "./media";
import { useWidth } from "../audio/hooks";

const WIDTH = 480;
const HEAT_HEIGHT = 140;
const BARS_HEIGHT = 90;
const ROWS = 64;
const AXIS = 44;

const histograms = entry => entry ? entry.steps.map(step => [step, entry.by_step.get(step)[0]]) : [];
const format = value => Math.abs(value) >= 1e4 || (value !== 0 && Math.abs(value) < 1e-3) ? value.toExponential(1) : +value.toPrecision(3);

// Where each step's column goes, from its step to the next: [{ x0, x1 }] in pixels of the plot's width
export const columnsX = (steps, width) => {
  if (steps.length === 0) return [];
  if (steps.length === 1) return [{ x0: 0, x1: width }];
  const first = steps[0];
  // the last column is as wide as the average
  const span = steps.at(-1) - first;
  const last = steps.at(-1) + span / (steps.length - 1);
  const x = step => (step - first) / (last - first) * width;
  return steps.map((step, i) => ({ x0: x(step), x1: x(steps[i + 1] ?? last) }));
};

// The steps under the heatmap, labeled like the timeline's: round numbers, at the middle of their column
const StepAxis = ({ steps, columns, width }) => {
  if (!steps.length) return null;
  const first = steps[0], last = steps.at(-1);
  // a step is at the middle of its column; between steps, in proportion
  const middles = columns.map(({ x0, x1 }) => (x0 + x1) / 2);
  const x = step => {
    if (steps.length === 1) return middles[0];
    const i = Math.min(steps.length - 2, Math.max(0, steps.findLastIndex(s => s <= step)));
    return middles[i] + (step - steps[i]) / (steps[i + 1] - steps[i] || 1) * (middles[i + 1] - middles[i]);
  };
  const ticks = axisTicks(first, last, width);
  return <svg width={width} height={16} style={{ display: 'block', overflow: 'visible' }} aria-hidden>
    {ticks.map(t => <g key={t} transform={`translate(${x(t)},0)`}>
      <line y1={0} y2={3} stroke="currentColor" strokeOpacity={0.4}/>
      <text y={13} textAnchor={x(t) < 20 ? 'start' : x(t) > width - 20 ? 'end' : 'middle'} fontSize={10} fill="currentColor" fillOpacity={0.6}>{formatStep(t)}</text>
    </g>)}
  </svg>;
};

const legend_style = { display: 'flex', justifyContent: 'flex-end', gap: 10, fontSize: 11, marginBottom: 2 };

// bands: per step, the [5%, median, 95%] values, drawn as lines over the heatmap
const Heatmap = ({ heat, bands, steps, step, onStep, label, width }) => {
  const canvas = useRef(null);
  const plot_width = width - AXIS;
  const columns = columnsX(steps, plot_width);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext?.('2d');
    if (!context || !heat) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = plot_width * ratio;
    element.height = HEAT_HEIGHT * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, plot_width, HEAT_HEIGHT);
    const row_height = HEAT_HEIGHT / heat.rows;
    heat.columns.forEach(({ values }, i) => {
      const { x0, x1 } = columns[i];
      for (let row = 0; row < heat.rows; row++) {
        if (!values[row]) continue;
        // sqrt: the tails stay visible next to the peak
        const [r, g, b] = colorAt('viridis', Math.sqrt(values[row] / heat.max));
        context.fillStyle = `rgb(${r},${g},${b})`;
        // the highest values at the top
        context.fillRect(x0, HEAT_HEIGHT - (row + 1) * row_height, Math.max(1, x1 - x0 + 0.5), row_height + 0.5);
      }
    });
    const y = value => HEAT_HEIGHT - (value - heat.range.min) / (heat.range.max - heat.range.min) * HEAT_HEIGHT;
    for (const [q, dash, width] of [[0, [3, 2], 1], [2, [3, 2], 1], [1, [], 1.5]]) {
      context.beginPath();
      context.setLineDash(dash);
      context.lineWidth = width;
      context.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      let started = false;
      bands.forEach((band, i) => {
        if (!band) return;
        const middle = (columns[i].x0 + columns[i].x1) / 2;
        if (started) context.lineTo(middle, y(band[q])); else context.moveTo(middle, y(band[q]));
        started = true;
      });
      context.stroke();
    }
    context.setLineDash([]);
  }, [heat, bands, columns, plot_width]);
  const marked = steps.length ? snap(steps, step) : null;
  const marker = marked !== null ? columns[steps.indexOf(marked)] : null;
  const pick = e => {
    const { left } = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - left;
    const i = columns.findIndex(c => x >= c.x0 && x < c.x1);
    if (i >= 0) onStep?.(steps[i]);
  };
  return <div className={Classes.TEXT_MUTED} style={{ fontSize: 11 }}>
   <div style={{ ...legend_style, width }}><span>— median</span><span>- - 5–95%</span></div>
   <div style={{ display: 'flex' }}>
    <div style={{ width: AXIS, height: HEAT_HEIGHT, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', textAlign: 'right', paddingRight: 4 }}>
      <span>{format(heat.range.max)}</span>
      <span>{format(heat.range.min)}</span>
    </div>
    <div>
      <div style={{ position: 'relative', width: plot_width, height: HEAT_HEIGHT, cursor: onStep ? 'pointer' : undefined, outline: '1px solid rgba(128, 128, 128, 0.3)' }} onClick={pick}
        role="slider" tabIndex={0} aria-label="Step of the histogram" aria-valuemin={steps[0]} aria-valuemax={steps.at(-1)} aria-valuenow={marked ?? steps[0]}
        onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); onStep?.(nextStep(steps, marked ?? steps[0], e.key === 'ArrowRight' ? 1 : -1)); } }}>
        <canvas ref={canvas} role="img" aria-label={label} style={{ width: plot_width, height: HEAT_HEIGHT, display: 'block' }}/>
        {marker && <div data-testid="histogram-step" style={{ position: 'absolute', top: 0, bottom: 0, left: marker.x0, width: Math.max(2, marker.x1 - marker.x0), border: `1px solid ${STEP_CURSOR_COLOR}`, boxSizing: 'border-box', pointerEvents: 'none' }}/>}
      </div>
      <StepAxis steps={steps} columns={columns} width={plot_width}/>
    </div>
   </div>
  </div>;
};

// The density of a histogram (comparable whatever its bins and number of values) as [{ x0, x1, density, count }]
const densities = item => {
  if (!item) return [];
  const total = item.counts.reduce((a, b) => a + b, 0) || 1;
  return item.counts.map((count, i) => {
    const x0 = item.bins[i], x1 = item.bins[i + 1];
    return { x0, x1, count, density: x1 > x0 ? count / total / (x1 - x0) : 0 };
  });
};

export const Bars = ({ item_new, item_ref, colors, names, width = WIDTH }) => {
  const range = histogramRange([item_new, item_ref].filter(Boolean));
  if (!range) return null;
  const bars_new = densities(item_new);
  const bars_ref = densities(item_ref);
  // a loop: histograms can have more bins than a function takes arguments
  const max = [...bars_new, ...bars_ref].reduce((m, b) => b.density > m ? b.density : m, 0) || 1;
  const plot_width = width - AXIS;
  const x = value => (value - range.min) / (range.max - range.min) * plot_width;
  const y = density => BARS_HEIGHT - density / max * (BARS_HEIGHT - 4);
  // the reference's outline, as steps
  const outline = bars_ref.length ? ['M', x(bars_ref[0].x0), BARS_HEIGHT, ...bars_ref.flatMap(b => ['L', x(b.x0), y(b.density), 'L', x(b.x1), y(b.density)]), 'L', x(bars_ref.at(-1).x1), BARS_HEIGHT].join(' ') : null;
  return <div className={Classes.TEXT_MUTED} style={{ fontSize: 11, marginTop: 6 }}>
   <div style={{ ...legend_style, width }} data-testid="histogram-legend">
    <span><span aria-hidden style={{ display: 'inline-block', width: 9, height: 9, background: colors.new, opacity: 0.75, marginRight: 4 }}/>{names.new}</span>
    {outline && <span><span aria-hidden style={{ display: 'inline-block', width: 12, borderTop: `2px dashed ${colors.reference}`, verticalAlign: 'middle', marginRight: 4 }}/>{names.reference}</span>}
   </div>
   <div style={{ display: 'flex' }}>
    <div style={{ width: AXIS }}/>
    <div>
      <svg width={plot_width} height={BARS_HEIGHT} role="img" aria-label="Histogram at the selected step" style={{ display: 'block', overflow: 'visible' }}>
        {bars_new.map((bar, i) => <rect key={i} x={x(bar.x0)} y={y(bar.density)} width={Math.max(0.5, x(bar.x1) - x(bar.x0) - 0.5)} height={BARS_HEIGHT - y(bar.density)} fill={colors.new} fillOpacity={0.75}>
          <title>{`${names.new}: ${format(bar.x0)} to ${format(bar.x1)}: ${bar.count}`}</title>
        </rect>)}
        {outline && <path d={outline} fill="none" stroke={colors.reference} strokeWidth={1.5} strokeDasharray="4 2"><title>{names.reference}</title></path>}
        <line x1={0} x2={plot_width} y1={BARS_HEIGHT} y2={BARS_HEIGHT} stroke="currentColor" strokeOpacity={0.4}/>
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', width: plot_width }}>
        <span>{format(range.min)}</span>
        <span>{format(range.max)}</span>
      </div>
    </div>
   </div>
  </div>;
};

// entry_new, entry_ref: the key's { steps, by_step } in the new and reference runs (media.js). step: the one selected
const HistogramView = ({ entry_new, entry_ref, step, step_ref, onStep, colors, names }) => {
  const [container, available] = useWidth(WIDTH);
  const width = Math.max(240, Math.min(720, available));
  const entries = histograms(entry_new);
  const range = histogramRange([...entries, ...histograms(entry_ref)].map(([, item]) => item));
  const heat = distribution(entries, ROWS, range);
  const bands = entries.map(([, item]) => quantiles(item, [0.05, 0.5, 0.95]));
  if (!heat) return <p className={Classes.TEXT_MUTED}>No values in these histograms.</p>;
  const item_new = step !== null ? entry_new.by_step.get(step)?.[0] : undefined;
  const item_ref = step_ref !== null && step_ref !== undefined ? entry_ref?.by_step.get(step_ref)?.[0] : undefined;
  return <div data-testid="histogram-view" ref={container}>
    <Heatmap heat={heat} bands={bands} steps={entry_new.steps} step={step} onStep={onStep} label="Distribution over the steps" width={width}/>
    <Bars item_new={item_new} item_ref={item_ref} colors={colors} names={names} width={width}/>
  </div>;
};

export default HistogramView;
