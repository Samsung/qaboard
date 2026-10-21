// A profile of the view, along x or y: the mean of each column or row, per channel, with a band, e.g. ±1 std dev
import { useEffect, useEffectEvent, useRef, useState } from 'react';

import { bandOf, nearest, niceTicks, valueDomain, valueRange } from './analysis';
import { isLight } from './panels';

export const MARGIN = { left: 36, right: 10, top: 8, bottom: 20 };
const rgba = (color, alpha) => {
  if (color.startsWith('#')) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  return color.replace(/rgba?\(([^,]+),([^,]+),([^,)]+).*/, `rgba($1,$2,$3,${alpha})`);
};
const tickLabel = (value, step) => step >= 1 ? String(Math.round(value)) : value.toFixed(1);

// lines: [{ name, color (null: the text's), shown }], one per channel of the profiles. references: [{ value, label }],
// horizontal lines, e.g. the black level
const drawProfiles = (element, series, key, lines, band, x_domain, y_domain, references = []) => {
  const ratio = window.devicePixelRatio || 1;
  const width = element.clientWidth;
  const height = element.clientHeight;
  element.width = Math.round(width * ratio);
  element.height = Math.round(height * ratio);
  const context = element.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const plot_width = width - MARGIN.left - MARGIN.right;
  const plot_height = height - MARGIN.top - MARGIN.bottom;
  if (plot_width <= 0 || plot_height <= 0) return;
  const style = getComputedStyle(element);
  const text_color = style.color;
  const dark = isLight(text_color);
  const grid_color = style.getPropertyValue('--qiv-border').trim() || 'rgba(128, 128, 128, 0.3)';
  const [x0, x1] = x_domain;
  const [y0, y1] = y_domain;
  const X = x => MARGIN.left + (x - x0) / (x1 - x0 || 1) * plot_width;
  const Y = v => MARGIN.top + (1 - (v - y0) / (y1 - y0 || 1)) * plot_height;
  const snap = v => Math.round(v * ratio) / ratio + 0.5 / ratio;

  // the grid, and its values
  context.font = `10.5px ${style.getPropertyValue('--qiv-mono').trim() || 'monospace'}`;
  context.lineWidth = 1;
  context.strokeStyle = grid_color;
  context.fillStyle = rgba(text_color, 0.65);
  const y_ticks = niceTicks(y0, y1, Math.max(2, Math.min(6, Math.floor(plot_height / 26))));
  const y_step = y_ticks.length > 1 ? y_ticks[1] - y_ticks[0] : 1;
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  context.beginPath();
  for (const tick of y_ticks) {
    const y = snap(Y(tick));
    context.moveTo(MARGIN.left, y);
    context.lineTo(width - MARGIN.right, y);
    context.fillText(tickLabel(tick, y_step), MARGIN.left - 5, y);
  }
  // pixels are integers: no ticks between them
  const x_ticks = niceTicks(x0, x1, Math.max(2, Math.floor(plot_width / 90))).filter(Number.isInteger);
  context.textAlign = 'center';
  context.textBaseline = 'top';
  for (const tick of x_ticks) {
    const x = snap(X(tick));
    context.moveTo(x, MARGIN.top);
    context.lineTo(x, MARGIN.top + plot_height);
    context.fillText(String(tick), Math.min(width - MARGIN.right - 8, Math.max(MARGIN.left + 8, x)), MARGIN.top + plot_height + 5);
  }
  context.stroke();
  // the reference values, e.g. the black and white levels
  context.setLineDash([3, 3]);
  context.strokeStyle = rgba(text_color, 0.55);
  context.textAlign = 'left';
  context.textBaseline = 'bottom';
  for (const { value, label } of references) {
    if (value < y0 || value > y1) continue;
    const y = snap(Y(value));
    context.beginPath();
    context.moveTo(MARGIN.left, y);
    context.lineTo(width - MARGIN.right, y);
    context.stroke();
    context.fillText(label, MARGIN.left + 4, y - 2);
  }
  context.setLineDash([]);
  context.strokeStyle = rgba(text_color, 0.35);
  context.beginPath();
  context.moveTo(MARGIN.left, snap(MARGIN.top + plot_height));
  context.lineTo(width - MARGIN.right, snap(MARGIN.top + plot_height));
  context.stroke();

  context.save();
  context.beginPath();
  context.rect(MARGIN.left, MARGIN.top - 2, plot_width, plot_height + 2);
  context.clip();
  const color = c => lines[c].color ?? text_color;
  const neutral = c => !lines[c].color;
  // the band of the first image: how much the values vary across each column or row
  const [first] = series;
  if (band !== 'none' && first) {
    const profile = first[key];
    // light, not to hide the lines: with all the channels, they overlap
    context.globalCompositeOperation = dark ? 'lighter' : 'source-over';
    for (let c = 0; c < lines.length; c++) {
      if (!lines[c].shown || !profile.length) continue;
      context.beginPath();
      for (let j = 0; j < profile.length; j++) context.lineTo(X(profile.x[j]), Y(bandOf(profile, j, c, band)[1]));
      for (let j = profile.length - 1; j >= 0; j--) context.lineTo(X(profile.x[j]), Y(bandOf(profile, j, c, band)[0]));
      context.closePath();
      context.fillStyle = rgba(color(c), neutral(c) ? 0.07 : dark ? 0.16 : 0.1);
      context.fill();
    }
    context.globalCompositeOperation = 'source-over';
  }
  // the means, of the other image dashed
  context.lineJoin = 'round';
  for (const s of series) {
    const profile = s[key];
    const stride = profile.stride ?? 4;
    for (let c = 0; c < lines.length; c++) {
      if (!lines[c].shown || !profile.length || c >= stride) continue;
      context.beginPath();
      for (let j = 0; j < profile.length; j++) context.lineTo(X(profile.x[j]), Y(profile.mean[stride * j + c]));
      context.strokeStyle = color(c);
      context.globalAlpha = neutral(c) ? 0.85 : 1;
      context.lineWidth = neutral(c) ? 1.5 : 1.25;
      context.setLineDash(s.dashed ? [4, 3] : []);
      context.stroke();
    }
  }
  context.restore();
};

// The domain of the positions: from the first to the last, over the pixels' widths
const positionDomain = (series, key) => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    const profile = s[key];
    if (!profile.length) continue;
    lo = Math.min(lo, profile.x[0]);
    hi = Math.max(hi, profile.x[profile.length - 1]);
  }
  if (!(hi >= lo)) return null;
  return hi - lo < 1 ? [lo - 0.5, hi + 0.5] : [lo, hi];
};

// One profile: along x (`columns`) or y (`rows`). series: [{ columns, rows, dashed }], lines: their channels (see
// drawProfiles). The values axis fits the values (scale 'fit') or goes from 0 to `max`.
export const ProfilePlot = ({ title, detail, axis, series, lines, band, scale, max = 255, references, digits = 1, marker, onGuideChange }) => {
  const canvas = useRef(null);
  const key = axis === 'x' ? 'columns' : 'rows';
  const [hover, setHover] = useState(null);
  const x_domain = positionDomain(series, key);
  const shown = lines.map(line => line.shown);
  const y_domain = valueDomain(valueRange(series.map(s => s[key]), shown, band), scale, max);
  const draw = useEffectEvent(() => {
    if (canvas.current && x_domain) drawProfiles(canvas.current, series, key, lines, band, x_domain, y_domain, references);
    else if (canvas.current) canvas.current.getContext('2d')?.clearRect(0, 0, canvas.current.width, canvas.current.height);
  });
  useEffect(() => {
    draw();
  });
  useEffect(() => {
    const element = canvas.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // where a position is, over the canvas
  // (not x_domain[0] in the function: the React Compiler would read it to memoize it, even when there's no domain)
  const [x_start, x_end] = x_domain ?? [0, 1];
  const left = x => `calc(${MARGIN.left}px + (100% - ${MARGIN.left + MARGIN.right}px) * ${(x - x_start) / (x_end - x_start || 1)})`;
  const [first] = series;
  const positionAt = event => {
    const element = canvas.current;
    if (!element || !x_domain || !first?.[key].length) return null;
    const rect = element.getBoundingClientRect();
    const fraction = (event.clientX - rect.left - MARGIN.left) / (rect.width - MARGIN.left - MARGIN.right);
    const x = x_domain[0] + Math.min(1, Math.max(0, fraction)) * (x_domain[1] - x_domain[0]);
    return first[key].x[nearest(first[key], x)];
  };
  const onPointerMove = event => {
    const position = positionAt(event);
    setHover(position);
    onGuideChange(position === null ? null : { axis, value: position });
  };
  const onPointerLeave = () => {
    setHover(null);
    onGuideChange(null);
  };
  // the values at the position hovered, else at the pointer on the images
  const at = hover ?? marker;
  const in_view = at !== null && x_domain && at >= x_domain[0] - 1 && at <= x_domain[1] + 1;
  const valueOf = (s, c) => {
    const profile = s[key];
    const stride = profile.stride ?? 4;
    const j = nearest(profile, at);
    // within a bin of the profile
    const reach = profile.length > 1 ? Math.max(1, (profile.x[profile.length - 1] - profile.x[0]) / (profile.length - 1)) : 1;
    if (j < 0 || c >= stride || Math.abs(profile.x[j] - at) > reach) return '–';
    return profile.mean[stride * j + c].toFixed(digits);
  };
  return <div className="qiv-profile">
    <div className="qiv-profile-title">
      <span>{title}</span>
      <span className="qiv-muted">{detail}</span>
    </div>
    <div className="qiv-profile-plot" onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}>
      <canvas ref={canvas} aria-hidden="true" />
      {x_domain && marker !== null && marker >= x_domain[0] && marker <= x_domain[1] && <div className="qiv-profile-marker" style={{ left: left(marker) }} />}
      {x_domain && hover !== null && <div className="qiv-histogram-cursor qiv-profile-cursor" style={{ left: left(hover) }} />}
    </div>
    <div className="qiv-histogram-readout qiv-mono qiv-profile-readout">
      {in_view && first ? <>
        <span>{axis} {Math.floor(at)}</span>
        {lines.map((line, c) => line.shown && <span key={line.name}>
          <span style={{ color: line.color ?? undefined }}>{line.name}</span> {valueOf(first, c)}{series[1] ? ` / ${valueOf(series[1], c)}` : ''}
        </span>)}
      </> : <span className="qiv-muted">Hover to see the values, and where it is on the images</span>}
    </div>
  </div>;
};

