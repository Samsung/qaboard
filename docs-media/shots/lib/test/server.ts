// A local server for the lib's tests: fixture pages, OpenSeadragon and Plotly from node_modules, a fake IIIF server
// whose tiles arrive late, and a slow API.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';

const here = path.dirname(fileURLToPath(import.meta.url));
const nodeModules = path.resolve(here, '..', '..', 'node_modules');
const VENDOR: Record<string, string> = {
  '/vendor/openseadragon.min.js': path.join(nodeModules, 'openseadragon', 'build', 'openseadragon', 'openseadragon.min.js'),
  '/vendor/plotly.min.js': path.join(nodeModules, 'plotly.js-dist-min', 'plotly.min.js'),
};

// A PNG of solid-ish color, without dependencies
export function png(width: number, height: number, color: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) raw.set(color(x, y), row + 1 + x * 3);
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const IMAGE = { width: 4096, height: 3072, tile: 512 };

export interface FixtureServer {
  url: string;
  stats: { tilesRequested: number; tilesServed: number; inflight: number };
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function startServer(): Promise<FixtureServer> {
  const stats = { tilesRequested: 0, tilesServed: 0, inflight: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    stats.inflight++;
    try {
      if (VENDOR[url.pathname]) {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(fs.readFileSync(VENDOR[url.pathname]));
        return;
      }
      // like QA-Board's login form: a session cookie for the right password
      if (url.pathname === '/api/v1/user/auth/' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const form = new URLSearchParams(body);
        const ok = form.get('password') === 'kitefin-demo';
        res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json', ...(ok ? { 'set-cookie': `session=${form.get('username')}; Path=/` } : {}) });
        res.end(JSON.stringify({ login_success: ok }));
        return;
      }
      if (url.pathname === '/api/slow') {
        await sleep(Number(url.searchParams.get('ms') ?? 800));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // IIIF Image API 2: /iiif/2/<identifier>/info.json and /iiif/2/<identifier>/<region>/<size>/0/default.jpg
      const iiif = /^\/iiif\/2\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (iiif) {
        const [, identifier, rest] = iiif;
        if (rest === 'info.json') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            '@context': 'http://iiif.io/api/image/2/context.json',
            '@id': `http://${req.headers.host}/iiif/2/${identifier}`,
            protocol: 'http://iiif.io/api/image',
            width: IMAGE.width,
            height: IMAGE.height,
            tiles: [{ width: IMAGE.tile, scaleFactors: [1, 2, 4, 8] }],
            profile: ['http://iiif.io/api/image/2/level1.json'],
          }));
          return;
        }
        stats.tilesRequested++;
        const [region, size] = rest.split('/');
        const [rx, ry, rw, rh] = region === 'full' ? [0, 0, IMAGE.width, IMAGE.height] : region.split(',').map(Number);
        const width = Math.max(1, Number(size.split(',')[0]) || rw);
        const height = Math.max(1, Math.round((width * rh) / rw));
        // late tiles, each its own delay: the waits must see them all
        await sleep(150 + ((rx * 7 + ry * 13) % 300));
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(png(width, height, (x, y) => {
          const gx = Math.floor((rx + (x * rw) / width) / 256);
          const gy = Math.floor((ry + (y * rh) / height) / 256);
          return (gx + gy) % 2 ? [40, 90, 160] : [230, 180, 60];
        }));
        stats.tilesServed++;
        return;
      }
      const file = path.join(here, 'fixtures', path.basename(url.pathname === '/' ? 'app.html' : url.pathname));
      if (fs.existsSync(file)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(file));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    } finally {
      stats.inflight--;
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stats,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
