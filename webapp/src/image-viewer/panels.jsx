// The viewer's panels: the values under the pointer, histograms, adjustments, regions of interest, legends.
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react';

import { ADJUSTMENT_SLIDERS, CHANNELS, DEFAULT_ADJUSTMENTS, FALSE_COLORS, changedAdjustments, normalizeAdjustments } from './adjustments';
import { cssGradient } from './colormaps';
import { DIFF_METHODS, diffAt, diffLegend, formatDiffValue, normalizeDiff } from './metrics';
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
export const Readout = ({ controller, tiles, images, comparing, names, order, neutral, diff, base, onToggleBase, sizes }) => {
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
      <span className="qiv-readout-hint">Hover a pixel for its values · scroll to zoom · drag to pan</span>
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
export const ValuesPanel = ({ source, available, onChange }) => {
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
        {option.disabled && <span className="qiv-option-description">Not available for these images.</span>}
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
const CHANNEL_NAMES = ['R', 'G', 'B', 'Y'];

// [r, g, b, luma] x 256 bins, of what a viewer displays (not the transparent margins)
export const histogram = canvas => {
  const { width, height } = canvas;
  const bins = [0, 1, 2, 3].map(() => new Float64Array(256));
  if (!width || !height) return { bins, total: 0 };
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  const step = width * height > 1e6 ? 2 : 1;
  let total = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = 4 * (y * width + x);
      if (data[i + 3] === 0) continue;
      bins[0][data[i]]++;
      bins[1][data[i + 1]]++;
      bins[2][data[i + 2]]++;
      bins[3][Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])]++;
      total++;
    }
  }
  return { bins, total };
};

// The histograms of what the viewers display, or null when we can't read their pixels
const readHistograms = (controller, comparing) => {
  try {
    return [['a', false], ...(comparing ? [['b', true]] : [])]
      .map(([name, dashed]) => ({ ...histogram(controller.canvas(name) ?? { width: 0, height: 0 }), dashed }));
  } catch {
    return null;
  }
};

export const Histogram = ({ controller, comparing, names }) => {
  const canvas = useRef(null);
  const [error, setError] = useState(null);
  const timer = useRef(null);
  const draw = useEffectEvent(() => {
    const element = canvas.current;
    if (!element) return;
    const series = readHistograms(controller, comparing);
    setError(series ? null : "The image server doesn't allow reading the pixels (CORS)");
    if (!series) return;
    const ratio = window.devicePixelRatio || 1;
    const width = element.clientWidth;
    const height = element.clientHeight;
    element.width = Math.round(width * ratio);
    element.height = Math.round(height * ratio);
    const context = element.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    // the clipped values (0 and 255) would squash the rest
    let max = 0;
    for (const s of series)
      for (const bins of s.bins)
        for (let i = 1; i < 255; i++) max = Math.max(max, bins[i] / (s.total || 1));
    if (!max) return;
    const text_color = getComputedStyle(element).color;
    for (const s of series) {
      s.bins.forEach((bins, channel) => {
        context.beginPath();
        for (let i = 0; i < 256; i++) {
          const x = (i + 0.5) / 256 * width;
          const y = height - 2 - Math.min(1, bins[i] / (s.total || 1) / max) * (height - 4);
          if (i === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.strokeStyle = channel === 3 ? text_color : CHANNEL_COLORS[channel];
        context.globalAlpha = channel === 3 ? 0.9 : 0.75;
        context.lineWidth = 1.25;
        context.setLineDash(s.dashed ? [4, 3] : []);
        context.stroke();
      });
    }
    context.globalAlpha = 1;
  });
  useEffect(() => controller.onDraw(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      draw();
    }, 250);
  }), [controller]);
  useEffect(() => {
    draw();
    return () => clearTimeout(timer.current);
  }, [comparing]);
  return <div className="qiv-histogram">
    <div className="qiv-histogram-header">
      <span>Histogram of the view</span>
      <span className="qiv-histogram-legend">
        {CHANNEL_NAMES.map((name, i) => <span key={name} style={{ color: CHANNEL_COLORS[i] }}>{name}</span>)}
        <span className="qiv-muted">— {names.a}</span>
        {comparing && <span className="qiv-muted">- - {names.b}</span>}
      </span>
    </div>
    {error ? <div className="qiv-message">{error}</div> : <canvas ref={canvas} aria-label="Histograms of the displayed images" />}
    <div className="qiv-histogram-axis qiv-muted"><span>0</span><span>displayed values</span><span>255</span></div>
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
  ['1 2 3 4', 'Side by side / wipe / toggle / difference (4 again: between the images, or alone)'],
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
