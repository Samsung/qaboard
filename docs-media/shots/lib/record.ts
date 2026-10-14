// Recording clips with the CDP screencast (docs-media/README.md#clips): Playwright's own video is too blurry.
// Frames only arrive when the page repaints, each with a timestamp: we write out/<id>/frames/NNNNN.jpg and an ffmpeg
// concat list (frames.ffconcat) with each frame's duration. Captions are WebVTT cues (captions.vtt), timed on the
// same clock.
//
// The clip's clock only runs in the script's scripted time (`roll(ms)`: cursor moves, pauses, holds), never while
// the page handles an input, loads or settles: a clip lasts the same and shows the same frames at the same times
// whatever the server's latency or the machine's speed. Between two rolls, only the last frame is kept: the page as
// the action and the wait left it, shown at once.
import fs from 'node:fs';
import path from 'node:path';
import type { CDPSession, Page } from '@playwright/test';

export const JPEG_QUALITY = 92;
// Before rolling: the screen drew since the last action, then nothing for PAINT_QUIET_MS (two frames at 60 Hz); at
// most PAINT_TIMEOUT_MS (nothing changed on screen, or something keeps moving)
export const PAINT_QUIET_MS = 34;
export const PAINT_TIMEOUT_MS = 120;

export interface Frame { file: string; ts: number }    // ts: when Chromium drew the frame, seconds (wall clock)
// A stretch of scripted time: wall clock from `start` to `end`, clip clock from `clip` for `duration` (seconds)
export interface Roll { start: number; end: number; clip: number; duration: number }
interface Cue { start: number; text: string; durationMs?: number }

export interface Recording {
  duration: number;       // seconds of clip
  frames: number;
  concat: string;         // file name in the output folder
  captions: string | null;
  cut: number;            // seconds of wall clock left out
  frameSize: { width: number; height: number };   // pixels of the frames
}

/** A JPEG's size, from its start of frame segment */
export function jpegSize(data: Buffer): { width: number; height: number } {
  let i = 2;
  while (i + 9 < data.length) {
    if (data[i] !== 0xff) throw new Error('[shots] not a JPEG segment');
    const marker = data[i + 1];
    const length = data.readUInt16BE(i + 2);
    // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  throw new Error('[shots] no JPEG frame size');
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The frames that make the clip, with their time on its clock (`t`). A frame drawn during a roll is at its place in
 * it (at most its scripted duration); between two rolls, only the last frame is kept, at the start of the next roll.
 * Frames and rolls are sorted by time; rolls don't overlap.
 */
export function clipFrames<F extends { ts: number }>(frames: readonly F[], rolls: readonly Roll[]) {
  const kept: Array<F & { t: number }> = [];
  const dropped: F[] = [];
  // the roll a time is in, or -(index of the next roll) - 1 when it's between rolls
  const where = (ts: number) => {
    let i = 0;
    while (i < rolls.length && rolls[i].end <= ts) i++;
    return i < rolls.length && rolls[i].start <= ts ? i : -i - 1;
  };
  frames.forEach((frame, i) => {
    const at = where(frame.ts);
    if (at >= 0) {
      const roll = rolls[at];
      kept.push({ ...frame, t: roll.clip + Math.min(frame.ts - roll.start, roll.duration) });
      return;
    }
    const next = frames[i + 1];
    if (next && where(next.ts) === at) {
      dropped.push(frame);
      return;
    }
    const before = rolls[-at - 2];
    kept.push({ ...frame, t: before ? before.clip + before.duration : 0 });
  });
  return { kept, dropped };
}

export class Recorder {
  private session?: CDPSession;
  private frames: Frame[] = [];
  private writes: Promise<void>[] = [];
  private cues: Cue[] = [];
  private rolls: Roll[] = [];
  private rolling?: { start: number; clip: number; duration: number };
  private clip = 0;                        // seconds of clip so far, at the end of the last roll
  private started?: number;
  private stopped?: number;
  private firstFrame: Promise<void>;
  private resolveFirstFrame!: () => void;

  constructor(private readonly page: Page, private readonly dir: string) {
    this.firstFrame = new Promise(resolve => { this.resolveFirstFrame = resolve; });
  }

  get framesDir() { return path.join(this.dir, 'frames'); }

  async start() {
    fs.rmSync(this.framesDir, { recursive: true, force: true });
    fs.mkdirSync(this.framesDir, { recursive: true });
    const viewport = this.page.viewportSize() ?? { width: 1440, height: 900 };
    const scale = await this.page.evaluate(() => window.devicePixelRatio);
    this.session = await this.page.context().newCDPSession(this.page);
    this.started = Date.now() / 1000;
    this.session.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      // ack first: Chromium waits for it before sending the next frame
      this.session?.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      if (this.stopped !== undefined) return;
      const ts = metadata.timestamp ?? Date.now() / 1000;
      if (this.frames.length === 0) this.resolveFirstFrame();
      // frames can arrive out of order by a hair: keep timestamps monotonic
      const last = this.frames.at(-1);
      const file = `${String(this.frames.length).padStart(5, '0')}.jpg`;
      this.frames.push({ file, ts: last && ts < last.ts ? last.ts : ts });
      this.writes.push(fs.promises.writeFile(path.join(this.framesDir, file), Buffer.from(data, 'base64')));
    });
    await this.session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: JPEG_QUALITY,
      everyNthFrame: 1,
      maxWidth: Math.round(viewport.width * scale),
      maxHeight: Math.round(viewport.height * scale),
    });
    // Chromium sends a first frame on start; nudge a repaint in case it doesn't
    const timeout = Date.now() + 5_000;
    let received = false;
    this.firstFrame.then(() => { received = true; });
    while (!received) {
      if (Date.now() > timeout) throw new Error('[shots] the screencast sent no frame within 5 s');
      await this.page.evaluate(() => {
        document.documentElement.style.setProperty('--shot-nudge', String(Math.random()));
      });
      await sleep(50);
    }
  }

  /** Seconds of clip so far */
  now(): number {
    if (!this.rolling) return this.clip;
    return this.rolling.clip + Math.min(Date.now() / 1000 - this.rolling.start, this.rolling.duration);
  }

  /**
   * Waits until the screen shows what the page did so far: the page ran the work it queued (e.g. React rendering what
   * a mouse move changed), the screen drew since, then stopped changing.
   */
  async painted() {
    await this.page.evaluate(() => new Promise<void>(resolve => {
      // React schedules its renders as MessageChannel tasks (not faked by page.clock): these run after them
      const channel = new MessageChannel();
      let hops = 0;
      channel.port1.onmessage = () => (++hops < 3 ? channel.port2.postMessage(0) : resolve());
      channel.port2.postMessage(0);
    })).catch(() => {});
    const flushed = Date.now();
    for (;;) {
      const drawn = (this.frames.at(-1)?.ts ?? 0) * 1000;
      const now = Date.now();
      if (now - flushed >= PAINT_TIMEOUT_MS || (drawn >= flushed && now - drawn >= PAINT_QUIET_MS)) return;
      await sleep(5);
    }
  }

  /**
   * Scripted time: records `ms` of clip as it happens. Every few ms, calls `step` with the ms of clip so far, and stops
   * early if it returns true (the page started loading something). Returns the milliseconds of clip recorded.
   */
  async roll(ms: number, step?: (elapsed: number) => boolean | Promise<boolean>): Promise<number> {
    if (ms <= 0) return 0;
    if (this.rolling) throw new Error('[shots] roll() while rolling');
    const start = Date.now() / 1000;
    this.rolling = { start, clip: this.clip, duration: ms / 1000 };
    let elapsed = 0;
    try {
      for (;;) {
        elapsed = Date.now() - start * 1000;
        if (elapsed >= ms || await step?.(Math.min(elapsed, ms))) break;
        await sleep(Math.min(step ? 5 : ms, ms - elapsed));
      }
    } finally {
      const duration = Math.min(elapsed, ms) / 1000;
      this.rolls.push({ start, end: Date.now() / 1000, clip: this.clip, duration });
      this.clip += duration;
      this.rolling = undefined;
    }
    return Math.min(elapsed, ms);
  }

  cue(text: string, durationMs?: number) {
    this.cues.push({ start: this.now(), text, durationMs });
  }

  async stop(outDir = this.dir): Promise<Recording> {
    this.stopped = Date.now() / 1000;
    await this.session?.send('Page.stopScreencast').catch(() => {});
    await this.session?.detach().catch(() => {});
    await Promise.all(this.writes);
    if (this.frames.length === 0) throw new Error('[shots] the screencast recorded no frames');
    const { kept, dropped } = clipFrames(this.frames, this.rolls);
    if (process.env.SHOTS_DEBUG)
      fs.writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify({ frames: this.frames, rolls: this.rolls, kept }, null, 1));
    for (const frame of dropped) fs.rmSync(path.join(this.framesDir, frame.file), { force: true });
    // the last frame shows for one frame at least
    const end = Math.max(this.clip, kept.at(-1)!.t + 1 / 30);

    // ffmpeg's concat demuxer: each file with its duration, the last one listed twice so its duration counts
    const lines = ['ffconcat version 1.0'];
    kept.forEach((frame, i) => {
      const next = i + 1 < kept.length ? kept[i + 1].t : end;
      lines.push(`file 'frames/${frame.file}'`, `duration ${Math.max(0, next - frame.t).toFixed(6)}`);
    });
    lines.push(`file 'frames/${kept.at(-1)!.file}'`);
    const concat = 'frames.ffconcat';
    fs.writeFileSync(path.join(outDir, concat), lines.join('\n') + '\n');

    let captions: string | null = null;
    if (this.cues.length > 0) {
      captions = 'captions.vtt';
      fs.writeFileSync(path.join(outDir, captions), webvtt(this.cues, end));
    }
    const cut = Math.max(0, this.stopped - (this.started ?? this.stopped) - this.clip);
    const frameSize = jpegSize(fs.readFileSync(path.join(this.framesDir, kept[0].file)));
    return { duration: end, frames: kept.length, concat, captions, cut, frameSize };
  }
}

const timestamp = (s: number) => {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  const pad = (v: number, n = 2) => String(v).padStart(n, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}.${pad(ms % 1000, 3)}`;
};

// A cue ends at the next cue, after its duration, or at the end of the clip
export function webvtt(cues: Cue[], duration: number): string {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const blocks = sorted.map((cue, i) => {
    let end = i + 1 < sorted.length ? sorted[i + 1].start : duration;
    if (cue.durationMs !== undefined) end = Math.min(end, cue.start + cue.durationMs / 1000);
    end = Math.max(end, cue.start + 0.1);
    return `${timestamp(cue.start)} --> ${timestamp(Math.min(end, Math.max(duration, cue.start + 0.1)))}\n${cue.text}`;
  });
  return ['WEBVTT', ...blocks].join('\n\n') + '\n';
}
