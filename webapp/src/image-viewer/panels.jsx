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

const ImageValues = ({ label, pixel, display, image, base, intent }) => <span className="qiv-readout-image">
  <span className={`qiv-readout-label qiv-${intent}`}>{label}</span>{' '}
  {display && <span className="qiv-swatch" style={{ background: `rgb(${display[0]},${display[1]},${display[2]})` }} title="The displayed color" />}
  {image && <span title={`${IMAGE_VALUES}${image.mode ? `. Here: ${image.mode}` : ''}`}>
    <Chip>image</Chip>{' '}
    {image.value ? <Values values={image.value} base={base} />
      : image.value === undefined ? <span className="qiv-muted">…</span>
      : <span className="qiv-warning-text" title={image.error ?? "Can't read the image's values"}>unavailable</span>}
    {image.mode && <span className="qiv-muted"> {image.mode}</span>}{' '}
  </span>}
  {display && !same_values(display, image?.value) && <span title={DISPLAY_VALUES}>
    <Chip>display</Chip> <Values values={display.slice(0, 3)} base={base} />{' '}
  </span>}
  {!display && pixel === null && <span className="qiv-muted">outside</span>}
</span>;

export const Readout = ({ controller, tiles, images, comparing, diff, base, onToggleBase, sizes }) => {
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
  const pixel_a = point && controller.imagePixel('a', point);
  const pixel_b = point && comparing ? controller.imagePixel('b', point) : null;
  const display_a = pixel_a && controller.displayPixel('a', point);
  const display_b = pixel_b && controller.displayPixel('b', point);
  const image_a = useImageValue(tiles, images.a, sizes.a, pixel_a);
  const image_b = useImageValue(tiles, comparing ? images.b : null, sizes.b, pixel_b);

  if (!point) {
    const size = s => s?.width ? `${s.width}×${s.height}` : '…';
    return <div className="qiv-readout qiv-muted">
      {comparing
        ? <span>{images.a?.label ?? 'new'} {size(sizes.a)} · {images.b?.label ?? 'reference'} {size(sizes.b)}</span>
        : <span>{size(sizes.a)}</span>}
      <span className="qiv-readout-hint">Hover a pixel for its values · scroll to zoom · drag to pan</span>
    </div>;
  }
  const { method } = normalizeDiff(diff);
  const delta = display_a && display_b ? diffAt(diff, display_a, display_b) : null;
  // the difference of the images' values, for images of the same size
  const same_size = sizes.a?.width === sizes.b?.width && sizes.a?.height === sizes.b?.height;
  const image_delta = same_size && image_a?.value && image_b?.value && image_a.value.length === image_b.value.length
    ? image_a.value.map((v, i) => v === null || image_b.value[i] === null ? null : v - image_b.value[i]) : null;
  const coordinates = pixel_a ?? pixel_b;
  return <button
    type="button"
    className={`qiv-readout ${hovering ? '' : 'qiv-stale'}`}
    onClick={onToggleBase}
    title={`The pixel under the pointer. Click to show the values in ${base === 10 ? 'hexadecimal' : 'decimal'}`}
  >
    {coordinates && <span className="qiv-coordinates">x {coordinates.x} y {coordinates.y} </span>}
    {pixel_b && pixel_a && (pixel_b.x !== pixel_a.x || pixel_b.y !== pixel_a.y) && <span className="qiv-coordinates qiv-muted">
      (ref x {pixel_b.x} y {pixel_b.y})
    </span>}
    <ImageValues label={images.a?.label ?? 'new'} intent="primary" pixel={pixel_a} display={display_a} image={image_a} base={base} />
    {comparing && <ImageValues label={images.b?.label ?? 'reference'} intent="warning" pixel={pixel_b} display={display_b} image={image_b} base={base} />}
    {delta && <span className="qiv-readout-image" title={`${images.a?.label ?? 'new'} − ${images.b?.label ?? 'reference'}`}>
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

export const Histogram = ({ controller, comparing, labels }) => {
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
        <span className="qiv-muted">— {labels.a}</span>
        {comparing && <span className="qiv-muted">- - {labels.b}</span>}
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

export const DiffLegend = ({ diff }) => {
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
    {method === 'signed' && <span className="qiv-muted">blue: darker · red: brighter</span>}
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

export const RegionsMenu = ({ sets, selected, onSelect, onCopy, close }) => <div className="qiv-menu" role="menu">
  <MenuItem text="Full image" icon="zoom-to-fit" active={!selected} onClick={() => { onSelect(null); close(); }} />
  {sets.length > 0 && <MenuDivider title="Regions of interest" />}
  {sets.map(set => <MenuItem
    key={set.id}
    text={set.label}
    active={selected === set.id}
    icon={selected === set.id ? 'tick' : undefined}
    label={set.loading ? <Spinner size={12} /> : set.regions ? `${set.regions.length}` : set.load ? 'find' : ''}
    onClick={() => { onSelect(set.id); close(); }}
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
      {set.regions ? 'No regions' : set.load ? <Button text="Find regions" onClick={onRetry} /> : null}
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
  ['t', 'Swap the images (in toggle mode: flip, or click the image)'],
  ['+ − 0', 'Zoom in / out / fit'],
  ['Wheel, pinch', 'Zoom'],
  ['Drag', 'Pan (drag the divider to wipe)'],
  ['Double-click', 'Zoom in'],
  ['p', 'Show / hide the pixel values when zoomed in'],
  ['h', 'Hide / show the labels'],
  ['[ ]', 'Previous / next region of interest'],
];

export const Shortcuts = () => <table className="qiv-shortcuts">
  <tbody>
    {SHORTCUTS.map(([keys, action]) => <tr key={keys}><td><kbd>{keys}</kbd></td><td>{action}</td></tr>)}
  </tbody>
</table>;

export { Popover };
