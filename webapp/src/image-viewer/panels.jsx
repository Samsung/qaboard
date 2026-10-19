// The viewer's panels: the values under the pointer, histograms, adjustments, regions of interest, legends.
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react';

import { ADJUSTMENT_SLIDERS, CHANNELS, DEFAULT_ADJUSTMENTS, FALSE_COLORS, changedAdjustments, normalizeAdjustments } from './adjustments';
import { cssGradient } from './colormaps';
import { DIFF_METHODS, diffAt, diffLegend, formatDiffValue, normalizeDiff } from './metrics';
import { CHANNELS as HISTOGRAM_CHANNELS, LABELLED_TICKS, TICKS, dragRange, formatShare, histogram, histogramMax, rangeDrag, toggleChannel, valueAt } from './histogram';
import { formatNumber, formatSigned } from './pixels';
import { clipRegion } from './regions';
import { imageKey, thumbnailUrl } from './sources';
import { Button, MenuDivider, MenuItem, Popover, Segmented, Select, Spinner } from './ui';


// --- Values under the pointer ---

// Users mix them up: we say which is which
export const IMAGE_VALUES = "The image's own values: what the file contains (raw, 16-bit, float...), read by the server";
export const DISPLAY_VALUES = 'The displayed values: the 8-bit color on your screen, after the image server converted the image for display';

// The image's own value of the pixel, from the tiles. null without getPixels.
const useImageValue = (tiles, image, size, pixel) => {
  // The tiles change outside React: the compiler would keep the first value it read
  'use no memo';
  // the values arrive by tiles
  useSyncExternalStore(tiles.subscribe, tiles.getVersion);
  const key = imageKey(image);
  const x = pixel?.x;
  const y = pixel?.y;
  useEffect(() => {
    if (key && x !== undefined) tiles.requestLatest(image, size, x, y);
    // oxlint-disable-next-line react/exhaustive-deps
  }, [tiles, key, size?.width, size?.height, x, y]);
  if (!tiles.getPixels || !image || x === undefined) return null;
  const value = tiles.get(image, x, y);
  return { value, mode: tiles.mode(image), error: value === null ? tiles.error(image) : null };
};

const Values = ({ values, base, signed = false }) => <span className="qiv-values">
  {values.map(v => v === null ? '–' : signed ? formatSigned(v) : formatNumber(v, base)).join(' ')}
</span>;

export const Chip = ({ children, title }) => <span className="qiv-chip" title={title}>{children}</span>;

const same_values = (display, value) => !!value && !!display && (
  value.length === 1 ? display[0] === value[0] && display[1] === value[0] && display[2] === value[0]
    : value.length >= 3 && [0, 1, 2].every(c => display[c] === value[c]));

// 8-bit images, that screens show as they are: their displayed values differ only when zoomed out (blended with their
// neighbors), the swatch shows them
const SCREEN_MODES = ['L', 'LA', 'RGB', 'RGBA', 'RGBX'];

const ImageValues = ({ label, pixel, display, image, base, intent }) => {
  const screen = !!image?.value && SCREEN_MODES.includes(image.mode);
  return <span className="qiv-readout-image">
    <span className={`qiv-readout-label qiv-${intent}`}>{label}</span>{' '}
    {display && <span className="qiv-swatch" style={{ background: `rgb(${display[0]},${display[1]},${display[2]})` }} title="The displayed color" />}
    {screen && <span title={`${IMAGE_VALUES}. Here: ${image.mode}, 8-bit, as displayed once zoomed in`}><Values values={image.value} base={base} />{' '}</span>}
    {image && !screen && <span title={`${IMAGE_VALUES}${image.mode ? `. Here: ${image.mode}` : ''}`}>
      <Chip>image</Chip>{' '}
      {image.value ? <Values values={image.value} base={base} />
        : image.value === undefined ? <span className="qiv-muted">…</span>
        : <span className="qiv-warning-text" title={image.error ?? "Can't read the image's values"}>unavailable</span>}
      {image.mode && <span className="qiv-muted"> {image.mode}</span>}{' '}
    </span>}
    {display && !screen && !same_values(display, image?.value) && <span title={DISPLAY_VALUES}>
      <Chip>display</Chip> <Values values={display.slice(0, 3)} base={base} />{' '}
    </span>}
    {!display && pixel === null && <span className="qiv-muted">outside</span>}
  </span>;
};

// The pixel under the pointer, in the order the images show (order: ['a', 'b'] or ['b', 'a']), named by `names`, e.g.
// A and B during a blind test (neutral: no colors that tell new from reference).
// unavailable: why the image's own values aren't shown, if the app says so
export const Readout = ({ controller, tiles, images, comparing, names, order, neutral, diff, base, onToggleBase, sizes, unavailable }) => {
  // It reads the viewers (what's under the pointer, the colors drawn) as it renders: nothing to memoize
  'use no memo';
  const pointer = useSyncExternalStore(controller.subscribePointer, controller.getPointer);
  // the displayed values change as tiles load
  const [, redraw] = useState(0);
  useEffect(() => controller.onDraw(() => redraw(n => n + 1)), [controller]);
  // The values stay once the pointer leaves the image, e.g. to switch them to hexadecimal
  const [last, setLast] = useState(null);
  const hovering = pointer && !pointer.remote ? pointer.point : null;
  if (hovering && hovering !== last) setLast(hovering);
  const point = hovering ?? last;
  const pixel = {
    a: point ? controller.imagePixel('a', point) : null,
    b: point && comparing ? controller.imagePixel('b', point) : null,
  };
  const display = {
    a: pixel.a && controller.displayPixel('a', point),
    b: pixel.b && controller.displayPixel('b', point),
  };
  const value = {
    a: useImageValue(tiles, images.a, sizes.a, pixel.a),
    b: useImageValue(tiles, comparing ? images.b : null, sizes.b, pixel.b),
  };
  const shown = comparing ? order : ['a'];
  const [first, second] = order;
  const intent = name => neutral ? 'neutral' : name === 'a' ? 'primary' : 'warning';

  if (!point) {
    const size = s => s?.width ? `${s.width}×${s.height}` : '…';
    return <div className="qiv-readout qiv-muted">
      <span>{shown.map(name => comparing ? `${names[name]} ${size(sizes[name])}` : size(sizes[name])).join(' · ')}</span>
      <span className="qiv-readout-hint">Hover a pixel for its values · scroll to zoom · drag to pan{unavailable && <> · <span className="qiv-warning-text">{unavailable}</span></>}</span>
    </div>;
  }
  const { method } = normalizeDiff(diff);
  // the second subtracted from the first, as shown
  const delta = display[first] && display[second] ? diffAt(diff, display[first], display[second]) : null;
  // the difference of the images' values, for images of the same size
  const same_size = sizes.a?.width === sizes.b?.width && sizes.a?.height === sizes.b?.height;
  const value_first = value[first]?.value;
  const value_second = value[second]?.value;
  const image_delta = same_size && value_first && value_second && value_first.length === value_second.length
    ? value_first.map((v, i) => v === null || value_second[i] === null ? null : v - value_second[i]) : null;
  const coordinates = pixel[first] ?? pixel[second];
  const moved = pixel[first] && pixel[second] && (pixel[second].x !== pixel[first].x || pixel[second].y !== pixel[first].y);
  return <button
    type="button"
    className={`qiv-readout ${hovering ? '' : 'qiv-stale'}`}
    onClick={onToggleBase}
    title={`The pixel under the pointer. Click to show the values in ${base === 10 ? 'hexadecimal' : 'decimal'}`}
  >
    {coordinates && <span className="qiv-coordinates">x {coordinates.x} y {coordinates.y} </span>}
    {moved && <span className="qiv-coordinates qiv-muted">({names[second]} x {pixel[second].x} y {pixel[second].y}) </span>}
    {shown.map(name => <ImageValues key={name} label={names[name]} intent={intent(name)} pixel={pixel[name]} display={display[name]} image={value[name]} base={base} />)}
    {delta && <span className="qiv-readout-image" title={`${names[first]} − ${names[second]}`}>
      <span className="qiv-readout-label">Δ</span>{' '}
      {image_delta
        ? <span title={IMAGE_VALUES}><Chip>image</Chip> <Values values={image_delta} signed /></span>
        : <span title={DISPLAY_VALUES}><Chip>display</Chip> <Values values={delta.delta} signed /></span>}
      {formatDiffValue(method, delta.value) && <span className="qiv-diff-value" title={`${DIFF_METHODS[method].title}, on the displayed colors`}>
        {' '}{method === 'perceptual' ? 'perceptual ' : ''}{formatDiffValue(method, delta.value)}
      </span>}
    </span>}
  </button>;
};


// Which values are written on the pixels
export const ValuesPanel = ({ source, available, unavailable, onChange }) => {
  const options = [
    { value: 'image', label: 'Image values', description: `${IMAGE_VALUES}.`, disabled: !available },
    { value: 'display', label: 'Displayed values', description: `${DISPLAY_VALUES}.` },
    { value: 'off', label: 'Off' },
  ];
  return <div className="qiv-panel qiv-values-panel" role="radiogroup" aria-label="Values written on the pixels">
    <div className="qiv-panel-title"><span>Values written on the pixels</span></div>
    {options.map(option => <label key={option.value} className={`qiv-option ${option.disabled ? 'qiv-disabled' : ''}`}>
      <input type="radio" name="qiv-values" value={option.value} checked={source === option.value} disabled={option.disabled} onChange={() => onChange(option.value)} />
      <span>
        <strong>{option.label}</strong>
        {option.description && <span className="qiv-option-description">{option.description}</span>}
        {option.disabled && <span className="qiv-option-description">{unavailable ?? 'Not available for these images.'}</span>}
      </span>
    </label>)}
    <div className="qiv-hint">They show once you zoom in enough. The line above the images shows both for the pixel under the pointer. <kbd>p</kbd> shows or hides them.</div>
  </div>;
};

// What the values on the pixels are, when they show
export const ValuesBadge = ({ drawn }) => drawn && <div className="qiv-values-badge" title={drawn.source === 'image' ? IMAGE_VALUES : DISPLAY_VALUES}>
  {drawn.source === 'image' ? <>Values: image{drawn.mode ? ` (${drawn.mode})` : ''}</> : <>Values: displayed, 8-bit</>}
  {drawn.loading && <Spinner size={10} label="Loading the values" />}
</div>;


// --- Histograms ---

const CHANNEL_COLORS = ['#e5484d', '#30a46c', '#3e63dd', 'currentColor'];
const CHANNEL_TITLES = ['Red', 'Green', 'Blue', 'Luma (brightness)'];
// The fills blend like colored light on dark themes (red and green make yellow, all make white), like inks on light ones
const LIGHT_FILLS = [[255, 45, 45], [40, 215, 70], [45, 95, 255]];
const INK_FILLS = [[255, 150, 150], [150, 230, 160], [160, 180, 255]];
const PAD_TOP = 6;

// The histograms of what the viewers display, or null when we can't read their pixels
const readHistograms = (controller, comparing, highlight) => {
  try {
    return [['a', false], ...(comparing ? [['b', true]] : [])]
      .map(([name, dashed]) => ({ ...histogram(controller.canvas(name) ?? { width: 0, height: 0 }, highlight), name, dashed }));
  } catch {
    return null;
  }
};

const fill_canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
const isLight = color => {
  const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).map(Number);
  return 0.299 * r + 0.587 * g + 0.114 * b > 128;
};

// A channel's curve, through the middle of the bins, from the left to the right: closed, it's the area under it
const trace = (context, bins, total, max, width, height, closed) => {
  const y = i => height - Math.min(1, bins[i] / (total || 1) / max) * (height - PAD_TOP);
  context.beginPath();
  context.moveTo(0, y(0));
  for (let i = 0; i < 256; i++) context.lineTo((i + 0.5) / 256 * width, y(i));
  context.lineTo(width, y(255));
  if (!closed) return;
  context.lineTo(width, height);
  context.lineTo(0, height);
  context.closePath();
};

const drawHistograms = (element, series, channels) => {
  const ratio = window.devicePixelRatio || 1;
  const width = element.clientWidth;
  const height = element.clientHeight;
  element.width = Math.round(width * ratio);
  element.height = Math.round(height * ratio);
  const context = element.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const style = getComputedStyle(element);
  const text_color = style.color;
  // the text is light on dark themes
  const dark = isLight(text_color);

  // the quarters
  context.strokeStyle = style.getPropertyValue('--qiv-border') || 'rgba(128, 128, 128, 0.3)';
  context.lineWidth = 1;
  context.beginPath();
  for (const value of [64, 128, 192]) {
    const x = Math.round(value / 256 * width * ratio) / ratio + 0.5 / ratio;
    context.moveTo(x, 0);
    context.lineTo(x, height);
  }
  context.stroke();

  const max = histogramMax(series, channels);
  if (!max) return;
  const [first] = series;
  const rgb = [0, 1, 2].filter(c => channels[c]);
  if (rgb.length > 0) {
    // the colors blend where the channels overlap, then fade towards the bottom
    fill_canvas.width = element.width;
    fill_canvas.height = element.height;
    const fill = fill_canvas.getContext('2d');
    fill.setTransform(ratio, 0, 0, ratio, 0, 0);
    const fade = fill.createLinearGradient(0, PAD_TOP, 0, height);
    if (dark) {
      fill.globalCompositeOperation = 'lighter';
      for (const c of rgb) {
        fill.fillStyle = `rgb(${LIGHT_FILLS[c].join()})`;
        trace(fill, first.bins[c], first.total, max, width, height, true);
        fill.fill();
      }
      fade.addColorStop(0, 'rgba(0, 0, 0, 0.9)');
      fade.addColorStop(1, 'rgba(0, 0, 0, 0.45)');
      fill.globalCompositeOperation = 'destination-in';
    } else {
      fill.fillStyle = '#fff';
      fill.fillRect(0, 0, width, height);
      fill.globalCompositeOperation = 'multiply';
      for (const c of rgb) {
        fill.fillStyle = `rgb(${INK_FILLS[c].join()})`;
        trace(fill, first.bins[c], first.total, max, width, height, true);
        fill.fill();
      }
      fade.addColorStop(0, 'rgba(255, 255, 255, 0)');
      fade.addColorStop(1, 'rgba(255, 255, 255, 0.5)');
      fill.globalCompositeOperation = 'source-over';
    }
    fill.fillStyle = fade;
    fill.fillRect(0, 0, width, height);
    context.globalCompositeOperation = dark ? 'source-over' : 'multiply';
    context.drawImage(fill_canvas, 0, 0, width, height);
    context.globalCompositeOperation = 'source-over';
  } else if (channels[3]) {
    const fade = context.createLinearGradient(0, PAD_TOP, 0, height);
    fade.addColorStop(0, text_color.replace(/rgba?\(([^,]+),([^,]+),([^,)]+).*/, 'rgba($1,$2,$3,0.35)'));
    fade.addColorStop(1, text_color.replace(/rgba?\(([^,]+),([^,]+),([^,)]+).*/, 'rgba($1,$2,$3,0.08)'));
    context.fillStyle = fade;
    trace(context, first.bins[3], first.total, max, width, height, true);
    context.fill();
  }

  // the outlines, of the reference dashed
  context.lineJoin = 'round';
  for (const s of series) {
    s.bins.forEach((bins, c) => {
      if (!channels[c]) return;
      trace(context, bins, s.total, max, width, height, false);
      context.strokeStyle = c === 3 ? text_color : CHANNEL_COLORS[c];
      context.globalAlpha = c === 3 ? 0.85 : 1;
      context.lineWidth = c === 3 ? 1.5 : 1.25;
      context.setLineDash(s.dashed ? [4, 3] : []);
      context.stroke();
    });
  }
  context.globalAlpha = 1;
  context.setLineDash([]);
};

const ChannelNames = ({ channels }) => HISTOGRAM_CHANNELS.map((name, c) => channels[c] && <span key={name} className="qiv-histogram-channel-name" style={{ color: CHANNEL_COLORS[c] }}>{name}</span>);

// What the viewers display, by value, per channel. Users drag on it to highlight a range of values on the images.
// channels: those shown, [r, g, b, y]. range: { lo, hi } or null. The highlighted pixels have the channels shown in the range.
export const Histogram = ({ controller, comparing, names, channels, onChannelsChange, range, onRangeChange }) => {
  const canvas = useRef(null);
  const plot = useRef(null);
  const [error, setError] = useState(null);
  // [{ name, bins, total, selected }]
  const [stats, setStats] = useState(null);
  const [hover, setHover] = useState(null);
  const [plot_width, setPlotWidth] = useState(0);
  const timer = useRef(null);
  const range_timer = useRef(null);
  const drag = useRef(null);

  const draw = useEffectEvent(() => {
    const element = canvas.current;
    if (!element) return;
    const series = readHistograms(controller, comparing, range ? { ...range, channels } : null);
    setError(series ? null : "The image server doesn't allow reading the pixels (CORS)");
    if (!series) return;
    setStats(series.map(({ name, bins, total, selected }) => ({ name, bins, total, selected })));
    drawHistograms(element, series, channels);
  });
  useEffect(() => controller.onDraw(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      draw();
    }, 250);
  }), [controller]);
  // again with other channels, and to count the pixels highlighted, at most every 100ms while users drag
  const channels_key = channels.join();
  const range_key = range ? `${range.lo}-${range.hi}` : '';
  useEffect(() => {
    if (range_timer.current) return;
    range_timer.current = setTimeout(() => {
      range_timer.current = null;
      draw();
    }, 0);
  }, [comparing, channels_key]);
  useEffect(() => {
    if (range_timer.current) return;
    range_timer.current = setTimeout(() => {
      range_timer.current = null;
      draw();
    }, 100);
  }, [range_key]);
  useEffect(() => {
    const element = plot.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setPlotWidth(element.clientWidth);
      draw();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      clearTimeout(timer.current);
      clearTimeout(range_timer.current);
      timer.current = range_timer.current = null;
    };
  }, []);

  const valueOf = event => {
    const rect = plot.current.getBoundingClientRect();
    return { value: valueAt((event.clientX - rect.left) / rect.width), slack: Math.max(1, Math.round(256 * 5 / rect.width)) };
  };
  const CURSORS = { new: 'crosshair', move: 'grab', lo: 'ew-resize', hi: 'ew-resize' };
  const onPointerDown = event => {
    if (event.button !== 0) return;
    const { value, slack } = valueOf(event);
    const kind = rangeDrag(range, value, slack);
    drag.current = { kind, start: { range, value }, x: event.clientX, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.style.cursor = kind === 'move' ? 'grabbing' : CURSORS[kind];
  };
  const onPointerMove = event => {
    const { value, slack } = valueOf(event);
    setHover(value);
    const current = drag.current;
    if (!current) {
      event.currentTarget.style.cursor = CURSORS[rangeDrag(range, value, slack)];
      return;
    }
    if (!current.moved && Math.abs(event.clientX - current.x) < 3) return;
    current.moved = true;
    onRangeChange(dragRange(current.kind, current.start, value));
  };
  const onPointerUp = () => {
    const current = drag.current;
    drag.current = null;
    // a click clears the range
    if (current && !current.moved && (current.kind === 'new' || current.kind === 'move')) onRangeChange(null);
  };
  const onKeyDown = event => {
    if (event.key === 'Escape' && range) {
      event.preventDefault();
      onRangeChange(null);
      return;
    }
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!step || !range) return;
    event.preventDefault();
    event.stopPropagation();
    const shift = step * (event.shiftKey ? 16 : 1);
    onRangeChange(dragRange('move', { range, value: 0 }, shift));
  };

  const [first, second] = stats ?? [];
  const share = (s, c, value) => formatShare(s.bins[c][value], s.total);
  const percent = x => `${100 * x / 256}%`;
  const shown = channels.filter(Boolean).length;
  // the ticks' labels the range's hide
  const hidden = value => !!range && !!plot_width && [range.lo, range.hi + 1].some(edge => Math.abs(edge - value) / 256 * plot_width < 30);
  return <div className="qiv-histogram">
    <div className="qiv-histogram-header">
      <span>Histogram of the view</span>
      <span className="qiv-histogram-legend">
        <span className="qiv-histogram-channels">
          {HISTOGRAM_CHANNELS.map((name, c) => <button
            key={name}
            type="button"
            className={`qiv-histogram-channel ${channels[c] ? '' : 'qiv-off'}`}
            style={{ '--qiv-channel': CHANNEL_COLORS[c] }}
            aria-pressed={channels[c]}
            title={`${CHANNEL_TITLES[c]}: click to show it alone${channels[c] && shown === 1 ? ' (now: click to show all)' : ''}, shift+click to show or hide it. The range you drag applies to the channels shown.`}
            onClick={event => onChannelsChange(toggleChannel(channels, c, event.shiftKey))}
          >
            <i className="qiv-histogram-swatch" />{name}
          </button>)}
        </span>
        <span className="qiv-muted" title={`${names.a}: solid lines`}><svg width="16" height="8" aria-hidden="true"><path d="M0 4H16" stroke="currentColor" strokeWidth="1.5" /></svg> {names.a}</span>
        {comparing && <span className="qiv-muted" title={`${names.b}: dashed lines`}><svg width="16" height="8" aria-hidden="true"><path d="M0 4H16" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" /></svg> {names.b}</span>}
      </span>
    </div>
    <div
      ref={plot}
      className="qiv-histogram-plot"
      role="slider"
      tabIndex={0}
      aria-label="Histograms of the displayed images. Drag to highlight a range of values on the images: the arrows move it, Escape clears it"
      aria-valuemin={0}
      aria-valuemax={255}
      aria-valuenow={range?.lo ?? 0}
      aria-valuetext={range ? `${range.lo} to ${range.hi}` : 'no range'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { drag.current = null; }}
      onPointerLeave={() => setHover(null)}
      onDoubleClick={() => onRangeChange(null)}
      onKeyDown={onKeyDown}
    >
      <canvas ref={canvas} aria-hidden="true" />
      {range && <div className="qiv-histogram-range" style={{ left: percent(range.lo), width: percent(range.hi - range.lo + 1) }} />}
      {hover !== null && <div className="qiv-histogram-cursor" style={{ left: percent(hover + 0.5) }} />}
      {error && <div className="qiv-message qiv-histogram-message">{error}</div>}
    </div>
    <div className="qiv-histogram-axis qiv-muted" aria-hidden="true">
      {TICKS.map(value => <span
        key={value}
        className={`qiv-histogram-tick ${LABELLED_TICKS.includes(value) ? 'qiv-labelled' : ''} ${value === 0 ? 'qiv-first' : value === 255 ? 'qiv-last' : ''} ${hidden(value === 255 ? 256 : value) ? 'qiv-hidden' : ''}`}
        style={{ left: percent(value === 255 ? 256 : value) }}
      >
        {LABELLED_TICKS.includes(value) ? value : null}
      </span>)}
      {range && [range.lo, range.hi].filter((value, i) => i === 0 || value !== range.lo).map((value, i) => <span
        key={i}
        className={`qiv-histogram-tick qiv-labelled qiv-histogram-range-tick ${i ? 'qiv-hi' : 'qiv-lo'}`}
        style={{ left: percent(i ? value + 1 : value) }}
      >
        {value}
      </span>)}
    </div>
    <div className="qiv-histogram-footer">
      {range ? <span className="qiv-histogram-summary">
        <span>Highlighted: <ChannelNames channels={channels} /> {shown > 1 ? 'all ' : ''}in <span className="qiv-mono">{range.lo}–{range.hi}</span></span>
        {first && <span className="qiv-muted">{formatShare(first.selected, first.total)}{comparing ? ` of ${names.a}` : ' of the view'}</span>}
        {second && <span className="qiv-muted">{formatShare(second.selected, second.total)} of {names.b}</span>}
        <Button icon="cross" title="Stop highlighting (Esc, or click the histogram)" className="qiv-small" onClick={() => onRangeChange(null)} />
      </span> : <span className="qiv-muted">Drag to highlight a range of values on the images</span>}
      <span className="qiv-histogram-readout qiv-mono">
        {hover !== null && first ? <>
          <span>{hover}</span>
          {HISTOGRAM_CHANNELS.map((name, c) => channels[c] && <span key={name}>
            <span style={{ color: CHANNEL_COLORS[c] }}>{name}</span> {share(first, c, hover)}{second ? ` / ${share(second, c, hover)}` : ''}
          </span>)}
        </> : <span className="qiv-muted">displayed values, 8-bit</span>}
      </span>
    </div>
  </div>;
};


// --- Difference ---

export const DiffSettings = ({ diff, onChange }) => {
  const normalized = normalizeDiff(diff);
  const method = DIFF_METHODS[normalized.method];
  return <span className="qiv-group">
    <Select
      label="How to compute the difference"
      title={method.description}
      value={normalized.method}
      options={Object.entries(DIFF_METHODS).map(([value, m]) => ({ value, label: m.label }))}
      onChange={value => onChange(normalizeDiff({ method: value }))}
    />
    {method.setting && <Select
      label={method.setting === 'gain' ? 'Amplification' : 'Difference shown in the last color'}
      title={method.setting === 'gain' ? 'Amplify the difference' : 'Saturate the colors at this difference'}
      value={normalized[method.setting]}
      options={method.values.map(value => ({ value, label: method.format(value) }))}
      onChange={value => onChange({ ...normalized, [method.setting]: Number(value) })}
    />}
  </span>;
};

// names: of the images, first then second as they show, e.g. ['new', 'reference']
export const DiffLegend = ({ diff, names = ['new', 'reference'] }) => {
  const legend = diffLegend(diff);
  const { method } = normalizeDiff(diff);
  return <div className="qiv-legend" title={DIFF_METHODS[method].description}>
    <span>{DIFF_METHODS[method].label}</span>
    {legend.colormap && <>
      <span>{legend.from}</span>
      <span className="qiv-legend-bar" style={{ background: cssGradient(legend.colormap, { reverse: legend.reverse }) }} />
      <span>{legend.to}</span>
    </>}
    {method === 'absolute' && <span>black: identical · {legend.to}: full color</span>}
    {method === 'signed' && <span className="qiv-muted">red: {names[0]} brighter · blue: darker</span>}
    {method === 'exact' && <span><span className="qiv-swatch" style={{ background: 'rgb(230,30,30)' }} /> differs</span>}
  </div>;
};


// --- Adjustments ---

export const AdjustmentsPanel = ({ adjustments, onChange }) => {
  const normalized = normalizeAdjustments(adjustments);
  const set = (name, value) => onChange({ ...normalized, [name]: value });
  return <div className="qiv-panel qiv-adjustments">
    <div className="qiv-panel-title">
      <span>Adjust the display</span>
      <Button text="Reset" icon="reset" disabled={changedAdjustments(normalized).length === 0} onClick={() => onChange(DEFAULT_ADJUSTMENTS)} />
    </div>
    {ADJUSTMENT_SLIDERS.map(slider => {
      const changed = normalized[slider.name] !== DEFAULT_ADJUSTMENTS[slider.name];
      return <label key={slider.name} className={`qiv-slider ${changed ? 'qiv-changed' : ''}`} onDoubleClick={() => set(slider.name, DEFAULT_ADJUSTMENTS[slider.name])} title="Double-click to reset">
        <span className="qiv-slider-label">{slider.label}</span>
        <input
          type="range"
          min={slider.min}
          max={slider.max}
          step={slider.step}
          value={normalized[slider.name]}
          onChange={event => set(slider.name, Number(event.target.value))}
        />
        <span className="qiv-slider-value">{slider.format(normalized[slider.name])}</span>
      </label>;
    })}
    <div className="qiv-field">
      <span className="qiv-slider-label">Channel</span>
      <Segmented
        label="Channel"
        value={normalized.channel}
        options={CHANNELS}
        onChange={value => set('channel', value)}
      />
    </div>
    <div className="qiv-field">
      <span className="qiv-slider-label">False colors</span>
      <Select
        label="False colors"
        value={normalized.falseColor ?? ''}
        options={[{ value: '', label: 'Off' }, ...FALSE_COLORS.map(name => ({ value: name, label: name[0].toUpperCase() + name.slice(1) }))]}
        onChange={value => set('falseColor', value || null)}
      />
      <label className="qiv-checkbox">
        <input type="checkbox" checked={normalized.invert} onChange={event => set('invert', event.target.checked)} /> Invert
      </label>
    </div>
    <div className="qiv-hint">Only the display changes: the pixel values, the difference and the histograms are the images'.</div>
  </div>;
};


// --- Regions of interest ---

// actions: the app's, e.g. finding the regions of other images too: [{ id, label, icon?, title?, onClick }]
export const RegionsMenu = ({ sets, selected, actions = [], onSelect, onCopy, close }) => <div className="qiv-menu" role="menu">
  <MenuItem text="Full image" icon="zoom-to-fit" active={!selected} onClick={() => { onSelect(null); close(); }} />
  {sets.length > 0 && <MenuDivider title="Regions of interest" />}
  {sets.map(set => <MenuItem
    key={set.id}
    text={set.label}
    title={set.description}
    active={selected === set.id}
    icon={selected === set.id ? 'tick' : undefined}
    label={set.loading ? <Spinner size={12} /> : set.regions ? `${set.regions.length}` : set.load ? 'find' : ''}
    onClick={() => { onSelect(set.id); close(); }}
  />)}
  {actions.length > 0 && <MenuDivider />}
  {actions.map(action => <MenuItem
    key={action.id}
    text={action.label}
    title={action.title}
    icon={action.icon}
    onClick={() => { action.onClick(); close(); }}
  />)}
  <MenuDivider />
  <MenuItem text="Copy the view as a region" icon="clipboard" onClick={() => { onCopy(); close(); }} />
</div>;

export const RegionsStrip = ({ set, index, image, size, onSelect, onRetry }) => {
  const regions = set.regions ?? [];
  const strip = useRef(null);
  useEffect(() => {
    strip.current?.querySelector('.qiv-active')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [index]);
  return <div className="qiv-regions">
    <span className="qiv-regions-title" title={set.description}>{set.label}</span>
    {set.loading && <span className="qiv-muted"><Spinner size={12} /> Finding regions…</span>}
    {set.error && <span className="qiv-error">{set.error} {set.load && <Button text="Retry" onClick={onRetry} />}</span>}
    {!set.loading && !set.error && regions.length === 0 && <span className="qiv-muted">
      {set.regions ? set.empty ?? 'No regions' : set.load ? <Button text="Find regions" onClick={onRetry} /> : null}
    </span>}
    {regions.length > 1 && <Button icon="chevron-left" title="Previous region" onClick={() => onSelect((index - 1 + regions.length) % regions.length)} />}
    <div className="qiv-regions-list" ref={strip}>
      {regions.map((region, i) => {
        const clipped = size?.width ? clipRegion(region, size) : region;
        const thumbnail = clipped && thumbnailUrl(image, clipped, 40);
        return <button
          key={i}
          type="button"
          className={`qiv-region ${i === index ? 'qiv-active' : ''}`}
          disabled={!clipped}
          title={clipped ? `${region.label ?? `Region ${i + 1}`}: x ${Math.round(clipped.x)} y ${Math.round(clipped.y)} w ${Math.round(clipped.w)} h ${Math.round(clipped.h)}` : `Outside the image: ${JSON.stringify(region)}`}
          onClick={() => onSelect(i)}
        >
          {thumbnail && <img src={thumbnail} alt="" height={40} loading="lazy" />}
          <span>
            {region.color && <span className="qiv-swatch" style={{ background: region.color }} />}
            {region.label ?? i + 1}
          </span>
        </button>;
      })}
    </div>
    {regions.length > 1 && <Button icon="chevron-right" title="Next region" onClick={() => onSelect((index + 1) % regions.length)} />}
  </div>;
};


// --- Keyboard shortcuts ---

export const SHORTCUTS = [
  ['1 2 3 4', 'Side by side / wipe / single / difference (4 again: between the images, or alone)'],
  ['t', 'Toggle: swap the sides. Showing one image or the difference alone: the other image, the difference, and again'],
  ['+ − 0', 'Zoom in / out / fit'],
  ['Wheel, pinch', 'Zoom'],
  ['Drag', 'Pan (drag the divider to wipe)'],
  ['Double-click', 'Zoom in'],
  ['p', 'Show / hide the pixel values when zoomed in'],
  ['h', 'Blind test: the images in a random order, called A and B. h again reveals them, then ends it'],
  ['[ ]', 'Previous / next region of interest'],
];

export const Shortcuts = () => <table className="qiv-shortcuts">
  <tbody>
    {SHORTCUTS.map(([keys, action]) => <tr key={keys}><td><kbd>{keys}</kbd></td><td>{action}</td></tr>)}
  </tbody>
</table>;

export { Popover };
