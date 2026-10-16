// What the viewer draws over the images: their difference, the pixel values, crosshairs, a minimap.
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

import { pixelDensityRatio } from './comparison';
import { renderDiff } from './diffRenderer';
import { cellFont, formatNumber, formatSigned, MAX_FETCHED_PIXELS, MIN_CELL, pixelFrom, textColorOn, visiblePixels } from './pixels';
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
export const DiffLayer = ({ controller, diff, active, width, height, canvasRef, onError }) => {
  const canvas = useRef(null);
  useLayoutEffect(() => {
    if (canvasRef) canvasRef.current = canvas.current;
  });
  useRedraw(controller, () => {
    const a = controller.canvas('a');
    const b = controller.canvas('b');
    if (!active || !a || !b || !canvas.current) return;
    // until both viewers drew the same region
    if (!controller.aligned()) return;
    try {
      renderDiff(canvas.current, a, b, diff);
      onError(null);
    } catch (error) {
      onError(error.message);
    }
  }, [active, diff?.method, diff?.gain, diff?.max, width, height]);
  return <canvas ref={canvas} className="qiv-diff" style={{ width, height }} />;
};


// The values of the pixels, written on them once users zoom in enough.
// pane: 'a', 'b', or 'diff' (new − reference). raw: the image's values fetched in the visible region, by pane.
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

// Draws the values of the pixels in the element (a canvas over a pane), once they are large enough to read
const drawPixelValues = (element, { controller, pane, enabled, width, height, raw, base, diffCanvas }) => {
  const ratio = pixelDensityRatio();
  sizeCanvas(element, width, height, ratio);
  const context = element.getContext('2d');
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, element.width, element.height);
  if (!enabled) return;
  const source = pane === 'diff' ? 'a' : pane;
  const transform = controller.imageTransform(source);
  const size = controller.getSnapshot()[source];
  if (!transform || !size?.width || transform.scale < MIN_CELL) return;
  const visible = visiblePixels(transform, { width, height }, size);
  if (!visible) return;
  const cols = visible.x1 - visible.x0;
  const rows = visible.y1 - visible.y0;
  let displayed, background;
  try {
    if (pane === 'diff') {
      const a = sampleCenters(controller.canvas('a'), transform, visible, ratio);
      const b = sampleCenters(controller.canvas('b'), transform, visible, ratio);
      displayed = { a, b };
      background = diffCanvas?.current ? sampleCenters(diffCanvas.current, transform, visible, ratio) : a;
    } else {
      displayed = sampleCenters(controller.canvas(pane), transform, visible, ratio);
      background = displayed;
    }
  } catch {
    // the image server doesn't send CORS headers
    return;
  }

  // The values to write in each pixel
  const values = (i, j) => {
    const x = visible.x0 + i;
    const y = visible.y0 + j;
    const k = 4 * (j * cols + i);
    if (pane === 'diff') {
      const raw_a = pixelFrom(raw?.a, x, y);
      const raw_b = pixelFrom(raw?.b, x, y);
      if (raw_a && raw_b && raw_a.length === raw_b.length) return raw_a.map((v, c) => v - raw_b[c]);
      return [0, 1, 2].map(c => displayed.a[k + c] - displayed.b[k + c]);
    }
    const raw_value = pixelFrom(raw?.[pane], x, y);
    if (raw_value) return raw_value;
    return [displayed[k], displayed[k + 1], displayed[k + 2]];
  };
  // Gray images: one value per pixel
  let gray = true;
  let digits = 1;
  const cells = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const v = values(i, j);
      if (v.length > 1 && v.some(c => c !== v[0])) gray = false;
      const text = v.map(c => pane === 'diff' ? formatSigned(c) : formatNumber(c, base));
      digits = Math.max(digits, ...text.map(t => t.length));
      cells.push(text);
    }
  }
  const lines = gray ? 1 : Math.max(...cells.map(c => c.length));
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
  if (!font_size) return;

  context.font = `${font_size}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  const line_height = font_size * 1.15;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const text = cells[j * cols + i];
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
};

export const PixelValues = ({ controller, pane, enabled, width, height, raw, base, diffCanvas }) => {
  const canvas = useRef(null);
  useRedraw(controller, () => {
    if (canvas.current) drawPixelValues(canvas.current, { controller, pane, enabled, width, height, raw, base, diffCanvas });
  }, [enabled, width, height, raw, base, pane]);
  return <canvas ref={canvas} className="qiv-pixel-values" style={{ width, height }} />;
};


// The image's own values in the visible region, from the app's getPixels, once users zoomed in enough to see them.
// We fetch a margin around the view: panning doesn't refetch right away.
export const useVisiblePixels = ({ controller, pane, image, getPixels, enabled, width, height }) => {
  const [pixels, setPixels] = useState(null);
  const key = imageKey(image);
  const state = useRef({ timer: null, abort: null, fetched: null });
  const check = useEffectEvent(() => {
    const s = state.current;
    if (!enabled || !getPixels || !image) return;
    const transform = controller.imageTransform(pane);
    const size = controller.getSnapshot()[pane];
    if (!transform || !size?.width || transform.scale < MIN_CELL) return;
    const visible = visiblePixels(transform, { width, height }, size);
    if (!visible) return;
    const f = s.fetched;
    if (f && f.key === key && visible.x0 >= f.x && visible.y0 >= f.y && visible.x1 <= f.x + f.w && visible.y1 <= f.y + f.h) return;
    clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      // half a view more on each side, if we can
      const w = visible.x1 - visible.x0;
      const h = visible.y1 - visible.y0;
      const x = Math.max(0, visible.x0 - Math.ceil(w / 2));
      const y = Math.max(0, visible.y0 - Math.ceil(h / 2));
      let region = { x, y, w: Math.min(size.width, visible.x1 + Math.ceil(w / 2)) - x, h: Math.min(size.height, visible.y1 + Math.ceil(h / 2)) - y };
      if (region.w * region.h > MAX_FETCHED_PIXELS) region = { x: visible.x0, y: visible.y0, w, h };
      if (region.w * region.h > MAX_FETCHED_PIXELS) return;
      s.abort?.abort();
      const abort = new AbortController();
      s.abort = abort;
      s.fetched = { ...region, key };
      Promise.resolve(getPixels(image, region, { signal: abort.signal })).then(result => {
        if (!abort.signal.aborted && result?.values) setPixels({ region, values: result.values, mode: result.mode, key });
      }, error => {
        if (abort.signal.aborted || error?.name === 'AbortError') return;
        s.fetched = null;
        setPixels({ region, values: null, error: error?.message ?? String(error), key });
      });
    }, 150);
  });
  useEffect(() => controller.onDraw(() => check()), [controller]);
  useEffect(() => {
    check();
  }, [enabled, key, getPixels, width, height]);
  useEffect(() => () => {
    clearTimeout(state.current.timer);
    state.current.abort?.abort();
  }, []);
  // only for the image shown now
  return pixels?.key === key && enabled ? pixels : null;
};


// A cross where the pointer is: on synced viewers, and with `local`, on the pane the pointer is not over
export const Crosshair = ({ controller, pane, local }) => {
  const pointer = useSyncExternalStore(controller.subscribePointer, controller.getPointer);
  const [, redraw] = useState(0);
  useEffect(() => controller.onDraw(() => redraw(n => n + 1)), [controller]);
  if (!pointer || (!pointer.remote && (!local || pointer.pane === pane))) return null;
  const position = controller.screenPoint(pane, pointer.point);
  if (!position) return null;
  return <div className="qiv-crosshair" style={{ left: position.x, top: position.y }} />;
};


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
