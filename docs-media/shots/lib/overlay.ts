// What specs act with: the Ui object. In clips, a fake cursor moves along eased paths and clicks show a ripple, both
// burned into the recording. In stills the same methods act without drawing anything.
// In clips, only scripted time is recorded (Recorder.roll): cursor moves, the pauses around clicks and keys, holds.
// The page's handling of inputs, its requests and the waits are left out: what an action does appears at once, loaded.
// The page's own time (page.clock: timers, Date, requestAnimationFrame; its CSS and Web animations) runs with the
// clip's clock, and during waits: debounces, fades and transitions take the same clip time in every recording.
import type { Locator, Page } from '@playwright/test';
import type { Demo } from './demo';
import type { Recorder } from './record';
import { DEFAULT_TIMEOUT, NetworkTracker, plots, settle, tiles, type WaitOptions } from './waits';

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };
export type Modifier = 'Control' | 'Shift' | 'Meta';

/** Passed to `actions` and `script`. Overlay methods only draw in clips; in stills they act without drawing. */
export interface Ui {
  page: Page;
  demo: Demo;
  settle(opts?: { timeout?: number }): Promise<void>;  // the default wait, see Determinism; not recorded in clips
  tiles(opts?: { timeout?: number }): Promise<void>;   // OpenSeadragon images fully loaded; not recorded in clips
  plots(opts?: { timeout?: number }): Promise<void>;   // Plotly graphs drawn and quiet; not recorded in clips
  hover(target: Locator, opts?: { position?: Point }): Promise<void>;
  click(target: Locator, opts?: { modifiers?: Modifier[]; position?: Point }): Promise<void>;
  type(target: Locator, text: string, opts?: { delayMs?: number }): Promise<void>;   // default 60 ms per key in clips
  press(key: string): Promise<void>;
  wheel(target: Locator, deltaY: number, opts?: { steps?: number; position?: Point }): Promise<void>;
  drag(from: Locator | Point, to: Locator | Point, opts?: { steps?: number }): Promise<void>;
  cursor: {
    moveTo(target: Locator | Point, opts?: { durationMs?: number }): Promise<void>;  // default 600 ms, eased
    hide(): Promise<void>;
  };
  caption(text: string, opts?: { durationMs?: number }): Promise<void>;  // WebVTT cue; ends at the next cue or after durationMs
  hold(ms: number): Promise<void>;                     // let the viewer read; in clips, ms of clip
  anchor(name: string, target: Locator): Promise<void>; // records target's box, in % of the shot, for <Shot callouts>
  goto(url: string): Promise<void>;                    // opens another page, waits like the first load; not recorded in clips
}

export const CURSOR_DURATION_MS = 600;
// A cursor position per frame of the encoded clip (30 fps)
const MOVE_TICK_MS = 1000 / 30;
// page.clock's animation frames
const FRAME_MS = 16;
// In clips, waits run the page's clock that long at least (UiImpl.running)
const WAIT_MIN_MS = 400;
// In clips, before the clock runs again: no request in flight for that long
const LOADED_QUIET_MS = 150;
export const TYPE_DELAY_MS = 60;
export const ANCHOR_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Injected with addInitScript in clips: window.__shotCursor draws the cursor (an SVG arrow whose tip is the pointer
 * position) and click ripples, above everything and without catching events.
 */
export function cursorInitScript() {
  if (window !== window.top) return;
  type Cursor = {
    move(x: number, y: number): void; hide(): void; ripple(x: number, y: number): void; freeze(): void; thaw(): void;
  };
  const w = window as unknown as { __shotCursor?: Cursor };
  if (w.__shotCursor) return;
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">'
    + '<path d="M3 2 L3 20.5 L7.8 16 L10.9 23.2 L14.2 21.8 L11.2 14.8 L17.8 14.8 Z" fill="#111418" stroke="#ffffff"'
    + ' stroke-width="1.5" stroke-linejoin="round"/></svg>';
  let el: HTMLElement | null = null;
  let x = 0;
  let y = 0;
  let visible = false;
  // The page's animations (CSS animations, Web animations, the ripples) only play while the clip's clock runs
  // (UiImpl.pause): freeze() pauses them, thaw() plays the ones it paused. CSS transitions run until the next freeze()
  const RIPPLE_MS = 500;
  const paused = new Set<Animation>();
  let frozen = false;
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
        { duration: RIPPLE_MS, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' },
      );
      if (frozen) {
        animation.pause();
        paused.add(animation);
      }
      animation.finished.then(() => r.remove(), () => r.remove());
    },
    freeze() {
      frozen = true;
      for (const a of document.getAnimations()) {
        if (a.playState !== 'running') continue;
        // transitions jump to their end (a panel slid open, a hover color): a paused one may never resume
        if (a instanceof CSSTransition) {
          a.finish();
          continue;
        }
        a.pause();
        paused.add(a);
      }
    },
    thaw() {
      frozen = false;
      // not the ones the page cancelled or finished meanwhile: play() would start them again
      for (const a of paused) if (a.playState === 'paused') a.play();
      paused.clear();
    },
  };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// Between two wheel steps. OpenSeadragon ignores a wheel event that comes less than 50 ms (minScrollDeltaTime)
// after the last one it zoomed for: closer steps would zoom more or less depending on the machine's speed.
// In clips, each step also waits for the page to settle (with its clock running), not recorded.
export const WHEEL_STEP_MS = { clip: 70, still: 80 };
const isPoint = (v: Locator | Point): v is Point => typeof (v as Point).x === 'number' && typeof (v as Point).y === 'number';
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

interface AnchorRecord { target: Locator; box: Box | null }

export class UiImpl implements Ui {
  readonly anchors = new Map<string, AnchorRecord>();
  private pos: Point | null = null;
  private pageRunning = false;             // clips: the page's time flows (a wait); else it's paused, or follows the clip
  readonly cursor: Ui['cursor'];

  constructor(
    readonly page: Page,
    readonly demo: Demo,
    private readonly tracker: NetworkTracker,
    private readonly mode: 'still' | 'clip',
    private readonly recorder?: Recorder,
    private readonly afterGoto?: () => Promise<void>,   // e.g. the shot's masks, on the new document
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

  /** Clips: called when the recording starts. From then on, the page's time only runs in pauses and waits. */
  async startRecording() {
    await this.freezePage();
  }

  /**
   * Scripted time: in clips, `ms` of clip (Recorder.roll), the page's time in step, while the page loads nothing.
   * A request it starts (a debounced fetch, tiles) stops the clip's clock until it's done and drawn: loading appears
   * instant. In stills, a plain sleep.
   */
  private async pause(ms: number) {
    if (!this.recorder) {
      await sleep(ms);
      return;
    }
    let left = ms;
    // how far the page's clock is ahead of the clip's, in this pause
    let ahead = 0;
    while (left > 0.5) {
      // The page's next animation frame first (the viewers draw, crosshairs follow the mouse), so that the frame
      // shown when the clock runs shows it. Its clock stays that far ahead during the pause.
      const lead = Math.min(FRAME_MS, left) - ahead;
      if (lead > 0) {
        await this.page.clock.runFor(lead);
        ahead += lead;
      }
      // what the last action started stops where it is; what it loads, the page loads before the clock runs again
      await this.overlay('freeze');
      if (!this.tracker.quiet(LOADED_QUIET_MS)) {
        await this.running(async () => {
          const deadline = Date.now() + DEFAULT_TIMEOUT;
          while (!this.tracker.quiet(LOADED_QUIET_MS) && Date.now() < deadline) await sleep(10);
        });
      }
      await this.recorder.painted();
      await this.overlay('thaw');
      let moved = ahead;
      const until = left;
      const rolled = await this.recorder.roll(left, async elapsed => {
        const due = Math.min(until, elapsed + ahead) - moved;
        if (due >= 4) {
          await this.page.clock.runFor(due);
          moved += due;
        }
        return this.tracker.pending().length > 0;
      });
      // the page's time moved as much as the clip's, plus the lead
      const due = Math.min(until, rolled + ahead) - moved;
      if (due > 0) {
        await this.page.clock.runFor(due);
        moved += due;
      }
      await this.overlay('freeze');
      left -= rolled;
      ahead = moved - rolled;
    }
  }

  private async overlay(method: 'freeze' | 'thaw') {
    await this.page.evaluate(m => (window as unknown as { __shotCursor?: Record<string, () => void> }).__shotCursor?.[m](), method)
      .catch(() => {});
  }

  // Clips: the page's clock and animations stop. pauseAt() fires the timers due until then: a few ms ahead of the
  // page's time (it flows meanwhile), at the start of an animation frame (page.clock runs requestAnimationFrame
  // callbacks every FRAME_MS of its time): they fire at the same moments of the clip in every recording.
  private async freezePage() {
    await this.overlay('freeze');
    for (let margin = 25; ; margin *= 2) {
      const [now, ticks] = await this.page.evaluate(() => [Date.now(), performance.now()]);
      const frameStart = Math.ceil((ticks + margin) / FRAME_MS) * FRAME_MS;
      try {
        await this.page.clock.pauseAt(now + frameStart - ticks);
        return;
      } catch (error) {
        if (margin >= 1600) throw error;
      }
    }
  }

  /**
   * Clips: waits aren't recorded, and run with the page's clock flowing (its timers, requestAnimationFrame: what
   * loads gets drawn), for `minMs` at least: what the last action started with a short delay (a debounced fetch,
   * a fade) is done in every recording. Its CSS and Web animations stay paused: they only play in scripted time.
   */
  private async running<T>(fn: () => Promise<T>, minMs = 0): Promise<T> {
    if (!this.recorder || this.pageRunning) return fn();
    this.pageRunning = true;
    await this.page.clock.resume();
    try {
      if (minMs > 0) await sleep(minMs);
      return await fn();
    } finally {
      await this.freezePage();
      this.pageRunning = false;
    }
  }

  async settle(opts: WaitOptions = {}) { await this.running(() => settle(this.page, this.tracker, opts), WAIT_MIN_MS); }
  async tiles(opts: WaitOptions = {}) { await this.running(() => tiles(this.page, this.tracker, opts), WAIT_MIN_MS); }
  async plots(opts: WaitOptions = {}) { await this.running(() => plots(this.page, opts), WAIT_MIN_MS); }

  // A point on the target, in viewport coordinates: `position` is relative to its top-left corner, default its center
  async point(target: Locator, position?: Point): Promise<Point> {
    const box = await this.running(async () => {
      await target.waitFor({ state: 'visible' });
      await target.scrollIntoViewIfNeeded();
      return target.boundingBox();
    });
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

  // The cursor and the real mouse at p
  private async step(p: Point) {
    await this.page.evaluate(([x, y]) => (window as unknown as { __shotCursor?: { move(x: number, y: number): void } })
      .__shotCursor?.move(x, y), [p.x, p.y] as const);
    await this.page.mouse.move(p.x, p.y);
  }

  /** Moves the real mouse, and in clips the cursor along an eased, slightly curved path, a point per frame */
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
      await this.step(to);
      this.pos = to;
      return;
    }
    // a quadratic Bézier: the control point is off the straight line, like a hand's arc
    const bend = Math.min(90, dist * 0.15);
    const c = { x: (from.x + to.x) / 2 - (dy / dist) * bend, y: (from.y + to.y) / 2 + (dx / dist) * bend };
    const steps = Math.max(2, Math.round(durationMs / MOVE_TICK_MS));
    for (let i = 1; i <= steps; i++) {
      const t = easeInOutCubic(i / steps);
      await this.step({
        x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * c.x + t ** 2 * to.x,
        y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * c.y + t ** 2 * to.y,
      });
      await this.pause(durationMs / steps);
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

  // In clips, what the click does appears loaded: the page settles before the clock runs again
  async click(target: Locator, opts: { modifiers?: Modifier[]; position?: Point } = {}) {
    if (!this.drawing) {
      await target.click({ modifiers: opts.modifiers, position: opts.position });
      return;
    }
    const p = await this.point(target, opts.position);
    await this.moveTo(p);
    await this.pause(120);
    for (const m of opts.modifiers ?? []) await this.page.keyboard.down(m);
    await this.page.evaluate(([x, y]) => (window as unknown as { __shotCursor?: { ripple(x: number, y: number): void } })
      .__shotCursor?.ripple(x, y), [p.x, p.y] as const);
    await this.page.mouse.down();
    await this.pause(70);
    await this.page.mouse.up();
    for (const m of [...(opts.modifiers ?? [])].reverse()) await this.page.keyboard.up(m);
    await this.settle();
    await this.pause(150);
  }

  async type(target: Locator, text: string, opts: { delayMs?: number } = {}) {
    if (!this.drawing) {
      await target.pressSequentially(text, { delay: opts.delayMs ?? 0 });
      return;
    }
    await this.click(target);
    for (const char of text) {
      await this.page.keyboard.type(char);
      await this.pause(opts.delayMs ?? TYPE_DELAY_MS);
    }
  }

  async press(key: string) {
    await this.page.keyboard.press(key);
    if (!this.drawing) return;
    await this.settle();
    await this.pause(150);
  }

  // In clips, each step shows loaded: the zoom goes by steps, the same in every recording
  async wheel(target: Locator, deltaY: number, opts: { steps?: number; position?: Point } = {}) {
    const steps = Math.max(1, opts.steps ?? 5);
    await this.hover(target, { position: opts.position });
    for (let i = 0; i < steps; i++) {
      await this.page.mouse.wheel(0, deltaY / steps);
      if (this.drawing) await this.settle();
      await this.pause(this.drawing ? WHEEL_STEP_MS.clip : WHEEL_STEP_MS.still);
    }
  }

  async drag(from: Locator | Point, to: Locator | Point, opts: { steps?: number } = {}) {
    const start = isPoint(from) ? from : await this.point(from);
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
    await this.pause(ms);
  }

  /**
   * Opens another page (a path of the demo stack, or a URL), and waits like the first load did (settle()). In clips,
   * the navigation and the waits aren't recorded: the next frame shows the new page, loaded, and the cursor where it
   * was. The page's scroll position starts at the top again.
   */
  async goto(url: string) {
    await this.running(async () => {
      await this.page.goto(new URL(url, this.demo.baseUrl).href);
      await this.afterGoto?.();
      await settle(this.page, this.tracker);
      // the new document has its own cursor, hidden until it moves: where the old one was
      if (this.drawing && this.pos) await this.step(this.pos);
    }, WAIT_MIN_MS);
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
