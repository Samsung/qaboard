// The images the viewer shows. An image is
//   - a string: the URL of an image the browser can decode (PNG, JPEG, WebP...), loaded at once
//   - { url }: the same
//   - { iiif }: the URL of an IIIF Image API service, i.e. without "/info.json": the image is streamed tile by tile,
//     for large images (https://iiif.io/api/image/)
// with optional fields:
//   - label: shown on the image, e.g. "new" or "reference"
//   - href: a link to the original file, to open it
// and any other field the app needs back in its callbacks, e.g. getPixels(image, region).
//
// Images served from another origin need CORS headers (Access-Control-Allow-Origin): the viewer reads the pixels
// it displays for the difference, the values under the pointer and the histograms.

export const normalizeImage = image => {
  if (!image) return null;
  if (typeof image === 'string') return { url: image };
  return image;
};

// What identifies an image: when it changes, the viewer loads another image
export const imageKey = image => {
  const normalized = normalizeImage(image);
  if (!normalized) return null;
  return normalized.iiif ? `iiif:${normalized.iiif}` : `url:${normalized.url}`;
};

// The URL of the IIIF service of `identifier` (e.g. a file path) on an IIIF server, e.g.
//   iiifUrl('https://example.com/iiif/2/', 'runs/1/out.png') => 'https://example.com/iiif/2/runs%2F1%2Fout.png'
// The IIIF specification requires encoding the slashes of identifiers.
export const iiifUrl = (server, identifier) =>
  `${server}${identifier.split('/').map(encodeURIComponent).join('%2F')}`;

// The tile format we ask for. PNG keeps the values exact, JPEG would change them: we use it only if the server
// doesn't serve PNG.
export const iiifTileFormat = info => {
  const profiles = [].concat(info?.profile ?? []);
  const level2 = profiles.some(p => typeof p === 'string' && /level2(\.json)?$/.test(p));
  const formats = [
    ...profiles.flatMap(p => (typeof p === 'object' && p?.formats) || []),
    ...(info?.extraFormats ?? []),
    ...(info?.preferredFormats ?? []),
  ];
  // IIIF v2 servers that don't list formats in their profile (e.g. Cantaloupe) serve PNG
  const lists_formats = profiles.some(p => typeof p === 'object' && Array.isArray(p?.formats));
  if (level2 || formats.includes('png') || !lists_formats) return 'png';
  return 'jpg';
};

// The OpenSeadragon tile source of an IIIF image, from its info.json.
// The URL we know wins over the server's id: servers behind proxies often don't know their public URL.
export const iiifTileSource = (info, url) => ({
  ...info,
  '@id': url,
  id: url,
  preferredFormats: [iiifTileFormat(info)],
});

const loadIiifInfo = async (url, signal) => {
  const info_url = `${url}/info.json`;
  let response;
  try {
    response = await fetch(info_url, { signal, headers: { Accept: 'application/json' } });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw Object.assign(new Error(`Could not reach the image server (${error.message})`), { url: info_url });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw Object.assign(new Error(`The image server answered ${response.status} ${response.statusText}`.trim()), { url: info_url, details: text.slice(0, 500) });
  }
  return response.json();
};

const loadImageSize = (url, signal) => new Promise((resolve, reject) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  const abort = () => {
    img.src = '';
    reject(new DOMException('Aborted', 'AbortError'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  img.onload = () => {
    signal?.removeEventListener('abort', abort);
    resolve({ width: img.naturalWidth, height: img.naturalHeight });
  };
  img.onerror = () => {
    signal?.removeEventListener('abort', abort);
    reject(Object.assign(new Error('Could not load the image'), { url }));
  };
  img.src = url;
});

// Resolves to { width, height, tileSource } for OpenSeadragon. Errors have a `url` to help users debug.
export const openImage = async (image, { signal } = {}) => {
  const normalized = normalizeImage(image);
  if (normalized?.iiif) {
    const info = await loadIiifInfo(normalized.iiif, signal);
    if (!info?.width || !info?.height)
      throw Object.assign(new Error("The image server's info.json has no size"), { url: `${normalized.iiif}/info.json` });
    return { width: info.width, height: info.height, tileSource: iiifTileSource(info, normalized.iiif) };
  }
  if (normalized?.url) {
    const { width, height } = await loadImageSize(normalized.url, signal);
    return {
      width,
      height,
      tileSource: { type: 'image', url: normalized.url, buildPyramid: true, crossOriginPolicy: 'Anonymous' },
    };
  }
  throw new Error('No image: give a URL, { url } or { iiif }');
};

// A small version of the image, or of a region of it, e.g. for the thumbnails of the regions of interest.
// Only for IIIF images: null otherwise.
export const thumbnailUrl = (image, region = null, height = 48) => {
  const normalized = normalizeImage(image);
  if (!normalized?.iiif) return null;
  const area = region
    ? [region.x, region.y, region.w, region.h].map(v => Math.max(0, Math.round(v))).join(',')
    : 'full';
  return `${normalized.iiif}/${area}/,${height}/0/default.jpg`;
};
