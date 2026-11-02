// Reading what the browser displays of a video: its current frame, as 8-bit RGB after the browser converted it
// (from Y'CbCr, with the color matrix it guesses). The decoded values are the server's (see VideoViewer.jsx).

let pixel_context = null;
const pixelContext = () => {
  if (!pixel_context) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    pixel_context = canvas.getContext('2d', { willReadFrequently: true });
  }
  return pixel_context;
};

const HAVE_CURRENT_DATA = 2;

export const hasFrame = video => !!video && video.readyState >= HAVE_CURRENT_DATA && video.videoWidth > 0;

// The displayed [r, g, b, a] of a pixel of the current frame, or null (no frame yet, or no CORS headers)
export const displayPixel = (video, x, y) => {
  if (!hasFrame(video) || x < 0 || y < 0 || x >= video.videoWidth || y >= video.videoHeight) return null;
  try {
    const context = pixelContext();
    if (!context) return null;
    context.clearRect(0, 0, 1, 1);
    context.drawImage(video, x, y, 1, 1, 0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  } catch {
    return null;
  }
};

// The displayed RGBA values of a region of the current frame ({ x0, y0, x1, y1 }, excluded), or null
export const displayRegion = (video, { x0, y0, x1, y1 }) => {
  if (!hasFrame(video)) return null;
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(video, x0, y0, width, height, 0, 0, width, height);
    return context.getImageData(0, 0, width, height).data;
  } catch {
    return null;
  }
};

// The current frame in a canvas at most `max_width` wide (histograms, minimap), or null
export const frameCanvas = (video, max_width = 640, canvas = document.createElement('canvas')) => {
  if (!hasFrame(video)) return null;
  const scale = Math.min(1, max_width / video.videoWidth);
  const width = Math.max(1, Math.round(video.videoWidth * scale));
  const height = Math.max(1, Math.round(video.videoHeight * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  try {
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, width, height);
  } catch {
    return null;
  }
  return canvas;
};
