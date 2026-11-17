// Comparing more than two images: the anchor (the image the others are compared with) and the others, each in its tile.
// The layout of the tiles, the colors of their labels, and how far apart the images are.

// The labels of the images without a `color`: like the first two (image-viewer.css), then magenta, teal, violet, gray
export const TILE_COLORS = ['#2d72d2', '#9752fe', '#cf0494', '#0ea2ac', '#5e17cd'];
const TILE_TEXT = ['#fff', '#fff', '#fff', '#111418', '#fff'];
export const tileColor = (image, index) => ({
  color: image?.color ?? TILE_COLORS[index] ?? '#738091',
  textColor: image?.textColor ?? (image?.color ? '#fff' : TILE_TEXT[index] ?? '#fff'),
});

// What to call an image: its label, else "new", "reference", then "image 3"...
export const tileName = (image, index) => image?.label ?? (index === 0 ? 'new' : index === 1 ? 'reference' : `image ${index + 1}`);

// An image we can load: placeholders (e.g. { label, loading: true } while the app looks for it, or { label, missing })
// keep their tile, so that the tiles don't move when the image comes
export const hasSource = image => !!(image?.url || image?.iiif);

// The grid that shows `count` tiles the largest, in `available` px of width and at most `maxHeight` px of height.
// aspect: the tiles' height / width. columns: forced, e.g. a single row.
export const gridLayout = ({ count, available, maxHeight, aspect, gap = 4, columns: forced = null }) => {
  const fit = (columns, rows) => Math.floor(Math.max(0, Math.min(
    (available - (columns - 1) * gap) / columns,
    (maxHeight - (rows - 1) * gap) / rows / aspect,
  )));
  let best = null;
  for (let columns = 1; columns <= Math.max(1, count); columns++) {
    if (forced && columns !== Math.min(forced, count)) continue;
    const rows = Math.ceil(count / columns);
    const width = fit(columns, rows);
    // as large, in fewer rows: the images are easier to compare next to each other
    if (!best || width > best.width || (width === best.width && rows < best.rows)) best = { columns, rows, width };
  }
  const height = Math.floor(best.width * aspect);
  return {
    ...best,
    height,
    stageWidth: best.columns * best.width + (best.columns - 1) * gap,
    stageHeight: best.rows * height + (best.rows - 1) * gap,
    slot: index => ({
      left: (index % best.columns) * (best.width + gap),
      top: Math.floor(index / best.columns) * (height + gap),
    }),
  };
};

// The next image to show alone, among those we can show
export const nextShown = (images, current, step = 1) => {
  const count = images.length;
  for (let i = 1; i <= count; i++) {
    const index = (((current + step * i) % count) + count) % count;
    if (hasSource(images[index])) return index;
  }
  return current;
};

// The pixels a canvas shows, or null (nothing drawn, or an image from another origin without CORS headers)
export const readCanvas = canvas => {
  if (!canvas?.width || !canvas?.height) return null;
  try {
    return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }
};

// Whether two views of the same size show the same pixels: all of them
const sameViews = (a, b) => {
  const pixels_a = new Uint32Array(a.data.buffer, a.data.byteOffset, a.data.byteLength >> 2);
  const pixels_b = new Uint32Array(b.data.buffer, b.data.byteOffset, b.data.byteLength >> 2);
  for (let i = 0; i < pixels_a.length; i++) if (pixels_a[i] !== pixels_b[i]) return false;
  return true;
};

// How far apart two views of the same size are: the mean absolute difference of their colors, in levels (0-255).
// 0 only when every pixel is the same. Else we sample at most ~`samples` pixels: it's a guide, computed as users zoom
// and pan. Views that differ in a few pixels the sample misses are not 0: they show as "<0.1".
export const meanDifference = (a, b, samples = 60000) => {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return null;
  const pixels = a.width * a.height;
  if (pixels === 0) return null;
  if (sameViews(a, b)) return 0;
  // not a divisor of the width: we would sample columns
  let stride = Math.max(1, Math.floor(pixels / samples));
  while (stride > 1 && a.width % stride === 0) stride += 1;
  let sum = 0;
  let count = 0;
  for (let p = 0; p < pixels; p += stride) {
    const i = 4 * p;
    sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    count += 3;
  }
  return Math.max(sum / count, Number.MIN_VALUE);
};

// matrix[i][j]: how far apart the views i and j are, null when we can't tell. With `from`, only that row and column.
export const distanceMatrix = (views, from = null) => views.map((a, i) => views.map((b, j) => {
  if (i === j) return 0;
  if (from !== null && i !== from && j !== from) return null;
  return meanDifference(a, b);
}));

export const formatDistance = value => value === null || value === undefined ? '–' : value === 0 ? 'same' : value < 0.05 ? '<0.1' : value.toFixed(1);
