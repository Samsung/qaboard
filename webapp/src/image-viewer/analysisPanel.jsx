// The analysis panel, under the images: the histogram of the view, the profiles of its rows and columns, or its
// statistics. Users pick the view in its header; the channels shown are the same for all.
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react';

import { ANALYSES, STATS, alongImage, bandOf, formatStat, formatStatDelta, nearest, niceTicks, profilesOf, statsOf, statsTsv, valueDomain, valueRange } from './analysis';
import { pixelDensityRatio } from './comparison';
import { CHANNELS } from './histogram';
import { CHANNEL_COLORS, CHANNEL_TITLES, ChannelButtons, Histogram, LineLegend, isLight, readHistograms } from './panels';
import { Button, Segmented, Select } from './ui';

// What the viewers display, read again after they draw (at most every 250ms), and when `key` changes
const useAfterDraws = (controller, read, key) => {
  const [value, setValue] = useState(null);
  const update = useEffectEvent(() => setValue(read()));
  useEffect(() => {
    let timer = null;
    const stop = controller.onDraw(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        update();
      }, 250);
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [controller]);
  useEffect(() => {
    const timer = setTimeout(update, 0);
    return () => clearTimeout(timer);
  }, [key]);
  return value;
};

const CORS_ERROR = "The image server doesn't allow reading the pixels (CORS)";

export const AnalysisPanel = ({ controller, comparing, names, view, onViewChange, channels, onChannelsChange, range, onRangeChange, onGuideChange }) => <div className="qiv-analysis">
  <div className="qiv-histogram-header">
    <Segmented className="qiv-analysis-views" label="Analysis of the view" options={ANALYSES} value={view} onChange={onViewChange} />
    <span className="qiv-histogram-legend">
      <ChannelButtons channels={channels} onChange={onChannelsChange} hint={view === 'histogram' ? 'The range you drag applies to the channels shown.' : ''} />
      {view !== 'stats' && <LineLegend names={names} comparing={comparing} />}
    </span>
  </div>
  {view === 'histogram' && <Histogram controller={controller} comparing={comparing} names={names} channels={channels} range={range} onRangeChange={onRangeChange} />}
  {view === 'profiles' && <Profiles controller={controller} comparing={comparing} names={names} channels={channels} onGuideChange={onGuideChange} />}
  {view === 'stats' && <Stats controller={controller} comparing={comparing} names={names} channels={channels} />}
</div>;


// --- Profiles ---

// How users like their profiles, for the next viewers of the page
const profile_settings = { source: 'view', band: 'std', scale: 'fit' };
const SOURCES = [
  { value: 'view', label: 'Average of the view' },
  { value: 'pointer', label: 'Row and column under the pointer' },
];
const BANDS = [
  { value: 'std', label: 'Band: ±1 std dev' },
  { value: 'minmax', label: 'Band: min–max' },
  { value: 'none', label: 'No band' },
];
const SCALES = [
  { value: 'fit', label: 'Values: fit' },
  { value: 'full', label: 'Values: 0–255' },
];

// The profiles of what the viewers display: [{ name, dashed, columns, rows }], along the first image's pixels (the
// viewers show the same place). With `line` ({ x, y }, a pixel of the first image), along its row and column only.
// Throws when we can't read the pixels.
const readProfiles = (controller, comparing, line) => {
  const transform = controller.imageTransform('a');
  if (!transform?.scale) return [];
  const ratio = pixelDensityRatio();
  const { origin, scale } = transform;
  // zoomed in, the screen pixels over the same image pixel are one position
  const merge = scale * ratio >= 1;
  const toX = k => ((k + 0.5) / ratio - origin.x) / scale;
  const toY = k => ((k + 0.5) / ratio - origin.y) / scale;
  const series = [['a', false], ...(comparing ? [['b', true]] : [])].map(([name, dashed]) => {
    const canvas = controller.canvas(name);
    if (!canvas?.width || !canvas.height) return null;
    const { width, height } = canvas;
    const context = canvas.getContext('2d');
    if (line) {
      // only the row and the column of the pixel: cheap enough to follow the pointer
      const x = Math.floor((origin.x + (line.x + 0.5) * scale) * ratio);
      const y = Math.floor((origin.y + (line.y + 0.5) * scale) * ratio);
      const empty = { n: 0, count: [] };
      const columns = y >= 0 && y < height ? profilesOf(context.getImageData(0, y, width, 1).data, width, 1, { line: { x: -1, y: 0 } }).columns : empty;
      const rows = x >= 0 && x < width ? profilesOf(context.getImageData(x, 0, 1, height).data, 1, height, { line: { x: 0, y: -1 } }).rows : empty;
      return { name, dashed, columns: alongImage(columns, toX, merge), rows: alongImage(rows, toY, merge) };
    }
    const data = context.getImageData(0, 0, width, height).data;
    const { columns, rows } = profilesOf(data, width, height, { step: width * height > 1.5e6 ? 2 : 1 });
    return { name, dashed, columns: alongImage(columns, toX, merge), rows: alongImage(rows, toY, merge) };
  });
  return series.filter(Boolean);
};

const MARGIN = { left: 36, right: 10, top: 8, bottom: 20 };
const rgba = (color, alpha) => {
  if (color.startsWith('#')) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  return color.replace(/rgba?\(([^,]+),([^,]+),([^,)]+).*/, `rgba($1,$2,$3,${alpha})`);
};
const tickLabel = (value, step) => step >= 1 ? String(Math.round(value)) : value.toFixed(1);

const drawProfiles = (element, series, key, channels, band, x_domain, y_domain) => {
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
  context.strokeStyle = rgba(text_color, 0.35);
  context.beginPath();
  context.moveTo(MARGIN.left, snap(MARGIN.top + plot_height));
  context.lineTo(width - MARGIN.right, snap(MARGIN.top + plot_height));
  context.stroke();

  context.save();
  context.beginPath();
  context.rect(MARGIN.left, MARGIN.top - 2, plot_width, plot_height + 2);
  context.clip();
  const color = c => c === 3 ? text_color : CHANNEL_COLORS[c];
  // the band of the first image: how much the values vary across each column or row
  const [first] = series;
  if (band !== 'none' && first) {
    const profile = first[key];
    // light, not to hide the lines: with all the channels, they overlap
    context.globalCompositeOperation = dark ? 'lighter' : 'source-over';
    for (let c = 0; c < 4; c++) {
      if (!channels[c] || !profile.length) continue;
      context.beginPath();
      for (let j = 0; j < profile.length; j++) context.lineTo(X(profile.x[j]), Y(bandOf(profile, j, c, band)[1]));
      for (let j = profile.length - 1; j >= 0; j--) context.lineTo(X(profile.x[j]), Y(bandOf(profile, j, c, band)[0]));
      context.closePath();
      context.fillStyle = rgba(c === 3 ? text_color : CHANNEL_COLORS[c], c === 3 ? 0.07 : dark ? 0.16 : 0.1);
      context.fill();
    }
    context.globalCompositeOperation = 'source-over';
  }
  // the means, of the other image dashed
  context.lineJoin = 'round';
  for (const s of series) {
    const profile = s[key];
    for (let c = 0; c < 4; c++) {
      if (!channels[c] || !profile.length) continue;
      context.beginPath();
      for (let j = 0; j < profile.length; j++) context.lineTo(X(profile.x[j]), Y(profile.mean[4 * j + c]));
      context.strokeStyle = color(c);
      context.globalAlpha = c === 3 ? 0.85 : 1;
      context.lineWidth = c === 3 ? 1.5 : 1.25;
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

// One profile: along x (`columns`) or y (`rows`)
const ProfilePlot = ({ title, detail, axis, series, channels, band, scale, marker, onGuideChange }) => {
  const canvas = useRef(null);
  const key = axis === 'x' ? 'columns' : 'rows';
  const [hover, setHover] = useState(null);
  const x_domain = positionDomain(series, key);
  const y_domain = valueDomain(valueRange(series.map(s => s[key]), channels, band), scale);
  const draw = useEffectEvent(() => {
    if (canvas.current && x_domain) drawProfiles(canvas.current, series, key, channels, band, x_domain, y_domain);
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
  const shown = at !== null && x_domain && at >= x_domain[0] - 1 && at <= x_domain[1] + 1;
  const valueOf = (s, c) => {
    const profile = s[key];
    const j = nearest(profile, at);
    if (j < 0 || Math.abs(profile.x[j] - at) > 1) return '–';
    return profile.mean[4 * j + c].toFixed(1);
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
      {shown && first ? <>
        <span>{axis} {Math.floor(at)}</span>
        {CHANNELS.map((name, c) => channels[c] && <span key={name}>
          <span style={{ color: c === 3 ? undefined : CHANNEL_COLORS[c] }}>{name}</span> {valueOf(first, c)}{series[1] ? ` / ${valueOf(series[1], c)}` : ''}
        </span>)}
      </> : <span className="qiv-muted">Hover to see the values, and where it is on the images</span>}
    </div>
  </div>;
};

const Profiles = ({ controller, comparing, names, channels, onGuideChange }) => {
  const [settings, setSettings] = useState(() => ({ ...profile_settings }));
  const change = patch => {
    Object.assign(profile_settings, patch);
    setSettings(previous => ({ ...previous, ...patch }));
  };
  const { source, scale } = settings;
  const at_pointer = source === 'pointer';
  // a single row or column doesn't vary
  const band = at_pointer ? 'none' : settings.band;

  // The pixel under the pointer, on any of the images; the row and column profiled stay when it leaves them
  const pointer = useSyncExternalStore(controller.subscribePointer, controller.getPointer);
  const pixel = pointer ? controller.imagePixel('a', pointer.point) : null;
  const [pointed, setLine] = useState(null);
  useEffect(() => controller.subscribePointer(() => {
    const current = controller.getPointer();
    const next = current ? controller.imagePixel('a', current.point) : null;
    if (next) setLine(previous => previous?.x === next.x && previous?.y === next.y ? previous : next);
  }), [controller]);

  const line_key = at_pointer && pointed ? `${pointed.x},${pointed.y}` : '';
  const result = useAfterDraws(controller, () => {
    // before users point at a pixel: the center of the view
    const region = !pointed && at_pointer ? controller.visibleRegion() : null;
    const line = pointed ?? (region && { x: Math.floor(region.x + region.w / 2), y: Math.floor(region.y + region.h / 2) });
    if (at_pointer && !line) return { series: [] };
    try {
      return { series: readProfiles(controller, comparing, at_pointer ? line : null), line };
    } catch {
      return { error: CORS_ERROR };
    }
  }, `${comparing}|${source}|${line_key}`);
  const series = result?.series ?? [];
  const line = result?.line ?? null;
  useEffect(() => () => onGuideChange(null), [onGuideChange]);

  const titles = at_pointer
    ? { x: line ? `Row ${line.y}` : 'Row under the pointer', y: line ? `Column ${line.x}` : 'Column under the pointer' }
    : { x: 'Columns', y: 'Rows' };
  const details = at_pointer
    ? { x: 'values along the row, by column', y: 'values along the column, by row' }
    : { x: `average of each column, ${band === 'minmax' ? 'with its min and max' : band === 'std' ? '±1 std dev' : 'by x'}`, y: `average of each row, ${band === 'minmax' ? 'with its min and max' : band === 'std' ? '±1 std dev' : 'by y'}` };
  return <div className="qiv-profiles">
    <div className="qiv-profiles-settings">
      <Select value={source} options={SOURCES} onChange={value => change({ source: value })} label="Profiles of" title="The average of each column and row of the view, or the values along the row and column under the pointer" />
      {!at_pointer && <Select value={settings.band} options={BANDS} onChange={value => change({ band: value })} label="Band" title="Around the average: how much the values vary across each column or row" />}
      <Select value={scale} options={SCALES} onChange={value => change({ scale: value })} label="Values axis" title="Fit the values axis to the values, or show all the 8-bit values" />
      {at_pointer && !pointed && <span className="qiv-muted">The center of the view: move the pointer over the images</span>}
    </div>
    {result?.error ? <div className="qiv-message qiv-histogram-message qiv-profiles-message">{result.error}</div> : <div className="qiv-profiles-plots">
      <ProfilePlot title={titles.x} detail={details.x} axis="x" series={series} channels={channels} band={band} scale={scale} marker={pixel ? pixel.x + 0.5 : null} onGuideChange={onGuideChange} />
      <ProfilePlot title={titles.y} detail={details.y} axis="y" series={series} channels={channels} band={band} scale={scale} marker={pixel ? pixel.y + 0.5 : null} onGuideChange={onGuideChange} />
    </div>}
    <div className="qiv-histogram-footer">
      <span className="qiv-muted">{at_pointer ? 'The row and column stay when the pointer leaves the images' : 'Of the view: zoom in to profile a part of the image'}</span>
      <span className="qiv-muted qiv-analysis-note">displayed values, 8-bit · x and y: pixels of {comparing ? names.a : 'the image'}</span>
    </div>
  </div>;
};


// --- Statistics ---

const Stats = ({ controller, comparing, names, channels }) => {
  const result = useAfterDraws(controller, () => {
    const series = readHistograms(controller, comparing, null);
    if (!series) return { error: CORS_ERROR };
    return { series, region: controller.visibleRegion() };
  }, String(comparing));
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  if (result?.error) return <div className="qiv-message qiv-histogram-message qiv-profiles-message">{result.error}</div>;
  const [first, second] = result?.series ?? [];
  const stats = (s, c) => s ? statsOf(s.bins[c], s.total) : null;
  const shown = CHANNELS.map((name, c) => ({ name, c })).filter(({ c }) => channels[c]);
  const rows = shown.flatMap(({ name, c }) => [
    { channel: name, image: names.a, stats: stats(first, c) },
    ...(comparing ? [{ channel: name, image: names.b, stats: stats(second, c) }] : []),
  ]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(statsTsv(rows));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const region = result?.region;
  const cells = (values, delta = null) => STATS.map(stat => <td key={stat.key} className="qiv-mono">
    {delta ? formatStatDelta(stat, delta[0]?.[stat.key], delta[1]?.[stat.key]) : formatStat(stat, values?.[stat.key])}
  </td>);
  return <div className="qiv-stats">
    <div className="qiv-stats-scroll">
      <table className="qiv-stats-table">
        <thead>
          <tr>
            <th className="qiv-stats-channel" scope="col">Channel</th>
            {comparing && <th scope="col" className="qiv-stats-image">Image</th>}
            {STATS.map(stat => <th key={stat.key} scope="col" title={stat.title}>{stat.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {shown.map(({ name, c }) => {
            const a = stats(first, c);
            const b = stats(second, c);
            const channel = <th scope="row" rowSpan={comparing ? 3 : 1} className="qiv-stats-channel" title={CHANNEL_TITLES[c]}>
              <span className="qiv-histogram-channel-name" style={{ color: c === 3 ? undefined : CHANNEL_COLORS[c] }}>{name}</span>
            </th>;
            if (!comparing) return <tr key={name} className="qiv-stats-group">{channel}{cells(a)}</tr>;
            return [
              <tr key={`${name}-a`} className="qiv-stats-group">{channel}<td className="qiv-stats-image">{names.a}</td>{cells(a)}</tr>,
              <tr key={`${name}-b`}><td className="qiv-stats-image">{names.b}</td>{cells(b)}</tr>,
              <tr key={`${name}-delta`} className="qiv-stats-delta"><td className="qiv-stats-image" title={`${names.a} − ${names.b}`}>Δ</td>{cells(null, [a, b])}</tr>,
            ];
          })}
        </tbody>
      </table>
    </div>
    <div className="qiv-histogram-footer">
      <span className="qiv-muted">
        {region ? <>Of the view: <span className="qiv-mono">x {Math.floor(region.x)}–{Math.ceil(region.x + region.w) - 1}, y {Math.floor(region.y)}–{Math.ceil(region.y + region.h) - 1}</span> ({Math.round(region.w)}×{Math.round(region.h)} pixels of {comparing ? names.a : 'the image'}). Zoom in to measure a part of the image.</> : 'Of the view'}
      </span>
      <span className="qiv-stats-actions">
        <span className="qiv-muted qiv-analysis-note">displayed values, 8-bit</span>
        <Button icon={copied ? 'tick' : 'clipboard'} text={copied ? 'Copied' : 'Copy'} className="qiv-small" title="Copy the table, to paste in a spreadsheet (tab-separated values)" onClick={copy} disabled={!first} />
      </span>
    </div>
  </div>;
};
