// The images' own values (raw, 16-bit, float...), from the app's getPixels, by tiles of 64x64 pixels.
//
// Hovering the same tile again, or zooming on it, doesn't ask again. The first request can be slow, e.g. the server
// decodes the image: we ask for the tile under the pointer as soon as it enters the image, and while one request for the
// pixel under the pointer is in flight, only the latest of the next ones is sent.
import { imageKey } from './sources';

export const TILE = 64;
// tiles of all images, about 12 MB of 16-bit RGB
const MAX_TILES = 512;
// a tile that failed is asked again after
const RETRY_AFTER_MS = 10_000;

// getPixels resolves to { values } (rows of pixels, each a number or an array of channels, like numpy's tolist())
// or { data, width, height, channels? } (a flat array, e.g. a typed array). Returns { w, h, channels, data }.
export const normalizePixels = result => {
  if (result?.data && result.width && result.height) {
    const { data, width: w, height: h } = result;
    return { w, h, channels: result.channels ?? Math.max(1, Math.round(data.length / (w * h))), data };
  }
  const rows = result?.values ?? [];
  const h = rows.length;
  const w = h > 0 ? rows[0].length : 0;
  const first = w > 0 ? rows[0][0] : 0;
  const channels = Array.isArray(first) ? first.length : 1;
  const data = [];
  for (const row of rows)
    for (const pixel of row) {
      if (channels === 1) data.push(Array.isArray(pixel) ? pixel[0] : pixel);
      else for (let c = 0; c < channels; c++) data.push(pixel?.[c] ?? null);
    }
  return { w, h, channels, data };
};

export class PixelTiles {
  constructor() {
    this.getPixels = null;
    // key => { status: 'loading' | 'ready' | 'error', x, y, w, h, channels, data, mode, error, abort, time }
    this.tiles = new Map();
    // image key => { busy, next }: the requests for the pixel under the pointer
    this.latest = new Map();
    // image key => what the values are, e.g. "I;16"
    this.modes = new Map();
    this.listeners = new Set();
    this.version = 0;
  }

  // The latest of the app's function: the tiles we have stay (they're keyed by image)
  setGetPixels(getPixels) {
    this.getPixels = getPixels ?? null;
  }

  subscribe = listener => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getVersion = () => this.version;
  notify() {
    this.version++;
    this.listeners.forEach(listener => listener());
  }

  dispose() {
    for (const tile of this.tiles.values()) tile.abort?.abort();
    this.tiles.clear();
    this.latest.clear();
  }

  key(image, tx, ty) {
    return `${imageKey(image)}|${tx}|${ty}`;
  }

  // The values of the pixel (x, y): an array, undefined while unknown, or null if they can't be read
  get(image, x, y) {
    if (!image) return undefined;
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    const key = this.key(image, tx, ty);
    const tile = this.tiles.get(key);
    if (!tile || tile.status === 'loading') return undefined;
    if (tile.status === 'error') return null;
    // recently used
    this.tiles.delete(key);
    this.tiles.set(key, tile);
    const i = x - tile.x;
    const j = y - tile.y;
    if (i < 0 || j < 0 || i >= tile.w || j >= tile.h) return null;
    const k = (j * tile.w + i) * tile.channels;
    return Array.from(tile.data.slice(k, k + tile.channels));
  }

  // What the values are, e.g. "I;16", once a tile was read
  mode(image) {
    return this.modes.get(imageKey(image)) ?? null;
  }

  // Why the values can't be read, if they can't
  error(image) {
    const prefix = `${imageKey(image)}|`;
    for (const [key, tile] of this.tiles)
      if (tile.status === 'error' && key.startsWith(prefix)) return tile.error;
    return null;
  }

  loading(image) {
    const prefix = `${imageKey(image)}|`;
    for (const [key, tile] of this.tiles)
      if (tile.status === 'loading' && key.startsWith(prefix)) return true;
    return false;
  }

  // Asks for the tiles that cover a region of the image ({ x0, y0, x1, y1 }, x1 and y1 excluded), if we don't have
  // them. size: the image's { width, height }.
  request(image, size, { x0, y0, x1, y1 }) {
    if (!this.getPixels || !image || !size?.width) return [];
    const tiles = [];
    for (let ty = Math.floor(Math.max(0, y0) / TILE); ty * TILE < Math.min(y1, size.height); ty++)
      for (let tx = Math.floor(Math.max(0, x0) / TILE); tx * TILE < Math.min(x1, size.width); tx++)
        tiles.push(this.fetchTile(image, size, tx, ty));
    return tiles;
  }

  // The tile of the pixel under the pointer: while one is in flight, only the latest of the next ones is sent
  requestLatest(image, size, x, y) {
    if (!this.getPixels || !image || !size?.width) return;
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    const current = this.tiles.get(this.key(image, tx, ty));
    if (current && (current.status !== 'error' || Date.now() - current.time < RETRY_AFTER_MS)) return;
    const slot_key = imageKey(image);
    const slot = this.latest.get(slot_key) ?? { busy: false, next: null };
    this.latest.set(slot_key, slot);
    if (slot.busy) {
      slot.next = { tx, ty };
      return;
    }
    const run = (tx, ty) => {
      slot.busy = true;
      this.fetchTile(image, size, tx, ty).finally(() => {
        slot.busy = false;
        const next = slot.next;
        slot.next = null;
        if (next && this.latest.get(slot_key) === slot) run(next.tx, next.ty);
      });
    };
    run(tx, ty);
  }

  fetchTile(image, size, tx, ty) {
    const key = this.key(image, tx, ty);
    const existing = this.tiles.get(key);
    if (existing && (existing.status !== 'error' || Date.now() - existing.time < RETRY_AFTER_MS)) return existing.promise ?? Promise.resolve();
    const region = { x: tx * TILE, y: ty * TILE, w: Math.min(TILE, size.width - tx * TILE), h: Math.min(TILE, size.height - ty * TILE) };
    const abort = new AbortController();
    const tile = { status: 'loading', ...region, abort, time: Date.now() };
    this.tiles.set(key, tile);
    this.evict();
    tile.promise = Promise.resolve()
      .then(() => this.getPixels(image, region, { signal: abort.signal }))
      .then(result => {
        if (this.tiles.get(key) !== tile) return;
        Object.assign(tile, normalizePixels(result), { status: 'ready', abort: null, mode: result?.mode ?? null });
        if (result?.mode) this.modes.set(imageKey(image), result.mode);
        this.notify();
      }, error => {
        if (this.tiles.get(key) !== tile) return;
        if (abort.signal.aborted || error?.name === 'AbortError') {
          this.tiles.delete(key);
          return;
        }
        Object.assign(tile, { status: 'error', abort: null, error: error?.message ?? String(error), time: Date.now() });
        this.notify();
      });
    return tile.promise;
  }

  evict() {
    while (this.tiles.size > MAX_TILES) {
      const [key, tile] = this.tiles.entries().next().value;
      tile.abort?.abort();
      this.tiles.delete(key);
    }
  }
}
