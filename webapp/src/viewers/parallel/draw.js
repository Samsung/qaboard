// What the plot draws on canvases: every line on the base layer (tiles, redrawn only when the data, the layout or
// the brushes change), the hovered and marked rows on a light overlay (redrawn at every hover).
import { formatValue, lineStyle } from './model';

const PREVIEW_ROWS = 700;
const HOVER_ROWS = 1500;

/** A 2d context of `width` x `height` CSS pixels, scaled for the screen's pixel ratio. null without canvas (tests). */
export function prepare(canvas, width, height, dpr) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  let ctx = null;
  try { ctx = canvas.getContext('2d'); } catch { return null; }
  if (!ctx) return null;
  const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

// Row i's line from axis `ja` to axis `jb`: smooth curves that leave and reach the axes horizontally
function trace(ctx, axes, i, ja, jb, c) {
  let x0 = axes[ja].x, y0 = axes[ja].pos[i];
  ctx.moveTo(x0, y0);
  for (let j = ja + 1; j <= jb; j++) {
    const x1 = axes[j].x, y1 = axes[j].pos[i];
    if (y1 === y0) ctx.lineTo(x1, y1);
    else {
      const d = (x1 - x0) * c;
      ctx.bezierCurveTo(x0 + d, y0, x1 - d, y1, x1, y1);
    }
    x0 = x1; y0 = y1;
  }
}

// The axes needed to draw what's between x0 and x1
function span(axes, x0, x1) {
  let ja = 0, jb = axes.length - 1;
  while (ja < axes.length - 2 && axes[ja + 1].x <= x0) ja++;
  while (jb > ja + 1 && axes[jb - 1].x >= x1) jb--;
  return [ja, jb];
}

/**
 * Every row's line between x0 and x1 (a tile of the base layer; ctx is already translated): the rows the brushes
 * dropped in light gray behind, the others in their color, the salient ones last.
 */
export function drawBase(ctx, { axes, colors, mask, selected_count, curve, dark, preview }, x0, x1) {
  if (axes.length < 2) return;
  const [ja, jb] = span(axes, x0, x1);
  const n = axes[0].pos.length;
  const { order, index, palette } = colors;
  // while a brush is dragged, a sample of the rows: enough to see what the brush keeps, at every frame
  const shown = mask ? selected_count : n;
  const stride = preview ? Math.max(1, Math.ceil(shown / PREVIEW_ROWS)) : 1;
  ctx.lineJoin = 'round';
  if (mask) {
    // one path: fast, and the gray doesn't pile up into something darker than the selected lines
    const gray_stride = preview ? Math.max(1, Math.ceil((n - shown) / PREVIEW_ROWS)) : 1;
    ctx.beginPath();
    for (let i = 0, k = 0; i < n; i++) if (!mask[i] && k++ % gray_stride === 0) trace(ctx, axes, i, ja, jb, curve);
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.strokeStyle = dark ? 'rgba(171, 179, 191, 0.13)' : 'rgba(95, 107, 124, 0.13)';
    ctx.stroke();
  }
  const { alpha, width } = lineStyle(Math.ceil(shown / stride));
  // bright lines pile up faster on a dark background
  ctx.globalAlpha = dark ? alpha * 0.8 : alpha;
  ctx.lineWidth = width;
  let current = -1;
  for (let k = 0, seen = 0; k < n; k++) {
    const i = order[k];
    if (mask && !mask[i]) continue;
    if (seen++ % stride !== 0) continue;
    if (index[i] !== current) { current = index[i]; ctx.strokeStyle = palette[current]; }
    ctx.beginPath();
    trace(ctx, axes, i, ja, jb, curve);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

const FONT = '11px -apple-system, "system-ui", "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

function pill(ctx, text, x, y, { fill, stroke, color, align = 'left', bold = false }) {
  ctx.font = bold ? `600 ${FONT}` : FONT;
  const w = Math.ceil(ctx.measureText(text).width) + 8, h = 16;
  const left = align === 'left' ? x : x - w;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(left, y - h / 2, w, h, 3); else ctx.rect(left, y - h / 2, w, h);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.lineWidth = 1; ctx.strokeStyle = stroke; ctx.stroke(); }
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, left + 4, y + 0.5);
  return w;
}

/**
 * The overlay: the marked rows (always), and what's hovered: one row with its value on every axis, or all the rows
 * of a tick. `hover` is { rows: [indices], single: bool } or null. The context is already translated by the scroll.
 */
export function drawOverlay(ctx, { axes, colors, rows, marks, curve, dark, surface, height }, hover, x0, x1) {
  if (axes.length < 2) return;
  const [ja, jb] = span(axes, x0, x1);
  const ink = dark ? '#f6f7f9' : '#1c2127';
  const last = axes.length - 1;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const thick = (i, color, width) => {
    ctx.beginPath();
    trace(ctx, axes, i, ja, jb, curve);
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = surface;
    ctx.lineWidth = width + 2.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };

  if (hover && !hover.single) {
    // all the rows of a tick, or a sample of them when they are thousands
    const stride = Math.max(1, Math.ceil(hover.rows.length / HOVER_ROWS));
    const count = Math.ceil(hover.rows.length / stride);
    const { alpha } = lineStyle(count);
    ctx.globalAlpha = Math.min(0.9, alpha * 1.5);
    ctx.lineWidth = count > 600 ? 1 : 1.3;
    const members = new Uint8Array(axes[0].pos.length);
    hover.rows.forEach((i, k) => { if (k % stride === 0) members[i] = 1; });
    let current = -1;
    for (const i of colors.order) {
      if (!members[i]) continue;
      if (colors.index[i] !== current) { current = colors.index[i]; ctx.strokeStyle = colors.palette[current]; }
      ctx.beginPath();
      trace(ctx, axes, i, ja, jb, curve);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // the marked rows, labeled at the right end, without overlapping
  const labels = [];
  for (const mark of marks) {
    const color = mark.color ?? ink;
    thick(mark.row, color, 2.4);
    if (mark.label) labels.push({ text: String(mark.label), color, y: axes[last].pos[mark.row] });
  }
  labels.sort((a, b) => a.y - b.y);
  for (let k = 1; k < labels.length; k++) labels[k].at = Math.max(labels[k].y, (labels[k - 1].at ?? labels[k - 1].y) + 18);
  for (const label of labels) {
    const x = axes[last].x, y = label.at ?? label.y;
    ctx.beginPath();
    ctx.moveTo(x + 2, label.y);
    ctx.lineTo(x + 10, y);
    ctx.strokeStyle = label.color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    pill(ctx, label.text, x + 10, y, { fill: label.color, color: surface, bold: true });
  }

  if (hover?.single) {
    const i = hover.rows[0];
    const color = colors.palette[colors.index[i]];
    thick(i, color, 2.8);
    for (let j = ja; j <= jb; j++) {
      const axis = axes[j];
      const y = axis.pos[i];
      ctx.beginPath();
      ctx.arc(axis.x, y, 4, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = surface;
      ctx.stroke();
    }
    // the true values, next to the dots
    for (let j = ja; j <= jb; j++) {
      const axis = axes[j];
      const text = formatValue(axis.column, rows[i].values?.[axis.key]);
      const y = Math.min(height - 10, Math.max(10, axis.pos[i] - 13));
      pill(ctx, text.length > 22 ? `${text.slice(0, 21)}…` : text, axis.x + 6, y, {
        fill: surface, stroke: dark ? 'rgba(255, 255, 255, 0.3)' : 'rgba(17, 20, 24, 0.3)', color: ink, bold: true,
      });
    }
  }
}
