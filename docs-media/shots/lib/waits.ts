// Waiting until a page is settled (docs-media/README.md#determinism):
// fonts, network quiet, no spinners, OpenSeadragon tiles drawn, Plotly graphs quiet.
import type { Page, Request } from '@playwright/test';

export interface WaitOptions { timeout?: number }

export const DEFAULT_TIMEOUT = 45_000;
export const NETWORK_QUIET_MS = 500;
export const TILES_QUIET_MS = 750;
export const PLOTS_QUIET_MS = 300;
// A request still in flight after that long is long-polling (or stuck): it doesn't keep the page busy
export const LONG_POLL_MS = 10_000;

// progress bars that stopped animating are done, e.g. "Where they differ, in all runs" once every run is compared
const SPINNERS = '.bp6-spinner, .bp6-skeleton, .bp6-progress-bar:not(.bp6-no-animation), .qiv-spinner';
const IIIF = /\/iiif\//;
// Requests that never count: dev servers' sockets and pings
const IGNORED_URLS = [/^data:/, /^blob:/, /\/@vite\/client/, /\/__vite_ping/, /\/sockjs-node/];

interface InFlight { url: string; start: number; warned?: boolean }

/** Tracks the page's requests from the start, so waits know what's in flight and when the network was last busy. */
export class NetworkTracker {
  private inflight = new Map<Request, InFlight>();
  lastActivity = Date.now();
  lastIiifActivity = Date.now();

  constructor(page: Page) {
    page.on('request', request => {
      if (this.ignored(request)) return;
      this.inflight.set(request, { url: request.url(), start: Date.now() });
      this.touch(request.url());
    });
    const done = (request: Request) => {
      if (!this.inflight.delete(request)) return;
      this.touch(request.url());
    };
    page.on('requestfinished', done);
    page.on('requestfailed', done);
    // What a page does right after loading (timers, lazy rendering) must have time to start
    page.on('domcontentloaded', () => this.touch(page.url()));
    page.on('load', () => this.touch(page.url()));
  }

  private ignored(request: Request) {
    const type = request.resourceType();
    if (type === 'websocket' || type === 'eventsource') return true;
    return IGNORED_URLS.some(re => re.test(request.url()));
  }

  private touch(url: string) {
    this.lastActivity = Date.now();
    if (IIIF.test(url)) this.lastIiifActivity = Date.now();
  }

  /** Requests in flight, without the long-polling ones */
  pending(filter?: RegExp): InFlight[] {
    const now = Date.now();
    const pending: InFlight[] = [];
    for (const r of this.inflight.values()) {
      if (filter && !filter.test(r.url)) continue;
      if (now - r.start > LONG_POLL_MS) {
        if (!r.warned) console.warn(`[shots] ignoring a request in flight for over ${LONG_POLL_MS / 1000}s: ${r.url}`);
        r.warned = true;
        continue;
      }
      pending.push(r);
    }
    return pending;
  }

  /** Whether nothing (matching filter) was in flight for quietMs */
  quiet(quietMs: number, filter?: RegExp): boolean {
    const last = filter === IIIF ? this.lastIiifActivity : this.lastActivity;
    return this.pending(filter).length === 0 && Date.now() - last >= quietMs;
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Polls `check` until it returns true. Returns whether it had to wait.
async function until(what: () => string, check: () => Promise<boolean> | boolean, timeout: number, interval = 50): Promise<boolean> {
  const deadline = Date.now() + timeout;
  let waited = false;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`[shots] timed out after ${timeout} ms waiting for ${what()}`);
    waited = true;
    await sleep(interval);
  }
  return waited;
}

export async function fontsReady(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

export async function networkIdle(page: Page, tracker: NetworkTracker, opts: WaitOptions & { quietMs?: number } = {}): Promise<boolean> {
  const quietMs = opts.quietMs ?? NETWORK_QUIET_MS;
  return until(
    () => `the network to be quiet for ${quietMs} ms; in flight: ${tracker.pending().map(r => r.url).join(', ') || 'none'}`,
    () => tracker.quiet(quietMs),
    opts.timeout ?? DEFAULT_TIMEOUT,
  );
}

// Visible spinners, skeletons and progress bars, except in masked elements, and the spinners that say a run is running
// (its status, "Running" tags): they stay as long as the run runs, a page with one is loaded
export async function spinners(page: Page): Promise<number> {
  return page.evaluate(selector => {
    const visible = (el: Element) => {
      if (el.closest('[data-shot-mask]')) return false;
      if (el.closest('[aria-label="Running"], .bp6-tag')) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
    };
    return [...document.querySelectorAll(selector)].filter(visible).length;
  }, SPINNERS);
}

export async function noSpinners(page: Page, opts: WaitOptions = {}): Promise<boolean> {
  let count = 0;
  return until(
    () => `${count} spinners, skeletons or progress bars (${SPINNERS}) to disappear`,
    async () => (count = await spinners(page)) === 0,
    opts.timeout ?? DEFAULT_TIMEOUT,
    100,
  );
}

// OpenSeadragon viewers that haven't drawn yet: their canvas is still blank.
// The web app can also flag viewers with data-shot-tiles="loading" (the proposed fix to expose fully-loaded-change).
export async function undrawnViewers(page: Page): Promise<number> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const drawn = (container: Element) => {
      const canvas = container.querySelector('canvas');
      if (!canvas) {
        // HTML drawer: tiles are <img>
        const images = [...container.querySelectorAll('img')];
        return images.length > 0 && images.every(img => img.complete && img.naturalWidth > 0);
      }
      if (canvas.width === 0 || canvas.height === 0) return false;
      try {
        const probe = document.createElement('canvas');
        probe.width = 32;
        probe.height = 32;
        const ctx = probe.getContext('2d')!;
        ctx.drawImage(canvas, 0, 0, 32, 32);
        const data = ctx.getImageData(0, 0, 32, 32).data;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
        return false;
      } catch {
        return true; // a tainted canvas can't be read: assume it's drawn
      }
    };
    const loading = document.querySelectorAll('[data-shot-tiles="loading"]').length;
    const viewers = [...document.querySelectorAll('.openseadragon-canvas')].filter(visible);
    return loading + viewers.filter(v => !drawn(v)).length;
  });
}

export async function tiles(page: Page, tracker: NetworkTracker, opts: WaitOptions = {}): Promise<boolean> {
  let undrawn = 0;
  return until(
    () => `IIIF tiles: ${tracker.pending(IIIF).length} requests in flight, ${undrawn} viewers not drawn`,
    async () => tracker.quiet(TILES_QUIET_MS, IIIF) && (undrawn = await undrawnViewers(page)) === 0,
    opts.timeout ?? DEFAULT_TIMEOUT,
  );
}

// Plotly graphs: every .js-plotly-plot has _fullLayout, and no plotly_afterplot event for PLOTS_QUIET_MS.
// Listeners are attached with gd.on the first time a graph is seen.
export async function plotsState(page: Page): Promise<{ graphs: number; unready: number; quietMs: number }> {
  return page.evaluate(() => {
    type Graph = HTMLElement & { _fullLayout?: unknown; on?: (event: string, cb: () => void) => void; __shotWatched?: boolean };
    const w = window as unknown as { __shotPlots?: { last: number } };
    const state = (w.__shotPlots ??= { last: Date.now() });
    const graphs = [...document.querySelectorAll<Graph>('.js-plotly-plot')];
    let unready = 0;
    for (const gd of graphs) {
      if (!gd._fullLayout || typeof gd.on !== 'function') {
        unready++;
        continue;
      }
      if (!gd.__shotWatched) {
        gd.__shotWatched = true;
        state.last = Date.now();
        gd.on('plotly_afterplot', () => { state.last = Date.now(); });
      }
    }
    return { graphs: graphs.length, unready, quietMs: Date.now() - state.last };
  });
}

export async function plots(page: Page, opts: WaitOptions = {}): Promise<boolean> {
  let state = { graphs: 0, unready: 0, quietMs: 0 };
  return until(
    () => `Plotly graphs: ${state.unready} of ${state.graphs} not drawn, last redraw ${state.quietMs} ms ago`,
    async () => {
      state = await plotsState(page);
      return state.graphs === 0 || (state.unready === 0 && state.quietMs >= PLOTS_QUIET_MS);
    },
    opts.timeout ?? DEFAULT_TIMEOUT,
  );
}

/**
 * The default wait, after navigation and after actions. Repeats the checks until a pass where nothing had to wait:
 * drawing tiles or plots can start new requests.
 */
export async function settle(page: Page, tracker: NetworkTracker, opts: WaitOptions = {}): Promise<void> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const deadline = Date.now() + timeout;
  const left = () => Math.max(1, deadline - Date.now());
  for (;;) {
    await fontsReady(page);
    const waited = [
      await networkIdle(page, tracker, { timeout: left() }),
      await noSpinners(page, { timeout: left() }),
      await tiles(page, tracker, { timeout: left() }),
      await plots(page, { timeout: left() }),
    ];
    if (!waited.some(Boolean)) return;
    if (Date.now() > deadline) throw new Error(`[shots] the page didn't settle within ${timeout} ms`);
  }
}
