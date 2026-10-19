// What the viewer draws over the images: their difference, the values highlighted from the histogram, the pixel values,
// crosshairs, a minimap.
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

import { pixelDensityRatio } from './comparison';
import { renderDiff } from './diffRenderer';
import { drawHighlight } from './highlightRenderer';
import { cellFont, formatNumber, formatSigned, MIN_CELL, textColorOn, visiblePixels } from './pixels';
import { imageKey, thumbnailUrl } from './sources';

// Redraws after the viewers draw (once per frame), and when `deps` change
const useRedraw = (controller, draw, deps) => {
  const redraw = useEffectEvent(draw);
  useEffect(() => controller.onDraw(() => redraw()), [controller]);
  // oxlint-disable-next-line react/exhaustive-deps
  useEffect(() => redraw(), deps);
};

const sizeCanvas = (canvas, width, height, ratio) => {
  const w = Math.max(1, Math.round(width * ratio));
  const h = Math.max(1, Math.round(height * ratio));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
};


// The difference of the two images, as displayed. Computed only while `active`.
// order: the images as they show, ['a', 'b'] or ['b', 'a']: the difference is the first − the second
export const DiffLayer = ({ controller, order = ['a', 'b'], diff, active, width, height, canvasRef, onError }) => {
  const canvas = useRef(null);
  useLayoutEffect(() => {
    if (canvasRef) canvasRef.current = canvas.current;
  });
  useRedraw(controller, () => {
    const a = controller.canvas(order[0]);
    const b = controller.canvas(order[1]);
    if (!active || !a || !b || !canvas.current) return;
    // until both viewers drew the same region
    if (!controller.aligned()) return;
    try {
      renderDiff(canvas.current, a, b, diff);
      onError(null);
    } catch (error) {
      onError(error.message);
    }
  }, [active, diff?.method, diff?.gain, diff?.max, width, height, order.join()]);
  return <canvas ref={canvas} className="qiv-diff" style={{ width, height }} />;
};


// The pixels of a pane within a range of values, picked on the histogram: { lo, hi, channels }, or null
export const HighlightLayer = ({ controller, pane, highlight, active, width, height }) => {
  const canvas = useRef(null);
  const shown = !!highlight && active;
  useRedraw(controller, () => {
    const source = controller.canvas(pane);
    if (!shown || !source || !canvas.current) return;
    try {
      drawHighlight(canvas.current, source, highlight, pixelDensityRatio());
    } catch {
      // the image server doesn't send CORS headers: the histogram says so
    }
  }, [shown, highlight?.lo, highlight?.hi, highlight?.channels.join(), width, height]);
  if (!shown) return null;
  return <canvas ref={canvas} className="qiv-highlight" style={{ width, height }} />;
};


// The values of the pixels, written on them once users zoom in enough.
// pane: 'a', 'b', or 'diff' (the first image shown − the second, see `order`). source: 'image' (the images' own
// values, from `tiles`), 'display' (the 8-bit colors the viewers draw), or 'off'.
const sample_canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
const sampleCenters = (source, transform, visible, ratio) => {
  const cols = visible.x1 - visible.x0;
  const rows = visible.y1 - visible.y0;
  sample_canvas.width = cols;
  sample_canvas.height = rows;
  const context = sample_canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, cols, rows);
  const { origin, scale } = transform;
  // each destination pixel samples the center of an image pixel
  context.drawImage(
    source,
    (origin.x + visible.x0 * scale) * ratio, (origin.y + visible.y0 * scale) * ratio, cols * scale * ratio, rows * scale * ratio,
    0, 0, cols, rows,
  );
  return context.getImageData(0, 0, cols, rows).data;
};

// Draws the values of the pixels in the element (a canvas over a pane), once they are large enough to read.
// Returns what it wrote: { source: 'image' | 'display', loading, mode }, or null (mode: what the image values are).
const drawPixelValues = (element, { controller, pane, order = ['a', 'b'], source, width, height, tiles, images, base, diffCanvas }) => {
  const ratio = pixelDensityRatio();
  sizeCanvas(element, width, height, ratio);
  const context = element.getContext('2d');
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, element.width, element.height);
  if (source === 'off') return null;
  const reference = pane === 'diff' ? 'a' : pane;
  const transform = controller.imageTransform(reference);
  const snapshot = controller.getSnapshot();
  const size = snapshot[reference];
  if (!transform || !size?.width || transform.scale < MIN_CELL) return null;
  const visible = visiblePixels(transform, { width, height }, size);
  if (!visible) return null;
  const cols = visible.x1 - visible.x0;
  const rows = visible.y1 - visible.y0;
  let displayed, background;
  try {
    if (pane === 'diff') {
      const a = sampleCenters(controller.canvas(order[0]), transform, visible, ratio);
      const b = sampleCenters(controller.canvas(order[1]), transform, visible, ratio);
      displayed = { a, b };
      background = diffCanvas?.current ? sampleCenters(diffCanvas.current, transform, visible, ratio) : a;
    } else {
      displayed = sampleCenters(controller.canvas(pane), transform, visible, ratio);
      background = displayed;
    }
  } catch {
    // the image server doesn't send CORS headers
    return null;
  }

  // The images' own values, by tiles. The difference of the images' values needs images of the same size: with
  // another resolution, the same coordinates are another place of the scene.
  const same_size = snapshot.a.width === snapshot.b.width && snapshot.a.height === snapshot.b.height;
  const image_values = source === 'image' && !!tiles?.getPixels && (pane !== 'diff' || same_size);
  if (image_values)
    for (const name of pane === 'diff' ? ['a', 'b'] : [pane]) tiles.request(images[name], snapshot[name], visible);
  let loading = false;

  // The values to write in each pixel, or undefined while we don't know them
  const values = (i, j) => {
    const x = visible.x0 + i;
    const y = visible.y0 + j;
    const k = 4 * (j * cols + i);
    if (pane === 'diff') {
      if (!image_values) return [0, 1, 2].map(c => displayed.a[k + c] - displayed.b[k + c]);
      const value_a = tiles.get(images[order[0]], x, y);
      const value_b = tiles.get(images[order[1]], x, y);
      if (value_a === undefined || value_b === undefined) loading = true;
      if (!value_a || !value_b || value_a.length !== value_b.length) return undefined;
      return value_a.map((v, c) => v - value_b[c]);
    }
    if (!image_values) return [displayed[k], displayed[k + 1], displayed[k + 2]];
    const value = tiles.get(images[pane], x, y);
    if (value === undefined) loading = true;
    return value ?? undefined;
  };
  // Gray images: one value per pixel
  let gray = true;
  let digits = 1;
  const cells = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const v = values(i, j);
      if (!v) {
        cells.push(null);
        continue;
      }
      if (v.length > 1 && v.some(c => c !== v[0])) gray = false;
      const text = v.map(c => c === null ? '–' : pane === 'diff' ? formatSigned(c) : formatNumber(c, base));
      digits = Math.max(digits, ...text.map(t => t.length));
      cells.push(text);
    }
  }
  const lines = gray ? 1 : Math.max(1, ...cells.map(c => c?.length ?? 0));
  const font_size = cellFont(transform.scale, lines, digits);
  const { origin, scale } = transform;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);

  // pixel borders
  context.beginPath();
  for (let i = 0; i <= cols; i++) {
    const x = Math.round((origin.x + (visible.x0 + i) * scale) * ratio) / ratio;
    context.moveTo(x, Math.max(0, origin.y + visible.y0 * scale));
    context.lineTo(x, Math.min(height, origin.y + visible.y1 * scale));
  }
  for (let j = 0; j <= rows; j++) {
    const y = Math.round((origin.y + (visible.y0 + j) * scale) * ratio) / ratio;
    context.moveTo(Math.max(0, origin.x + visible.x0 * scale), y);
    context.lineTo(Math.min(width, origin.x + visible.x1 * scale), y);
  }
  context.strokeStyle = 'rgba(128, 128, 128, 0.45)';
  context.lineWidth = 1 / ratio;
  context.stroke();
  const drawn = { source: image_values ? 'image' : 'display', loading, mode: image_values ? tiles.mode(images[reference]) : null };
  if (!font_size) return drawn;

  context.font = `${font_size}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  const line_height = font_size * 1.15;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const text = cells[j * cols + i];
      if (!text) continue;
      const shown = gray ? text.slice(0, 1) : text;
      const k = 4 * (j * cols + i);
      const color = textColorOn(background[k], background[k + 1], background[k + 2]);
      const cx = origin.x + (visible.x0 + i + 0.5) * scale;
      const cy = origin.y + (visible.y0 + j + 0.5) * scale - (shown.length - 1) * line_height / 2;
      // a halo of the opposite color, for mid-tones
      context.strokeStyle = color === '#000' ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)';
      context.lineWidth = 2.5;
      context.fillStyle = color;
      shown.forEach((line, n) => {
        context.strokeText(line, cx, cy + n * line_height);
        context.fillText(line, cx, cy + n * line_height);
      });
    }
  }
  return drawn;
};

// onDrawn({ source, loading, mode } | null): what it shows, when it changes
export const PixelValues = ({ controller, pane, order, source, width, height, tiles, images, base, diffCanvas, onDrawn }) => {
  const canvas = useRef(null);
  // the images' values arrive by tiles
  const version = useSyncExternalStore(tiles.subscribe, tiles.getVersion);
  const last = useRef(undefined);
  useRedraw(controller, () => {
    if (!canvas.current) return;
    const drawn = drawPixelValues(canvas.current, { controller, pane, order, source, width, height, tiles, images, base, diffCanvas });
    const key = JSON.stringify(drawn);
    if (key !== last.current) {
      last.current = key;
      onDrawn?.(drawn);
    }
  }, [source, width, height, version, base, pane, order?.join(), imageKey(images.a), imageKey(images.b)]);
  return <canvas ref={canvas} className="qiv-pixel-values" style={{ width, height }} />;
};


// A cross where the pointer is, on every pane and synced viewer, the one under the mouse included: the same pixel
// everywhere, also in screenshots, which have no cursor
export const Crosshair = ({ controller, pane }) => {
  const pointer = useSyncExternalStore(controller.subscribePointer, controller.getPointer);
  const [, redraw] = useState(0);
  useEffect(() => controller.onDraw(() => redraw(n => n + 1)), [controller]);
  if (!pointer) return null;
  const position = controller.screenPoint(pane, pointer.point);
  if (!position) return null;
  // white over a dark outline, to show on any image; open in its middle, to see the pixel
  return <svg className="qiv-crosshair" style={{ left: position.x, top: position.y }} width="25" height="25" viewBox="0 0 25 25" aria-hidden="true">
    <path d={CROSS} stroke="rgba(0, 0, 0, 0.75)" strokeWidth="3" />
    <path d={CROSS} stroke="#fff" strokeWidth="1" />
  </svg>;
};
const CROSS = 'M12.5 0v9M12.5 16v9M0 12.5h9M16 12.5h9';


// Where the view is in the whole image, when zoomed in. Click or drag to go elsewhere.
export const Minimap = ({ controller, image, size }) => {
  const [region, setRegion] = useState(null);
  const update = useEffectEvent(() => {
    const visible = controller.visibleRegion();
    const next = visible && size?.width && (visible.w < size.width * 0.95 || visible.h < size.height * 0.95) ? visible : null;
    setRegion(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  });
  useEffect(() => controller.onDraw(() => update()), [controller]);
  const dragging = useRef(false);
  if (!region || !size?.width) return null;
  const src = thumbnailUrl(image, null, 120) ?? image?.url ?? (typeof image === 'string' ? image : null);
  if (!src) return null;
  const width = 96 * size.width / size.height > 128 ? 128 : Math.round(96 * size.width / size.height);
  const height = Math.round(width * size.height / size.width);
  const go = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    controller.panToImagePoint(
      (event.clientX - rect.left) / rect.width * size.width,
      (event.clientY - rect.top) / rect.height * size.height,
      dragging.current,
    );
  };
  return <div
    className="qiv-minimap"
    style={{ width, height }}
    title="Where you are in the image: click or drag to move"
    onPointerDown={event => {
      event.stopPropagation();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      dragging.current = true;
      go(event);
    }}
    onPointerMove={event => dragging.current && go(event)}
    onPointerUp={() => { dragging.current = false; }}
    onPointerCancel={() => { dragging.current = false; }}
  >
    <img src={src} alt="" draggable={false} />
    <div className="qiv-minimap-view" style={{
      left: `${100 * region.x / size.width}%`,
      top: `${100 * region.y / size.height}%`,
      width: `${100 * region.w / size.width}%`,
      height: `${100 * region.h / size.height}%`,
    }} />
  </div>;
};
