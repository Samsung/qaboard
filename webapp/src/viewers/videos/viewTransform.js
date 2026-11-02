// Zoom and pan, shared by the videos of a comparison.
// A view is {zoom, cx, cy}: zoom is relative to the video fitting its pane, and (cx, cy) is the point of the video
// shown at the center of the pane, in [0, 1] video coordinates. It doesn't depend on the panes' size, so it survives
// resizes and layout changes, and it applies to videos of different resolutions (e.g. an input and its upscaled
// output): they show the same region.

export const FIT = { zoom: 1, cx: 0.5, cy: 0.5 };

const clamp = (x, min, max) => Math.min(max, Math.max(min, x));

// Where the video shows at zoom 1, in pane coordinates ("contain")
export const fitRect = (pane, media) => {
  if (!media?.width || !media?.height || !pane.width || !pane.height)
    return { x: 0, y: 0, width: pane.width, height: pane.height };
  const scale = Math.min(pane.width / media.width, pane.height / media.height);
  const width = media.width * scale;
  const height = media.height * scale;
  return { x: (pane.width - width) / 2, y: (pane.height - height) / 2, width, height };
};

// native: the zoom where a video pixel is a CSS pixel
export const zoomLimits = (pane, media) => {
  const fit = fitRect(pane, media);
  const native = media?.width && fit.width ? media.width / fit.width : 1;
  return { min: Math.min(1, native), max: Math.max(4, 32 * native), native };
};

// Along an axis: where the video starts, given the point we want at the center.
// Zoomed in, the video always covers the pane. Smaller than the pane, it's centered.
const axis = (paneSize, contentSize, center) => {
  if (contentSize <= paneSize + 1e-6) return { offset: (paneSize - contentSize) / 2, center: 0.5 };
  const half = paneSize / 2 / contentSize;
  const c = clamp(center, half, 1 - half);
  return { offset: paneSize / 2 - c * contentSize, center: c };
};

export const clampView = (view, pane, media) => {
  const { min, max } = zoomLimits(pane, media);
  const zoom = clamp(view.zoom, min, max);
  const fit = fitRect(pane, media);
  return {
    zoom,
    cx: axis(pane.width, fit.width * zoom, view.cx).center,
    cy: axis(pane.height, fit.height * zoom, view.cy).center,
  };
};

// The CSS transform of a box of size (width, height) at the pane's top-left: translate(x, y) scale(scale)
export const transformOf = (view, pane, media) => {
  const fit = fitRect(pane, media);
  const x = axis(pane.width, fit.width * view.zoom, view.cx);
  const y = axis(pane.height, fit.height * view.zoom, view.cy);
  return { x: x.offset, y: y.offset, scale: view.zoom, width: fit.width, height: fit.height };
};

// The video point under a pane point, in [0, 1] video coordinates
export const videoPointAt = (point, view, pane, media) => {
  const t = transformOf(view, pane, media);
  return {
    u: (point.x - t.x) / (t.width * t.scale),
    v: (point.y - t.y) / (t.height * t.scale),
  };
};

// Zoom, keeping the video point under `point` where it is
export const zoomAt = (view, factor, point, pane, media) => {
  const { min, max } = zoomLimits(pane, media);
  const zoom = clamp(view.zoom * factor, min, max);
  const fit = fitRect(pane, media);
  const { u, v } = videoPointAt(point, view, pane, media);
  return clampView({
    zoom,
    cx: u - (point.x - pane.width / 2) / (fit.width * zoom),
    cy: v - (point.y - pane.height / 2) / (fit.height * zoom),
  }, pane, media);
};

export const zoomTo = (view, zoom, pane, media) =>
  zoomAt(view, zoom / view.zoom, { x: pane.width / 2, y: pane.height / 2 }, pane, media);

// Move the video by (dx, dy) CSS pixels
export const panBy = (view, dx, dy, pane, media) => {
  const t = transformOf(view, pane, media);
  return clampView({
    zoom: view.zoom,
    cx: (pane.width / 2 - t.x - dx) / (t.width * t.scale),
    cy: (pane.height / 2 - t.y - dy) / (t.height * t.scale),
  }, pane, media);
};

// The view that shows a region of the video ({ x, y, w, h } in its pixels), with a margin around
export const fitRegion = (region, pane, media, margin = 0.85) => {
  if (!media?.width || !region?.w || !region?.h) return FIT;
  const fit = fitRect(pane, media);
  const scale = fit.width / media.width;
  const zoom = margin * Math.min(pane.width / (region.w * scale), pane.height / (region.h * scale));
  return clampView({
    zoom,
    cx: (region.x + region.w / 2) / media.width,
    cy: (region.y + region.h / 2) / media.height,
  }, pane, media);
};

// Where a region of the video ({ x, y, w, h } in its pixels) shows in the pane, in CSS pixels
export const regionRect = (region, view, pane, media) => {
  const t = transformOf(view, pane, media);
  const sx = t.width * t.scale / media.width;
  const sy = t.height * t.scale / media.height;
  return { left: t.x + region.x * sx, top: t.y + region.y * sy, width: region.w * sx, height: region.h * sy };
};
