// Histograms logged at each step, e.g. a layer's weights: their distribution over the steps as a heatmap (x: step,
// y: value, color: how many), like TensorBoard's and W&B's "distributions", the selected step marked. Below, the
// selected step's histogram as bars, the reference's at the same step as an outline.
import { useEffect, useRef } from "react";
import { Classes } from "@blueprintjs/core";

import { colorAt } from "../../image-viewer/colormaps";
import { distribution, histogramRange } from "./histogram";
import { snap } from "./media";

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

const Heatmap = ({ heat, steps, step, onStep, label }) => {
  const canvas = useRef(null);
  const plot_width = WIDTH - AXIS;
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
  }, [heat, columns, plot_width]);
  const marked = steps.length ? snap(steps, step) : null;
  const marker = marked !== null ? columns[steps.indexOf(marked)] : null;
  const pick = e => {
    const { left } = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - left;
    const i = columns.findIndex(c => x >= c.x0 && x < c.x1);
    if (i >= 0) onStep?.(steps[i]);
  };
  return <div style={{ display: 'flex', fontSize: 11 }} className={Classes.TEXT_MUTED}>
    <div style={{ width: AXIS, height: HEAT_HEIGHT, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', textAlign: 'right', paddingRight: 4 }}>
      <span>{format(heat.range.max)}</span>
      <span>{format(heat.range.min)}</span>
    </div>
    <div>
      <div style={{ position: 'relative', width: plot_width, height: HEAT_HEIGHT, cursor: onStep ? 'pointer' : undefined, outline: '1px solid rgba(128, 128, 128, 0.3)' }} onClick={pick}>
        <canvas ref={canvas} role="img" aria-label={label} style={{ width: plot_width, height: HEAT_HEIGHT, display: 'block' }}/>
        {marker && <div data-testid="histogram-step" style={{ position: 'absolute', top: 0, bottom: 0, left: marker.x0, width: Math.max(2, marker.x1 - marker.x0), border: '1px solid #f5498b', boxSizing: 'border-box', pointerEvents: 'none' }}/>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', width: plot_width }}>
        <span>step {steps[0]}</span>
        <span>{steps.at(-1)}</span>
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

export const Bars = ({ item_new, item_ref, colors, names }) => {
  const range = histogramRange([item_new, item_ref].filter(Boolean));
  if (!range) return null;
  const bars_new = densities(item_new);
  const bars_ref = densities(item_ref);
  const max = Math.max(...bars_new.map(b => b.density), ...bars_ref.map(b => b.density)) || 1;
  const plot_width = WIDTH - AXIS;
  const x = value => (value - range.min) / (range.max - range.min) * plot_width;
  const y = density => BARS_HEIGHT - density / max * (BARS_HEIGHT - 4);
  // the reference's outline, as steps
  const outline = bars_ref.length ? ['M', x(bars_ref[0].x0), BARS_HEIGHT, ...bars_ref.flatMap(b => ['L', x(b.x0), y(b.density), 'L', x(b.x1), y(b.density)]), 'L', x(bars_ref.at(-1).x1), BARS_HEIGHT].join(' ') : null;
  return <div style={{ display: 'flex', fontSize: 11, marginTop: 6 }} className={Classes.TEXT_MUTED}>
    <div style={{ width: AXIS }}/>
    <div>
      <svg width={plot_width} height={BARS_HEIGHT} role="img" aria-label="Histogram at the selected step" style={{ display: 'block', overflow: 'visible' }}>
        {bars_new.map((bar, i) => <rect key={i} x={x(bar.x0)} y={y(bar.density)} width={Math.max(0.5, x(bar.x1) - x(bar.x0) - 0.5)} height={BARS_HEIGHT - y(bar.density)} fill={colors.new} fillOpacity={0.75}>
          <title>{`${names.new}: ${format(bar.x0)} to ${format(bar.x1)}: ${bar.count}`}</title>
        </rect>)}
        {outline && <path d={outline} fill="none" stroke={colors.ref} strokeWidth={1.5} strokeDasharray="4 2"><title>{names.ref}</title></path>}
        <line x1={0} x2={plot_width} y1={BARS_HEIGHT} y2={BARS_HEIGHT} stroke="currentColor" strokeOpacity={0.4}/>
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', width: plot_width }}>
        <span>{format(range.min)}</span>
        <span>{format(range.max)}</span>
      </div>
    </div>
  </div>;
};

// entry_new, entry_ref: the key's { steps, by_step } in the new and reference runs (media.js). step: the one selected
const HistogramView = ({ entry_new, entry_ref, step, step_ref, onStep, colors, names }) => {
  const entries = histograms(entry_new);
  const range = histogramRange([...entries, ...histograms(entry_ref)].map(([, item]) => item));
  const heat = distribution(entries, ROWS, range);
  if (!heat) return <p className={Classes.TEXT_MUTED}>No values in these histograms.</p>;
  const item_new = step !== null ? entry_new.by_step.get(step)?.[0] : undefined;
  const item_ref = step_ref !== null && step_ref !== undefined ? entry_ref?.by_step.get(step_ref)?.[0] : undefined;
  return <div data-testid="histogram-view">
    <Heatmap heat={heat} steps={entry_new.steps} step={step} onStep={onStep} label="Distribution over the steps"/>
    <Bars item_new={item_new} item_ref={item_ref} colors={colors} names={names}/>
  </div>;
};

export default HistogramView;
