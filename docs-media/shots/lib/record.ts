// Recording clips with the CDP screencast (docs-media/README.md#clips): Playwright's own video is too blurry.
// Frames only arrive when the page repaints, each with a timestamp: we write out/<id>/frames/NNNNN.jpg and an ffmpeg
// concat list (frames.ffconcat) with each frame's duration. Captions are WebVTT cues (captions.vtt), timed on the
// same clock: the first frame is 0.
import fs from 'node:fs';
import path from 'node:path';
import type { CDPSession, Page } from '@playwright/test';

export const JPEG_QUALITY = 92;

interface Frame { file: string; ts: number }
interface Cue { start: number; text: string; durationMs?: number }

export interface Recording {
  duration: number;       // seconds, first frame to stop
  frames: number;
  concat: string;         // file name in the output folder
  captions: string | null;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class Recorder {
  private session?: CDPSession;
  private frames: Frame[] = [];
  private writes: Promise<void>[] = [];
  private cues: Cue[] = [];
  private origin?: number;                 // seconds (wall clock), the first frame's timestamp
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
    this.session.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      // ack first: Chromium waits for it before sending the next frame
      this.session?.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      if (this.stopped !== undefined) return;
      const ts = metadata.timestamp ?? Date.now() / 1000;
      if (this.origin === undefined) {
        this.origin = ts;
        this.resolveFirstFrame();
      }
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

  /** Seconds since the first frame */
  now(): number {
    if (this.origin === undefined) return 0;
    return Math.max(0, Date.now() / 1000 - this.origin);
  }

  cue(text: string, durationMs?: number) {
    this.cues.push({ start: this.now(), text, durationMs });
  }

  async stop(outDir = this.dir): Promise<Recording> {
    this.stopped = Date.now() / 1000;
    await this.session?.send('Page.stopScreencast').catch(() => {});
    await this.session?.detach().catch(() => {});
    await Promise.all(this.writes);
    if (this.frames.length === 0 || this.origin === undefined) throw new Error('[shots] the screencast recorded no frames');
    const end = Math.max(this.stopped, this.frames.at(-1)!.ts);
    const duration = end - this.origin;

    // ffmpeg's concat demuxer: each file with its duration, the last one listed twice so its duration counts
    const lines = ['ffconcat version 1.0'];
    this.frames.forEach((frame, i) => {
      const next = i + 1 < this.frames.length ? this.frames[i + 1].ts : end;
      lines.push(`file 'frames/${frame.file}'`, `duration ${Math.max(0, next - frame.ts).toFixed(6)}`);
    });
    lines.push(`file 'frames/${this.frames.at(-1)!.file}'`);
    const concat = 'frames.ffconcat';
    fs.writeFileSync(path.join(outDir, concat), lines.join('\n') + '\n');

    let captions: string | null = null;
    if (this.cues.length > 0) {
      captions = 'captions.vtt';
      fs.writeFileSync(path.join(outDir, captions), webvtt(this.cues, duration));
    }
    return { duration, frames: this.frames.length, concat, captions };
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
