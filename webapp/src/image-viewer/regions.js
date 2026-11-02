// Regions of interest: { x, y, w, h, label?, color?, imageWidth?, imageHeight? }
// x, y, w and h are pixels of an image of size imageWidth x imageHeight, by default the image shown. Regions defined
// on an input image are shown at the same place on outputs of another resolution, e.g. downscaled.
//
// Sets of regions: { id, label, regions?, loading?, error?, load?(), description? }
// `load` finds the regions on demand, e.g. by asking a server, when users pick the set.

export const FULL_IMAGE = 'full';

// The region in the pixels of an image of size { width, height }
export const scaleRegion = (region, size) => {
  const sx = size?.width && region.imageWidth ? size.width / region.imageWidth : 1;
  const sy = size?.height && region.imageHeight ? size.height / region.imageHeight : 1;
  return { x: region.x * sx, y: region.y * sy, w: region.w * sx, h: region.h * sy };
};

// The part of the region inside the image, or null if there is none
export const clipRegion = (region, size) => {
  if (![region?.x, region?.y, region?.w, region?.h].every(Number.isFinite)) return null;
  const { x, y, w, h } = scaleRegion(region, size);
  // regions with a negative size go left or up
  const x0 = Math.max(0, Math.min(x, x + w));
  const y0 = Math.max(0, Math.min(y, y + h));
  const x1 = Math.min(size.width, Math.max(x, x + w));
  const y1 = Math.min(size.height, Math.max(y, y + h));
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

// OpenSeadragon's viewport rectangle for a region: viewport coordinates go from 0 to 1 across the image's width
export const regionToViewport = (region, size) => {
  const clipped = clipRegion(region, size);
  if (!clipped) return null;
  const { x, y, w, h } = clipped;
  return { x: x / size.width, y: y / size.width, width: w / size.width, height: h / size.width };
};

// The region of the image that a viewport rectangle shows, clipped to the image
export const viewportToRegion = (bounds, size) => {
  const region = {
    x: bounds.x * size.width,
    y: bounds.y * size.width,
    w: bounds.width * size.width,
    h: bounds.height * size.width,
  };
  return clipRegion(region, size);
};

// What users paste in their input's metadata, or in the configuration, to make it a preset
export const regionAsYaml = (region, size) => {
  const { x, y, w, h } = region;
  return [
    `width: ${size.width}`,
    `height: ${size.height}`,
    `- {x: ${Math.round(x)}, y: ${Math.round(y)}, w: ${Math.round(w)}, h: ${Math.round(h)}, label: "${region.label ?? ''}"}`,
  ].join('\n');
};

// Regions with the same coordinates and label are shown once
export const uniqueRegions = regions => {
  const seen = new Set();
  return regions.filter(region => {
    const key = [region.x, region.y, region.w, region.h, region.label, region.imageWidth, region.imageHeight].join(' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
