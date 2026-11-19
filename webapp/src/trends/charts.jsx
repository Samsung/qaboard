// The charts of the trends: columns stacked per commit, a line over the commits, sparklines. SVG, one y axis each,
// commits evenly spaced on x (what happened commit after commit matters more than when), oldest on the left.
// Charts of a section share the hovered commit: `hover` and `onHover`.
import { useLayoutEffect, useRef, useState } from 'react';

export function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(entries => setWidth(Math.round(entries[0].contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

// Round ticks from 0 (or the domain's start) to its end: [0, 500, 1000]
export function niceTicks(min, max, count = 3) {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * power).find(s => s >= raw);
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return ticks;
}

const short_date = date => {
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
};

export const PointTitle = ({ point }) => <div className="qa-trends-tip-title">
  <code>{point.label}</code>
  {point.date && <span className="qa-trends-muted">{short_date(point.date)}</span>}
  {point.message && <div className="qa-trends-tip-message">{point.message}</div>}
</div>;

const MARGIN = { top: 8, right: 12, bottom: 20, left: 44 };

// The frame of a chart: y gridlines and ticks, sparse dates under x, the hovered commit's band and tooltip.
// `children({x, y, band, inner_height})` draws the marks; `tooltip(index)` its rows for a commit.
export function Frame({ points, height = 140, domain, formatTick = String, hover, onHover, onSelect, tooltip, children, label, ticks: tick_count = 3, x_labels = true }) {
  const [ref, width] = useWidth();
  const margin = { ...MARGIN, bottom: x_labels ? MARGIN.bottom : 6 };
  const inner_width = Math.max(0, width - margin.left - margin.right);
  const inner_height = height - margin.top - margin.bottom;
  const count = points.length;
  const band = count > 0 ? inner_width / count : 0;
  const [min, max] = domain;
  const ticks = niceTicks(min, max, tick_count);
  const top = Math.max(max, ticks[ticks.length - 1] ?? max);
  const x = i => margin.left + (i + 0.5) * band;
  const y = value => margin.top + inner_height - (top === min ? 0 : (value - min) / (top - min)) * inner_height;
  const index_at = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    const i = Math.floor((event.clientX - rect.left - margin.left) / band);
    return i >= 0 && i < count ? i : null;
  };
  // about one date every 90px, always the last
  const every = Math.max(1, Math.ceil(90 / Math.max(band, 1)));
  const dated = [];
  for (let i = count - 1; i >= 0; i -= every) dated.push(i);
  const hovered = hover !== null && hover !== undefined && hover < count ? hover : null;
  const tip_left = hovered === null ? 0 : x(hovered);
  const flip = tip_left > width * 0.6;
  return <div className="qa-trends-chart" ref={ref} style={{ height }}>
    {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- the tables below link the same commits */}
    {width > 0 && <svg
      width={width}
      height={height}
      role="img"
      aria-label={label}
      onMouseMove={e => onHover?.(index_at(e))}
      onMouseLeave={() => onHover?.(null)}
      onClick={e => { const i = index_at(e); if (i !== null) onSelect?.(points[i], i); }}
      style={{ cursor: onSelect ? 'pointer' : undefined }}
    >
      {ticks.map(tick => <g key={tick}>
        <line className="qa-trends-grid" x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)}/>
        <text className="qa-trends-tick" x={margin.left - 6} y={y(tick)} dy="0.32em" textAnchor="end">{formatTick(tick)}</text>
      </g>)}
      {hovered !== null && <rect className="qa-trends-hover-band" x={x(hovered) - band / 2} y={margin.top} width={band} height={inner_height}/>}
      {children({ x, y, band, inner_height, margin, width })}
      {x_labels && dated.map(i => <text key={i} className="qa-trends-tick" x={x(i)} y={height - 5} textAnchor={i === count - 1 ? 'end' : 'middle'} dx={i === count - 1 ? band / 2 : 0}>
        {short_date(points[i].date) || points[i].label}
      </text>)}
    </svg>}
    {hovered !== null && tooltip && <div className="qa-trends-tip" style={flip ? { right: width - tip_left + 12 } : { left: tip_left + 12 }}>
      <PointTitle point={points[hovered]}/>
      {tooltip(hovered)}
    </div>}
  </div>;
}

export const TipRow = ({ color, label, value, extra }) => <div className="qa-trends-tip-row">
  {color && <span className="qa-trends-swatch" style={{ background: color }}/>}
  <span>{label}</span>
  <strong>{value}</strong>
  {extra && <span className="qa-trends-muted">{extra}</span>}
</div>;

// Columns stacked per commit. layers: [{key, label, color, values}], the first at the bottom.
export function Columns({ points, layers, height, formatValue = String, hover, onHover, onSelect, label }) {
  const totals = points.map((_, i) => layers.reduce((sum, layer) => sum + (layer.values[i] ?? 0), 0));
  const max = Math.max(1, ...totals);
  return <Frame
    points={points} height={height} domain={[0, max]} formatTick={formatValue} hover={hover} onHover={onHover} onSelect={onSelect} label={label}
    tooltip={i => <>
      {[...layers].reverse().map(layer => layer.values[i] !== null && layer.values[i] !== undefined && <TipRow key={layer.key} color={layer.color} label={layer.label} value={formatValue(layer.values[i])}/>)}
      {layers.every(layer => layer.values[i] === null || layer.values[i] === undefined) && <div className="qa-trends-muted">No report for this commit</div>}
    </>}
  >
    {({ x, y, band }) => {
      const bar = Math.max(1, Math.min(24, band - (band > 6 ? 2 : 0.5)));
      // a gap in the surface's color between the segments, when they are tall enough to spare it
      return points.map((point, i) => {
        let base = 0;
        return <g key={point.id ?? i}>
          {layers.map(layer => {
            const value = layer.values[i] ?? 0;
            if (value <= 0) return null;
            const y0 = y(base), y1 = y(base + value);
            base += value;
            const segment = y0 - y1;
            const gap = segment > 4 && base < totals[i] ? 1.5 : 0;
            return <rect key={layer.key} x={x(i) - bar / 2} y={y1 + gap} width={bar} height={Math.max(segment - gap, 1)} fill={layer.color} rx={bar >= 8 && base === totals[i] ? 2 : 0}/>;
          })}
        </g>;
      });
    }}
  </Frame>;
}

// The path of a line through the commits that have a value: a commit without one wasn't measured, the line goes on
const linePath = (values, x, y) => {
  let path = '', open = false;
  values.forEach((value, i) => {
    if (value === null || value === undefined) return;
    path += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(value).toFixed(1)}`;
    open = true;
  });
  return path;
};

// One series over the commits. `reference`: a horizontal line at that value (1 for ratios); `mark`: an index to
// point out (where the series moved the most).
export function Line({ points, values, height, domain: domain_, formatValue = String, color = 'var(--trends-line)', hover, onHover, onSelect, label, name, reference, mark, extra, x_labels, ticks }) {
  const present = values.filter(v => v !== null && v !== undefined);
  let domain = domain_;
  if (!domain) {
    const min = Math.min(...present, reference ?? Infinity), max = Math.max(...present, reference ?? -Infinity);
    const pad = (max - min || Math.abs(max) || 1) * 0.12;
    domain = [min >= 0 && min - pad < 0 ? 0 : min - pad, max + pad];
  }
  const last = values.reduce((found, v, i) => v !== null && v !== undefined ? i : found, null);
  return <Frame
    points={points} height={height} domain={domain} formatTick={formatValue} hover={hover} onHover={onHover} onSelect={onSelect} label={label} x_labels={x_labels} ticks={ticks}
    tooltip={i => values[i] === null || values[i] === undefined
      ? <div className="qa-trends-muted">Not measured in this commit</div>
      : <TipRow color={color} label={name} value={formatValue(values[i])} extra={extra?.(i)}/>}
  >
    {({ x, y, margin, width }) => <>
      {reference !== undefined && <line className="qa-trends-reference" x1={margin.left} x2={width - margin.right} y1={y(reference)} y2={y(reference)}/>}
      <path d={linePath(values, x, y)} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"/>
      {mark !== undefined && mark !== null && values[mark] !== null && <circle className="qa-trends-mark" cx={x(mark)} cy={y(values[mark])} r={5}/>}
      {last !== null && <circle cx={x(last)} cy={y(values[last])} r={4} fill={color} stroke="var(--qa-surface)" strokeWidth={2}/>}
      {hover !== null && hover !== undefined && values[hover] !== null && values[hover] !== undefined
        && <circle cx={x(hover)} cy={y(values[hover])} r={4} fill={color} stroke="var(--qa-surface)" strokeWidth={2}/>}
    </>}
  </Frame>;
}

// A small line without axes, for tiles and table rows. `mark`: an index to point out.
export function Sparkline({ values, width = 96, height = 24, color = 'var(--trends-line)', mark, domain }) {
  const present = values.filter(v => v !== null && v !== undefined);
  if (present.length === 0) return <svg width={width} height={height} aria-hidden="true"/>;
  const min = domain ? domain[0] : Math.min(...present), max = domain ? domain[1] : Math.max(...present);
  const pad = 3;
  const x = i => pad + (values.length === 1 ? 0.5 : i / (values.length - 1)) * (width - 2 * pad);
  const y = v => max === min ? height / 2 : pad + (1 - (v - min) / (max - min)) * (height - 2 * pad);
  const last = values.reduce((found, v, i) => v !== null && v !== undefined ? i : found, null);
  return <svg width={width} height={height} aria-hidden="true" className="qa-trends-spark">
    <path d={linePath(values, x, y)} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round"/>
    {mark !== undefined && mark !== null && values[mark] !== null && <circle className="qa-trends-mark" cx={x(mark)} cy={y(values[mark])} r={3.5}/>}
    {last !== null && <circle cx={x(last)} cy={y(values[last])} r={2.5} fill={color}/>}
  </svg>;
}

// A row of statuses over the commits: one cell per commit, runs of the same status drawn as one rectangle.
// colors[code] is a CSS color, or null for nothing.
export function StatusStrip({ statuses, colors, names, points, width = 240, height = 14 }) {
  const count = statuses.length;
  const cell = width / Math.max(count, 1);
  const rects = [];
  let start = 0;
  for (let i = 1; i <= count; i++) {
    if (i === count || statuses[i] !== statuses[start]) {
      const color = colors[statuses[start]];
      if (color) rects.push(<rect key={start} x={start * cell} y={0} width={Math.max((i - start) * cell - (cell > 3 ? 1 : 0), 0.75)} height={height} fill={color} rx={1}/>);
      start = i;
    }
  }
  const [hovered, setHovered] = useState(null);
  const index_at = event => Math.min(count - 1, Math.max(0, Math.floor((event.clientX - event.currentTarget.getBoundingClientRect().left) / cell)));
  return <span className="qa-trends-strip" style={{ width, height }}>
    <svg width={width} height={height} onMouseMove={e => setHovered(index_at(e))} onMouseLeave={() => setHovered(null)}>
      <rect className="qa-trends-strip-track" x={0} y={height / 2 - 0.5} width={width} height={1}/>
      {rects}
      {hovered !== null && <rect className="qa-trends-strip-cursor" x={hovered * cell} y={0} width={Math.max(cell, 1)} height={height}/>}
    </svg>
    {hovered !== null && points?.[hovered] && <span className="qa-trends-strip-tip" style={hovered > count / 2 ? { right: width - hovered * cell + 6 } : { left: (hovered + 1) * cell + 6 }}>
      <code>{points[hovered].label}</code> {names[statuses[hovered]]}
    </span>}
  </span>;
}
