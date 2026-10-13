// The only import for shot specs: shot() and clip() register one Playwright test each, named after the shot id.
// See docs-media/README.md#playwright-helpers.
import fs from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page, TestInfo } from '@playwright/test';
import { DEMO_PASSWORD, demo as loadDemo, PROJECT_PERSONAS, type Demo, type ProjectKey } from './demo';
import { callerFile, checkId, isSelected, outDir, sourceSpec, type ShotId } from './ids';
import { anchorsInPercent, cursorInitScript, UiImpl, type Box, type Ui } from './overlay';
import { Recorder } from './record';
import { NetworkTracker, settle } from './waits';

export type { Demo, ProjectKey, View, CommitUrlOptions } from './demo';
export type { ShotId } from './ids';
export type { Ui } from './overlay';
export type { Locator, Page } from '@playwright/test';

export interface ShotOptions {
  project: ProjectKey | null;                          // null: not tied to a demo project (login, What's new)
  url: string | ((demo: Demo) => string);
  alt: string;                                         // required, see website/STYLE.md
  caption?: string;                                    // default caption; pages can override it
  actions?: (ui: Ui) => Promise<void>;
  target?: (page: Page) => Locator | Locator[];        // crop to this element (or these: their union); default: the viewport
  padding?: number;                                    // CSS px around target, default 16
  mask?: (page: Page) => Locator[];                    // painted over with the surrounding background color
  viewport?: { width: number; height: number };        // default 1440x900
  storage?: Record<string, string>;                    // localStorage entries, merged over the defaults
  login?: string | null;                               // persona logged in; default: the project's main author, none without a project
  dedupeTolerance?: number;                            // share of differing pixels still "unchanged", default 0.0005
}

export interface ClipOptions extends Omit<ShotOptions, 'target'> {   // actions: before the recording starts, not drawn
  script: (ui: Ui) => Promise<void>;
  region?: (page: Page) => Locator | Locator[];        // crop the recording to this element's box at start
  poster?: 'first' | 'last' | number;                  // ms into the clip, default 'last'
  loop?: boolean;                                      // the last frame must match the first (landing loops)
}

export const VIEWPORT = { width: 1440, height: 900 };
export const DEFAULT_PADDING = 16;
export const DEFAULT_DEDUPE_TOLERANCE = 0.0005;
export const CLIP_MIN_S = 6;
export const CLIP_MAX_S = 20;
const ALT_MIN = 10;
const ALT_MAX = 300;

// Volatile elements are marked, then hidden: what's behind them (the surrounding background) shows instead
const MASK_ATTRIBUTE = 'data-shot-mask';
const MASK_STYLE = `[${MASK_ATTRIBUTE}], [${MASK_ATTRIBUTE}] * { visibility: hidden !important; }`;

type Kind = 'still' | 'clip';

/** What a capture needs besides its options; shot()/clip() fill it from the test, the lib's tests directly. */
export interface CaptureEnv {
  demo: Demo;
  specFile: string;                                    // absolute path of the spec that registered the shot
  dir?: string;                                        // default out/<area>/<subject>
  contextOptions?: BrowserContextOptions;              // the Playwright project's `use`
  settleTimeout?: number;                              // default: waits.ts's DEFAULT_TIMEOUT
}

const registered = new Set<string>();

function checkOptions(id: string, options: ShotOptions) {
  checkId(id);
  if (!options.alt || options.alt.length < ALT_MIN || options.alt.length > ALT_MAX)
    throw new Error(`[shots] ${id}: alt text is required, ${ALT_MIN}-${ALT_MAX} characters (website/STYLE.md)`);
  if (/^(screenshot|image|picture) of/i.test(options.alt))
    throw new Error(`[shots] ${id}: alt text says what's there, without "screenshot of" (website/STYLE.md)`);
}

/** Registers a still: one Playwright test named after the id, tagged @still (reducedMotion: 'reduce'). */
export function shot(id: ShotId, options: ShotOptions): void {
  checkOptions(id, options);
  if (registered.has(id)) throw new Error(`[shots] ${id} is registered twice`);
  registered.add(id);
  if (!isSelected(id)) return;
  const specFile = callerFile();
  test(id, { tag: '@still' }, async ({ browser }, testInfo) => {
    await captureStill(browser, id, options, envFor(testInfo, specFile));
  });
}

/** Registers a clip: one Playwright test named after the id, tagged @clip (reducedMotion: 'no-preference'). */
export function clip(id: ShotId, options: ClipOptions): void {
  checkOptions(id, options);
  if (registered.has(id)) throw new Error(`[shots] ${id} is registered twice`);
  registered.add(id);
  if (!isSelected(id)) return;
  const specFile = callerFile();
  test(id, { tag: '@clip' }, async ({ browser }, testInfo) => {
    test.setTimeout(Math.max(testInfo.timeout, 180_000));
    await captureClip(browser, id, options, envFor(testInfo, specFile));
  });
}

function envFor(testInfo: TestInfo, specFile: string): CaptureEnv {
  return { demo: loadDemo(), specFile, contextOptions: testInfo.project.use as BrowserContextOptions };
}

// The context options of docs-media/shots/playwright.config.ts, whatever the project
function contextOptions(kind: Kind, base: BrowserContextOptions = {}, viewport?: { width: number; height: number }): BrowserContextOptions {
  return {
    viewport: viewport ?? base.viewport ?? VIEWPORT,
    deviceScaleFactor: base.deviceScaleFactor ?? 2,
    locale: base.locale ?? 'en-US',
    timezoneId: base.timezoneId ?? 'UTC',
    colorScheme: base.colorScheme ?? 'light',
    reducedMotion: kind === 'still' ? 'reduce' : 'no-preference',
    ignoreHTTPSErrors: base.ignoreHTTPSErrors,
  };
}

/**
 * Every page starts with this localStorage (docs-media/README.md#determinism), plus the shot's `storage`:
 * - What's new was seen up to T0's date, so it doesn't pop up (webapp/src/releaseNotes/logic.js accepts a date);
 * - the Controls panel is collapsed.
 */
export function defaultStorage(demo: Demo): Record<string, string> {
  return {
    'qaboard.release-notes.last-seen': demo.t0.toISOString().slice(0, 10),
    'controls-panel-expanded': 'false',
  };
}

async function setupContext(context: BrowserContext, demo: Demo, kind: Kind, storage: Record<string, string>) {
  // localStorage, once per tab: later navigations keep what the app saved
  await context.addInitScript((entries: Record<string, string>) => {
    try {
      if (!/^https?:$/.test(location.protocol) || sessionStorage.getItem('__shot_storage')) return;
      for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
      sessionStorage.setItem('__shot_storage', '1');
    } catch {
      // storage can be unavailable on some documents
    }
  }, storage);
  if (kind === 'clip') await context.addInitScript(cursorInitScript);

  // The demo's links point to *.kitefin.example (RFC 2606): answer them, so they don't render as unreachable.
  // Anything else outside the stack is blocked: captures must not depend on the internet.
  const origin = new URL(demo.baseUrl).origin;
  await context.route(() => true, async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || url.protocol === 'data:' || url.protocol === 'blob:') return route.fallback();
    if (url.hostname === 'kitefin.example' || url.hostname.endsWith('.kitefin.example'))
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>kitefin.example</title>' });
    console.warn(`[shots] blocked a request outside the demo stack: ${url.href}`);
    return route.abort('blockedbyclient');
  });
}

async function openPage(browser: Browser, kind: Kind, id: string, options: ShotOptions, env: CaptureEnv) {
  const context = await browser.newContext(contextOptions(kind, env.contextOptions, options.viewport));
  await setupContext(context, env.demo, kind, { ...defaultStorage(env.demo), ...options.storage });
  const login = options.login === undefined ? (options.project ? PROJECT_PERSONAS[options.project] : null) : options.login;
  if (login) {
    // the session cookie the web app's login form would get
    const response = await context.request.post(`${env.demo.baseUrl}/api/v1/user/auth/`, {
      form: { username: login, password: DEMO_PASSWORD },
    });
    if (!response.ok()) throw new Error(`[shots] could not log in as ${login}: ${response.status()} ${await response.text()}`);
  }
  const page = await context.newPage();
  page.on('pageerror', error => console.warn(`[shots] ${id}: page error: ${error.message}`));
  const tracker = new NetworkTracker(page);
  // Time starts at T0 and flows: OpenSeadragon's springs and Plotly's transitions stall on a frozen clock
  await page.clock.install({ time: env.demo.t0 });
  await page.clock.resume();
  const url = typeof options.url === 'function' ? options.url(env.demo) : options.url;
  await page.goto(new URL(url, env.demo.baseUrl).href);
  await applyMasks(page, options);
  await settle(page, tracker, { timeout: env.settleTimeout });
  return { context, page, tracker };
}

async function applyMasks(page: Page, options: ShotOptions) {
  if (!options.mask) return;
  for (const locator of options.mask(page))
    await locator.evaluateAll((elements, attribute) => elements.forEach(e => e.setAttribute(attribute, '')), MASK_ATTRIBUTE);
}

function prepareDir(id: ShotId, env: CaptureEnv) {
  const dir = env.dir ?? outDir(id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function baseMeta(id: ShotId, kind: Kind | 'tape', options: ShotOptions, env: CaptureEnv) {
  return {
    id,
    kind,
    alt: options.alt,
    caption: options.caption,
    project: options.project,
    app_version: env.demo.appVersion,
    source_spec: sourceSpec(env.specFile),
    captured: new Date().toISOString(),
    t0: env.demo.t0.toISOString(),
    dedupe_tolerance: options.dedupeTolerance ?? DEFAULT_DEDUPE_TOLERANCE,
  };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Screenshots until two in a row are identical: leftover animations would make captures churn
async function stableScreenshot(page: Page, clip: Box, attempts = 6): Promise<Buffer> {
  const take = () => page.screenshot({ clip, animations: 'disabled', caret: 'hide', scale: 'device', style: MASK_STYLE });
  let previous = await take();
  for (let i = 1; i < attempts; i++) {
    await sleep(250);
    const current = await take();
    if (current.equals(previous)) return current;
    previous = current;
  }
  console.warn(`[shots] the page kept changing over ${attempts} screenshots, keeping the last one`);
  return previous;
}

// The bottom of the bars fixed at the top of the viewport (e.g. the commit page's header): what scrolls under them is hidden
async function topBarsBottom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const bars: DOMRect[] = [];
    for (const el of document.querySelectorAll('body *')) {
      const position = getComputedStyle(el).position;
      if (position !== 'fixed' && position !== 'sticky') continue;
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.height < innerHeight / 2 && r.width > innerWidth / 2) bars.push(r);
    }
    // bars stacked from the top of the viewport (the commit page has one per commit)
    let bottom = 0;
    for (const r of bars.sort((a, b) => a.top - b.top))
      if (r.top <= bottom + 1) bottom = Math.max(bottom, r.bottom);
    return bottom;
  });
}

// The shot's box in viewport coordinates: the target and its padding, within the viewport and below the fixed top bars.
// When the target isn't all visible, the page scrolls its top right under the bars. Scrolling moves what's under the
// mouse, and closes the popovers that open on hover: to shoot one, scroll first, in the actions.
async function shotRegion(page: Page, target: Locator | Locator[] | undefined, padding: number): Promise<Box> {
  const viewport = page.viewportSize() ?? VIEWPORT;
  const targets = target === undefined ? [] : Array.isArray(target) ? target : [target];
  if (targets.length === 0) return { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const measureOnce = async () => {
    const boxes = [];
    for (const t of targets) {
      const box = await t.boundingBox();
      if (!box) throw new Error(`[shots] the target ${t} has no box`);
      boxes.push(box);
    }
    return {
      left: Math.min(...boxes.map(b => b.x)) - padding,
      top: Math.min(...boxes.map(b => b.y)) - padding,
      right: Math.max(...boxes.map(b => b.x + b.width)) + padding,
      bottom: Math.max(...boxes.map(b => b.y + b.height)) + padding,
    };
  };
  // until the boxes stop moving: transitions (a popover that opens) don't keep the network or the spinners busy
  const measure = async () => {
    let previous = await measureOnce();
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      const current = await measureOnce();
      if (JSON.stringify(current) === JSON.stringify(previous)) return current;
      previous = current;
    }
    console.warn('[shots] the target kept moving over 2 s, keeping its last box');
    return previous;
  };
  await targets[0].scrollIntoViewIfNeeded();
  const bars = await topBarsBottom(page);
  let union = await measure();
  if (union.top < bars || union.bottom > viewport.height) {
    if (union.bottom - union.top > viewport.height - bars)
      console.warn(`[shots] the target is ${Math.round(union.bottom - union.top)}px high, the viewport shows ${viewport.height - bars}px of it`);
    await page.evaluate(dy => window.scrollBy(0, dy), union.top - bars);
    union = await measure();
  }
  const x0 = Math.max(0, Math.floor(union.left));
  const y0 = Math.max(Math.ceil(bars), Math.floor(union.top));
  const x1 = Math.min(viewport.width, Math.ceil(union.right));
  const y1 = Math.min(viewport.height, Math.ceil(union.bottom));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Captures out/<id>/still.png and meta.json */
export async function captureStill(browser: Browser, id: ShotId, options: ShotOptions, env: CaptureEnv) {
  checkOptions(id, options);
  const dir = prepareDir(id, env);
  const { context, page, tracker } = await openPage(browser, 'still', id, options, env);
  try {
    const ui = new UiImpl(page, env.demo, tracker, 'still');
    if (options.actions) {
      await options.actions(ui);
      await applyMasks(page, options);
      await settle(page, tracker, { timeout: env.settleTimeout });
    }
    const region = await shotRegion(page, options.target?.(page), options.padding ?? DEFAULT_PADDING);
    const anchors = await anchorsInPercent(ui.anchors, region, true);
    await applyMasks(page, options);
    const png = await stableScreenshot(page, region);
    fs.writeFileSync(path.join(dir, 'still.png'), png);
    const scale = (await page.evaluate(() => window.devicePixelRatio)) || 1;
    const meta = {
      ...baseMeta(id, 'still', options, env),
      width: region.width,
      height: region.height,
      scale,
      anchors,
      files: { still: 'still.png' },
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
    return { dir, meta };
  } finally {
    await context.close();
  }
}

/** Records out/<id>/frames/, frames.ffconcat, captions.vtt and meta.json */
export async function captureClip(browser: Browser, id: ShotId, options: ClipOptions, env: CaptureEnv) {
  checkOptions(id, options);
  const dir = prepareDir(id, env);
  const { context, page, tracker } = await openPage(browser, 'clip', id, options, env);
  try {
    if (options.actions) {
      // set the scene: these actions aren't recorded, and draw nothing
      await options.actions(new UiImpl(page, env.demo, tracker, 'still'));
      await applyMasks(page, options);
      await settle(page, tracker, { timeout: env.settleTimeout });
    }
    const region = await shotRegion(page, options.region?.(page), 0);
    if (options.mask) await page.addStyleTag({ content: MASK_STYLE });
    const recorder = new Recorder(page, dir);
    const ui = new UiImpl(page, env.demo, tracker, 'clip', recorder);
    await recorder.start();
    await options.script(ui);
    const recording = await recorder.stop();
    const anchors = await anchorsInPercent(ui.anchors, region, false);
    const scale = (await page.evaluate(() => window.devicePixelRatio)) || 1;
    if (recording.duration < CLIP_MIN_S || recording.duration > CLIP_MAX_S)
      console.warn(`[shots] ${id}: the clip lasts ${recording.duration.toFixed(1)} s, clips last ${CLIP_MIN_S}-${CLIP_MAX_S} s: publish.py will refuse it`);
    const meta = {
      ...baseMeta(id, 'clip', options, env),
      width: region.width,
      height: region.height,
      scale,
      region,
      duration: Math.round(recording.duration * 1000) / 1000,
      frames: recording.frames,
      poster: options.poster ?? 'last',
      loop: options.loop ?? false,
      anchors,
      files: { concat: recording.concat, captions: recording.captions },
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
    return { dir, meta };
  } finally {
    await context.close();
  }
}
