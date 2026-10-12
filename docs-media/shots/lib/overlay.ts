// What specs act with: the Ui object. In clips, a fake cursor moves along eased paths and clicks show a ripple, both
// burned into the recording. In stills the same methods act without drawing anything.
import type { Locator, Page } from '@playwright/test';
import type { Demo } from './demo';
import type { Recorder } from './record';
import { NetworkTracker, plots, settle, tiles, type WaitOptions } from './waits';

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };
export type Modifier = 'Control' | 'Shift' | 'Meta';

/** Passed to `actions` and `script`. Overlay methods only draw in clips; in stills they act without drawing. */
export interface Ui {
  page: Page;
  demo: Demo;
  settle(opts?: { timeout?: number }): Promise<void>;  // the default wait, see Determinism
  tiles(opts?: { timeout?: number }): Promise<void>;   // OpenSeadragon images fully loaded
  plots(opts?: { timeout?: number }): Promise<void>;   // Plotly graphs drawn and quiet
  hover(target: Locator, opts?: { position?: Point }): Promise<void>;
  click(target: Locator, opts?: { modifiers?: Modifier[]; position?: Point }): Promise<void>;
  type(target: Locator, text: string, opts?: { delayMs?: number }): Promise<void>;   // default 60 ms per key in clips
  press(key: string): Promise<void>;
  wheel(target: Locator, deltaY: number, opts?: { steps?: number; position?: Point }): Promise<void>;
  drag(from: Locator, to: Locator | Point, opts?: { steps?: number }): Promise<void>;
  cursor: {
    moveTo(target: Locator | Point, opts?: { durationMs?: number }): Promise<void>;  // default 600 ms, eased
    hide(): Promise<void>;
  };
  caption(text: string, opts?: { durationMs?: number }): Promise<void>;  // WebVTT cue; ends at the next cue or after durationMs
  hold(ms: number): Promise<void>;                     // let the viewer read; recorded as-is in clips
  anchor(name: string, target: Locator): Promise<void>; // records target's box, in % of the shot, for <Shot callouts>
}

export const CURSOR_DURATION_MS = 600;
export const TYPE_DELAY_MS = 60;
export const ANCHOR_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Injected with addInitScript in clips: window.__shotCursor draws the cursor (an SVG arrow whose tip is the pointer
 * position) and click ripples, above everything and without catching events.
 */
export function cursorInitScript() {
  if (window !== window.top) return;
  type Cursor = { move(x: number, y: number): void; hide(): void; ripple(x: number, y: number): void };
  const w = window as unknown as { __shotCursor?: Cursor };
  if (w.__shotCursor) return;
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">'
    + '<path d="M3 2 L3 20.5 L7.8 16 L10.9 23.2 L14.2 21.8 L11.2 14.8 L17.8 14.8 Z" fill="#111418" stroke="#ffffff"'
    + ' stroke-width="1.5" stroke-linejoin="round"/></svg>';
  let el: HTMLElement | null = null;
  let x = 0;
  let y = 0;
  let visible = false;
  // In full screen, only the full screen element's subtree is drawn: the cursor goes there
  const layer = () => document.fullscreenElement ?? document.documentElement;
  const render = () => {
    if (!el) {
      el = document.createElement('div');
      el.id = '__shot-cursor';
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'position:fixed;left:0;top:0;width:26px;height:26px;pointer-events:none;'
        + 'z-index:2147483647;will-change:transform;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.35));';
      el.innerHTML = SVG;
    }
    if (el.parentNode !== layer()) layer().appendChild(el);
    // the arrow's tip is at (3, 2) in the SVG
    el.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
    el.style.display = visible ? 'block' : 'none';
  };
  document.addEventListener('fullscreenchange', () => { if (el) render(); });
  w.__shotCursor = {
    move(nx, ny) { x = nx; y = ny; visible = true; render(); },
    hide() { visible = false; render(); },
    ripple(rx, ry) {
      const r = document.createElement('div');
      r.className = '__shot-ripple';
      r.setAttribute('aria-hidden', 'true');
      r.style.cssText = `position:fixed;left:${rx - 22}px;top:${ry - 22}px;width:44px;height:44px;border-radius:50%;`
        + 'pointer-events:none;z-index:2147483646;background:rgba(45,114,210,.28);border:2px solid rgba(45,114,210,.85);';
      layer().appendChild(r);
      const animation = r.animate(
        [{ transform: 'scale(.25)', opacity: 1 }, { transform: 'scale(1.3)', opacity: 0 }],
        { duration: 500, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' },
      );
      animation.finished.then(() => r.remove(), () => r.remove());
    },
  };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const isPoint = (v: Locator | Point): v is Point => typeof (v as Point).x === 'number' && typeof (v as Point).y === 'number';
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

interface AnchorRecord { target: Locator; box: Box | null }

export class UiImpl implements Ui {
  readonly anchors = new Map<string, AnchorRecord>();
  private pos: Point | null = null;
  readonly cursor: Ui['cursor'];

  constructor(
    readonly page: Page,
    readonly demo: Demo,
    private readonly tracker: NetworkTracker,
    private readonly mode: 'still' | 'clip',
    private readonly recorder?: Recorder,
  ) {
    this.cursor = {
      moveTo: async (target, opts = {}) => {
        const point = isPoint(target) ? target : await this.point(target);
        await this.moveTo(point, opts.durationMs);
      },
      hide: async () => {
        if (this.mode !== 'clip') return;
        await this.page.evaluate(() => (window as unknown as { __shotCursor?: { hide(): void } }).__shotCursor?.hide());
      },
    };
  }

  private get drawing() { return this.mode === 'clip'; }

  async settle(opts: WaitOptions = {}) { await settle(this.page, this.tracker, opts); }
  async tiles(opts: WaitOptions = {}) { await tiles(this.page, this.tracker, opts); }
  async plots(opts: WaitOptions = {}) { await plots(this.page, opts); }

  // A point on the target, in viewport coordinates: `position` is relative to its top-left corner, default its center
  async point(target: Locator, position?: Point): Promise<Point> {
    await target.waitFor({ state: 'visible' });
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error(`[shots] ${target} has no bounding box`);
    return position
      ? { x: box.x + position.x, y: box.y + position.y }
      : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  // Where the cursor appears the first time it moves in a clip: bottom right, out of the way
  private startPoint(): Point {
    const size = this.page.viewportSize() ?? { width: 1440, height: 900 };
    return { x: Math.round(size.width * 0.82), y: Math.round(size.height * 0.86) };
  }

  private async draw(p: Point) {
    await this.page.evaluate(([x, y]) => (window as unknown as { __shotCursor?: { move(x: number, y: number): void } })
      .__shotCursor?.move(x, y), [p.x, p.y] as const);
  }

  /** Moves the real mouse, and in clips the cursor along an eased, slightly curved path */
  async moveTo(to: Point, durationMs = CURSOR_DURATION_MS) {
    if (!this.drawing) {
      await this.page.mouse.move(to.x, to.y);
      this.pos = to;
      return;
    }
    const from = this.pos ?? this.startPoint();
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1 || durationMs <= 0) {
      await this.page.mouse.move(to.x, to.y);
      await this.draw(to);
      this.pos = to;
      return;
    }
    // a quadratic Bézier: the control point is off the straight line, like a hand's arc
    const bend = Math.min(90, dist * 0.15);
    const c = { x: (from.x + to.x) / 2 - (dy / dist) * bend, y: (from.y + to.y) / 2 + (dx / dist) * bend };
    const steps = Math.max(2, Math.round(durationMs / 16));
    const start = Date.now();
    for (let i = 1; i <= steps; i++) {
      const t = easeInOutCubic(i / steps);
      const p = {
        x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * c.x + t ** 2 * to.x,
        y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * c.y + t ** 2 * to.y,
      };
      await this.page.mouse.move(p.x, p.y);
      await this.draw(p);
      const wait = start + (i / steps) * durationMs - Date.now();
      if (wait > 0) await sleep(wait);
    }
    this.pos = to;
  }

  async hover(target: Locator, opts: { position?: Point } = {}) {
    if (!this.drawing) {
      await target.hover({ position: opts.position });
      return;
    }
    await this.moveTo(await this.point(target, opts.position));
  }

  async click(target: Locator, opts: { modifiers?: Modifier[]; position?: Point } = {}) {
    if (!this.drawing) {
      await target.click({ modifiers: opts.modifiers, position: opts.position });
      return;
    }
    const p = await this.point(target, opts.position);
    await this.moveTo(p);
    await sleep(120);
    for (const m of opts.modifiers ?? []) await this.page.keyboard.down(m);
    await this.page.evaluate(([x, y]) => (window as unknown as { __shotCursor?: { ripple(x: number, y: number): void } })
      .__shotCursor?.ripple(x, y), [p.x, p.y] as const);
    await this.page.mouse.down();
    await sleep(70);
    await this.page.mouse.up();
    for (const m of [...(opts.modifiers ?? [])].reverse()) await this.page.keyboard.up(m);
    await sleep(150);
  }

  async type(target: Locator, text: string, opts: { delayMs?: number } = {}) {
    if (this.drawing) await this.click(target);
    await target.pressSequentially(text, { delay: opts.delayMs ?? (this.drawing ? TYPE_DELAY_MS : 0) });
  }

  async press(key: string) {
    await this.page.keyboard.press(key);
    if (this.drawing) await sleep(150);
  }

  async wheel(target: Locator, deltaY: number, opts: { steps?: number; position?: Point } = {}) {
    const steps = Math.max(1, opts.steps ?? 5);
    await this.hover(target, { position: opts.position });
    for (let i = 0; i < steps; i++) {
      await this.page.mouse.wheel(0, deltaY / steps);
      await sleep(this.drawing ? 70 : 30);
    }
  }

  async drag(from: Locator, to: Locator | Point, opts: { steps?: number } = {}) {
    const start = await this.point(from);
    await this.moveTo(start);
    await this.page.mouse.down();
    const end = isPoint(to) ? to : await this.point(to);
    if (this.drawing) await this.moveTo(end, 800);
    else await this.page.mouse.move(end.x, end.y, { steps: opts.steps ?? 20 });
    await this.page.mouse.up();
  }

  async caption(text: string, opts: { durationMs?: number } = {}) {
    if (!this.recorder) return;
    if (text.length > 60) console.warn(`[shots] caption over 60 characters (${text.length}): "${text}"`);
    this.recorder.cue(text, opts.durationMs);
  }

  async hold(ms: number) {
    await sleep(ms);
  }

  async anchor(name: string, target: Locator) {
    if (!ANCHOR_NAME_RE.test(name)) throw new Error(`[shots] invalid anchor name "${name}": use lowercase kebab-case`);
    // measured now, and again right before the screenshot if it's still there
    this.anchors.set(name, { target, box: await target.boundingBox() });
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Anchors in % of the region (the shot's box in viewport coordinates), clamped to it */
export async function anchorsInPercent(anchors: Map<string, AnchorRecord>, region: Box, remeasure: boolean) {
  const result: Record<string, { x: number; y: number; w: number; h: number }> = {};
  for (const [name, record] of [...anchors.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let box = record.box;
    if (remeasure) {
      const now = await record.target.boundingBox().catch(() => null);
      if (now) box = now;
    }
    if (!box) throw new Error(`[shots] anchor "${name}": the element has no box`);
    const x0 = Math.max(box.x, region.x);
    const y0 = Math.max(box.y, region.y);
    const x1 = Math.min(box.x + box.width, region.x + region.width);
    const y1 = Math.min(box.y + box.height, region.y + region.height);
    if (x1 <= x0 || y1 <= y0) throw new Error(`[shots] anchor "${name}" is outside the shot`);
    result[name] = {
      x: round2(((x0 - region.x) / region.width) * 100),
      y: round2(((y0 - region.y) / region.height) * 100),
      w: round2(((x1 - x0) / region.width) * 100),
      h: round2(((y1 - y0) / region.height) * 100),
    };
  }
  return result;
}
