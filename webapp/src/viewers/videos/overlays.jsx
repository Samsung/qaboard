// What the video viewer draws over the videos: their difference, the values of the pixels, regions, a minimap.
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react';

import { renderDiff } from '../../image-viewer/diffRenderer';
import { drawHighlight } from '../../image-viewer/highlightRenderer';
import { cellFont, formatNumber, formatSigned, MIN_CELL, textColorOn, visiblePixels } from '../../image-viewer/pixels';
import { displayRegion, frameCanvas, hasFrame } from './frames';
import { regionRect, transformOf } from './viewTransform';

// Calls `draw` when the videos show another frame (at most once per animation frame), and when `deps` change
export const useOnFrames = (controller, draw, deps) => {
  const redraw = useEffectEvent(draw);
  useEffect(() => {
    let pending = null;
    const stop = controller.onFrames(() => {
      if (pending !== null) return;
      pending = requestAnimationFrame(() => {
        pending = null;
        redraw();
      });
    });
    return () => {
      stop();
      if (pending !== null) cancelAnimationFrame(pending);
    };
  }, [controller]);
  // oxlint-disable-next-line react/exhaustive-deps
  useEffect(() => redraw(), deps);
};

// A number that changes when the videos show another frame: for components that read them as they render
export const useFrameVersion = controller => {
  const [version, setVersion] = useState(0);
  useOnFrames(controller, () => setVersion(v => v + 1), [controller]);
  return version;
};


// The difference of the frames shown, first − second, computed for every frame on the GPU: one WebGL context for
// all the viewers of the page (src/image-viewer/diffRenderer.js). The canvas has the size of the frames: the parent
// zooms it like the videos.
export const DiffLayer = ({ first, second, diff, controller, canvasRef, onError }) => {
  const canvas = useRef(null);
  const error = useRef(null);
  const setError = message => {
    if (message === error.current) return;
    error.current = message;
    onError?.(message);
  };
  useEffect(() => {
    if (canvasRef) canvasRef.current = canvas.current;
  });
  useOnFrames(controller, () => {
    if (!canvas.current || !hasFrame(first) || !hasFrame(second)) return;
    try {
      renderDiff(canvas.current, first, second, diff);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [first, second, JSON.stringify(diff)]);
  return <canvas ref={canvas} aria-label="Difference" />;
};


// The pixels of the frame shown within a range of values, picked on the histogram: { lo, hi, channels }, or null.
// Like the image viewer's: from the frame as it shows in the pane, at the screen's resolution.
const shown_frame = typeof document !== 'undefined' ? document.createElement('canvas') : null;
export const HighlightLayer = ({ controller, video, highlight, view, pane, media }) => {
  const canvas = useRef(null);
  useOnFrames(controller, () => {
    if (!canvas.current || !highlight || !hasFrame(video)) return;
    const ratio = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(pane.width * ratio));
    const h = Math.max(1, Math.round(pane.height * ratio));
    if (shown_frame.width !== w || shown_frame.height !== h) {
      shown_frame.width = w;
      shown_frame.height = h;
    }
    const context = shown_frame.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, w, h);
    const t = transformOf(view, pane, media);
    // zoomed in, the actual pixels, like the videos show
    context.imageSmoothingEnabled = t.width * t.scale / video.videoWidth < 2;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.drawImage(video, t.x, t.y, t.width * t.scale, t.height * t.scale);
    try {
      drawHighlight(canvas.current, shown_frame, highlight, ratio);
    } catch {
      // the server doesn't send CORS headers: the histogram says so
    }
  }, [video, highlight?.lo, highlight?.hi, highlight?.channels.join(), pane.width, pane.height, view.zoom, view.cx, view.cy, media?.width, media?.height]);
  if (!highlight) return null;
  return <canvas ref={canvas} className="video-highlight" aria-hidden="true" style={{ width: pane.width, height: pane.height }} />;
};


// The values of the pixels, written on them once zoomed in enough, when the videos are paused.
// content: the video shown in the pane ('new' or 'reference'), or 'diff' (first − second).
// source: 'decoded' (the server's, with `tiles`), 'display' (8-bit RGB, as the browser shows), or 'off'.
const drawValues = (canvas, { content, videos, frames, order, view, pane, source, tiles, base, playing }) => {
  const ratio = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(pane.width * ratio));
  const h = Math.max(1, Math.round(pane.height * ratio));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, w, h);
  if (source === 'off' || playing) return null;
  const main = content === 'diff' ? order[0] : content;
  const video = videos[main];
  if (!hasFrame(video)) return null;
  const media = { width: video.videoWidth, height: video.videoHeight };
  const t = transformOf(view, pane, media);
  const scale = t.width * t.scale / media.width;
  if (scale < MIN_CELL) return null;
  const visible = visiblePixels({ origin: { x: t.x, y: t.y }, scale }, pane, media);
  if (!visible) return null;
  const cols = visible.x1 - visible.x0;
  const rows = visible.y1 - visible.y0;
  const names = content === 'diff' ? order : [content];
  const displayed = {};
  for (const name of names) {
    const other = videos[name];
    // the difference needs frames of the same size
    if (!hasFrame(other) || other.videoWidth !== media.width || other.videoHeight !== media.height) return null;
    displayed[name] = displayRegion(other, visible);
    if (!displayed[name]) return null;
  }
  const decoded = source === 'decoded' && !!tiles?.getPixels && names.every(name => frames[name]);
  if (decoded) for (const name of names) tiles.request(frames[name], media, visible);
  let loading = false;
  const values = (i, j) => {
    const x = visible.x0 + i;
    const y = visible.y0 + j;
    const k = 4 * (j * cols + i);
    if (!decoded) {
      if (content !== 'diff') return [0, 1, 2].map(c => displayed[main][k + c]);
      return [0, 1, 2].map(c => displayed[order[0]][k + c] - displayed[order[1]][k + c]);
    }
    const value = names.map(name => tiles.get(frames[name], x, y));
    if (value.some(v => v === undefined)) loading = true;
    if (value.some(v => !v)) return undefined;
    if (content !== 'diff') return value[0];
    return value[0].length === value[1].length ? value[0].map((v, c) => v - value[1][c]) : undefined;
  };
  let digits = 1;
  let gray = true;
  const cells = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const v = values(i, j);
      if (!v) {
        cells.push(null);
        continue;
      }
      if (v.length > 1 && v.some(c => c !== v[0])) gray = false;
      const text = v.map(c => c === null ? '–' : content === 'diff' ? formatSigned(c) : formatNumber(c, base));
      digits = Math.max(digits, ...text.map(s => s.length));
      cells.push(text);
    }
  }
  const lines = gray ? 1 : Math.max(1, ...cells.map(c => c?.length ?? 0));
  const font_size = cellFont(scale, lines, digits);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.beginPath();
  for (let i = 0; i <= cols; i++) {
    const x = Math.round((t.x + (visible.x0 + i) * scale) * ratio) / ratio;
    context.moveTo(x, Math.max(0, t.y + visible.y0 * scale));
    context.lineTo(x, Math.min(pane.height, t.y + visible.y1 * scale));
  }
  for (let j = 0; j <= rows; j++) {
    const y = Math.round((t.y + (visible.y0 + j) * scale) * ratio) / ratio;
    context.moveTo(Math.max(0, t.x + visible.x0 * scale), y);
    context.lineTo(Math.min(pane.width, t.x + visible.x1 * scale), y);
  }
  context.strokeStyle = 'rgba(128, 128, 128, 0.45)';
  context.lineWidth = 1 / ratio;
  context.stroke();
  const drawn = { source: decoded ? 'decoded' : 'display', loading, mode: decoded ? tiles.mode(frames[main]) : null };
  if (!font_size) return drawn;
  context.font = `${font_size}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  const line_height = font_size * 1.15;
  // on the difference, the text shows over a heatmap we don't read back: white with a dark halo
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const text = cells[j * cols + i];
      if (!text) continue;
      const shown = gray ? text.slice(0, 1) : text;
      const k = 4 * (j * cols + i);
      const background = displayed[main];
      const color = content === 'diff' ? '#fff' : textColorOn(background[k], background[k + 1], background[k + 2]);
      const cx = t.x + (visible.x0 + i + 0.5) * scale;
      const cy = t.y + (visible.y0 + j + 0.5) * scale - (shown.length - 1) * line_height / 2;
      context.strokeStyle = color === '#000' ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.65)';
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
export const PixelValues = ({ controller, tiles, onDrawn, ...props }) => {
  const canvas = useRef(null);
  const version = useSyncExternalStore(tiles.subscribe, tiles.getVersion);
  const last = useRef(undefined);
  const { content, pane, view, source, base, playing, frames, order, videos } = props;
  useOnFrames(controller, () => {
    if (!canvas.current) return;
    const drawn = drawValues(canvas.current, { ...props, tiles });
    const key = JSON.stringify(drawn);
    if (key !== last.current) {
      last.current = key;
      onDrawn?.(drawn);
    }
  }, [content, pane.width, pane.height, view.zoom, view.cx, view.cy, source, base, playing, version,
    frames.new?.url, frames.reference?.url, order.join(), videos.new, videos.reference]);
  return <canvas ref={canvas} className="video-pixel-values" style={{ width: pane.width, height: pane.height }} />;
};


// The region of interest shown, outlined
export const RegionOutline = ({ region, view, pane, media }) => {
  if (!region || !media?.width) return null;
  const rect = regionRect(region, view, pane, media);
  return <div className="video-region-outline" style={{ ...rect, borderColor: region.color ?? undefined }} title={region.label}>
    {region.label && <span>{region.label}</span>}
  </div>;
};


// Where the view is in the frame, when zoomed in. Click or drag to go elsewhere.
export const Minimap = ({ controller, video, view, pane, media, onPan }) => {
  const canvas = useRef(null);
  const dragging = useRef(false);
  const zoomed = !!media?.width && view.zoom > 1.05;
  const width = media?.width ? (96 * media.width / media.height > 128 ? 128 : Math.round(96 * media.width / media.height)) : 0;
  const height = media?.width ? Math.round(width * media.height / media.width) : 0;
  useOnFrames(controller, () => {
    if (zoomed && canvas.current && video) frameCanvas(video, width * (window.devicePixelRatio || 1), canvas.current);
  }, [zoomed, video, width]);
  if (!zoomed) return null;
  // the part of the frame in view
  const t = transformOf(view, pane, media);
  const shown = t.width * t.scale;
  const left = Math.max(0, -t.x / shown);
  const top = Math.max(0, -t.y / (t.height * t.scale));
  const go = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    onPan((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
  };
  return <div
    className="qiv-minimap video-minimap"
    style={{ width, height }}
    title="Where you are in the frame: click or drag to move"
    onPointerDown={event => {
      event.stopPropagation();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      dragging.current = true;
      go(event);
    }}
    onPointerMove={event => dragging.current && go(event)}
    onPointerUp={event => { event.stopPropagation(); dragging.current = false; }}
    onPointerCancel={() => { dragging.current = false; }}
  >
    <canvas ref={canvas} style={{ width, height }} />
    <div className="qiv-minimap-view" style={{
      left: `${100 * left}%`,
      top: `${100 * top}%`,
      width: `${100 * Math.min(1, pane.width / shown)}%`,
      height: `${100 * Math.min(1, pane.height / (t.height * t.scale))}%`,
    }} />
  </div>;
};
