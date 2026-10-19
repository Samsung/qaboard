// A tiny IIIF image server for the tests, with images computed from functions: (x, y) => [r, g, b]
// https://iiif.io/api/image/2.1/#image-request-uri-syntax
import { deflateSync } from 'node:zlib';

const crc_table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buffer => {
  let c = 0xffffffff;
  for (const byte of buffer) c = crc_table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

// An 8-bit RGB PNG
export const png = (width, height, pixel) => {
  const raw = Buffer.alloc((3 * width + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw.set([r, g, b], y * (3 * width + 1) + 1 + 3 * x);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

export const info = (id, { width, height }) => ({
  '@context': 'http://iiif.io/api/image/2/context.json',
  // like servers behind a proxy, it doesn't know its public URL
  '@id': `http://internal:8182/iiif/2/${id}`,
  protocol: 'http://iiif.io/api/image',
  width,
  height,
  profile: ['http://iiif.io/api/image/2/level2.json'],
  tiles: [{ width: 256, scaleFactors: [1, 2, 4, 8] }],
});

// The response to an IIIF request, e.g. "0,0,256,256/128,/0/default.png", for an image { width, height, pixel }
export const tile = (request, { width, height, pixel }) => {
  const [region, size] = request.split('/');
  const [x, y, w, h] = region === 'full' ? [0, 0, width, height] : region.split(',').map(Number);
  let [sw, sh] = size === 'full' || size === 'max' ? [w, h] : size.split(',').map(v => v === '' ? NaN : Number(v));
  if (Number.isNaN(sh)) sh = Math.round(sw * h / w);
  if (Number.isNaN(sw)) sw = Math.round(sh * w / h);
  return png(sw, sh, (i, j) => pixel(Math.min(width - 1, x + Math.floor((i + 0.5) * w / sw)), Math.min(height - 1, y + Math.floor((j + 0.5) * h / sh))));
};
