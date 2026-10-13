// The lib's tests, on local fixture pages: waits, cursor, captions, anchors, masks and recording work before the real
// web app is there.  npm test
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { captureClip, captureStill, type CaptureEnv, type ClipOptions, type ShotOptions } from '../index';
import { createDemo, type Demo } from '../demo';
import { checkId, globToRegExp, isSelected, sourceSpec } from '../ids';
import { clipFrames, jpegSize, webvtt } from '../record';
import { startServer, type FixtureServer } from './server';

const T0 = '2026-10-08T16:00:00.000Z';
let server: FixtureServer;
let demo: Demo;

test.beforeAll(async () => {
  server = await startServer();
  demo = createDemo({ t0: T0, base_url: server.url, app_version: '1.1.1+0000000' });
});
test.afterAll(async () => server?.close());

const env = (dir: string, settleTimeout?: number): CaptureEnv => ({
  demo,
  specFile: path.resolve('commit.spec.ts'),
  dir,
  settleTimeout,
  contextOptions: test.info().project.use as CaptureEnv["contextOptions"],
});

const pngSize = (file: string) => {
  const buffer = fs.readFileSync(file);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
};

const base: Omit<ShotOptions, 'url'> = {
  project: 'image-quality',
  alt: 'A fixture page with a run card, a button and a text field.',
  login: null,
};

test.describe('ids and demo facts', () => {
  test('shot ids', () => {
    expect(() => checkId('commit/pixel-tooltip')).not.toThrow();
    expect(() => checkId('whats-new/dialog')).not.toThrow();
    for (const bad of ['commit', 'commit/Pixel', 'commit/a/b', 'nope/thing', 'commit/-x', `commit/${'a'.repeat(80)}`])
      expect(() => checkId(bad), bad).toThrow();
    expect(globToRegExp('commit/image-*').test('commit/image-diff')).toBe(true);
    expect(globToRegExp('commit/image-*').test('commit/pixel-tooltip')).toBe(false);
    expect(isSelected('history/relative', 'commit/*,history/*')).toBe(true);
    expect(isSelected('logs/crash', 'commit/*,history/*')).toBe(false);
    expect(isSelected('logs/crash', '*')).toBe(true);
    expect(sourceSpec(path.resolve('commit.spec.ts'))).toBe('docs-media/shots/commit.spec.ts');
  });

  test('urls match the web app routes', () => {
    const d = createDemo({ t0: T0 });
    const sha = createHash('sha1').update('kitefin/camera-isp:bilateral-denoise').digest('hex');
    expect(d.sha('image-quality', 'bilateral-denoise')).toBe(sha);
    expect(d.sha('image-quality', sha)).toBe(sha);
    expect(d.slug('serving-latency')).toBe('kitefin/inference-gateway');
    const ref = d.sha('image-quality', 'isp-4-1');
    expect(d.commitUrl('image-quality', 'bilateral-denoise', {
      reference: 'isp-4-1', view: 'output-list', filter: 'siemens-star low-light', controls: { diff: true },
    })).toBe(`http://localhost:5151/kitefin/camera-isp/commit/${sha}?reference=${ref}&selected_views=output-list`
      + `&filter=siemens-star%20low-light&controls=${encodeURIComponent('{"diff":true}')}`);
    expect(d.commitUrl('image-quality', 'bilateral-denoise', { batch: 'tune-denoise', query: { sort_by: 'psnr' } }))
      .toBe(`http://localhost:5151/kitefin/camera-isp/commit/${sha}?batch=tune-denoise&sort_by=psnr`);
    expect(d.historyUrl('image-quality', 'isp/halo-clamp', { metric: 'overshoot' }))
      .toBe('http://localhost:5151/kitefin/camera-isp/history/isp/halo-clamp?metric=overshoot');
    expect(d.url('serving-latency', 'commits')).toBe('http://localhost:5151/kitefin/inference-gateway/commits');
    expect(d.filesUrl('image-quality', 'bilateral-denoise', 'output/'))
      .toBe(`http://localhost:5151/s/mnt/qaboard/kitefin/camera-isp/${sha.slice(0, 2)}/${sha.slice(2, 16)}/output/`);
  });

  test('commits from the snapshot facts', () => {
    const d = createDemo({ t0: T0, projects: { 'image-quality': { id: 'kitefin/camera-isp', commits: { 'isp-4-1': { sha: 'a'.repeat(40) } } } } });
    expect(d.sha('image-quality', 'isp-4-1')).toBe('a'.repeat(40));
    expect(() => d.sha('image-quality', 'isp-4-l')).toThrow(/isn't a commit of image-quality/);
    // projects the facts don't list: the formula
    expect(d.sha('serving-latency', 'cache-shared')).toBe(createHash('sha1').update('kitefin/inference-gateway:cache-shared').digest('hex'));
  });

  test("a clip's clock only runs in scripted time", () => {
    // wall clock: the first frame at 10 s, a hold from 10.5 s to 11.5 s, a wait, then a pause of 0.5 s that slept 0.6 s
    const rolls = [{ start: 10.5, end: 11.5, clip: 0, duration: 1 }, { start: 13, end: 13.6, clip: 1, duration: 0.5 }];
    const frames = [10, 10.2, 10.6, 11.2, 11.8, 12.5, 13.55, 14].map((ts, i) => ({ file: `${i}`, ts }));
    const { kept, dropped } = clipFrames(frames, rolls);
    // between rolls, only the last frame: the page as the wait left it, shown when the clock runs again
    expect(dropped.map(f => f.file)).toEqual(['0', '4']);
    const round = (v: number) => Math.round(v * 1000) / 1000;
    expect(kept.map(f => [f.file, round(f.t)])).toEqual([['1', 0], ['2', 0.1], ['3', 0.7], ['5', 1], ['6', 1.5], ['7', 1.5]]);
  });

  test('captions as WebVTT', () => {
    expect(webvtt([{ start: 0.25, text: 'Zoom in' }, { start: 3.5, text: 'Image Diff', durationMs: 1000 }], 8))
      .toBe('WEBVTT\n\n00:00:00.250 --> 00:00:03.500\nZoom in\n\n00:00:03.500 --> 00:00:04.500\nImage Diff\n');
  });
});

test.describe('waits', () => {
  test('settle waits for spinners and requests, except in masked elements', async ({ browser }, testInfo) => {
    const options: ShotOptions = { ...base, url: '/spinner.html', mask: page => [page.locator('#running')] };
    let checked = false;
    await captureStill(browser, 'commit/spinner', {
      ...options,
      actions: async ui => {
        // settle ran after navigation: the slow requests are done and the spinner is gone
        expect(await ui.page.locator('#content').isVisible()).toBe(true);
        expect(await ui.page.locator('#loading').count()).toBe(0);
        const elapsed = await ui.page.evaluate(() => Date.now() - (window as any).__loadedAt);
        expect(elapsed).toBeGreaterThanOrEqual(450);
        checked = true;
      },
    }, env(testInfo.outputPath('spinner')));
    expect(checked).toBe(true);
    // without the mask, the running batch's spinner never goes away
    const started = Date.now();
    await expect(captureStill(browser, 'commit/spinner', { ...options, mask: undefined },
      env(testInfo.outputPath('spinner-unmasked'), 3_000))).rejects.toThrow(/1 spinners/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test('tiles: every IIIF tile arrived and both viewers drew', async ({ browser }, testInfo) => {
    await captureStill(browser, 'commit/osd', {
      ...base,
      url: '/osd.html',
      actions: async ui => {
        expect(await ui.page.evaluate(() => (window as any).fullyLoaded())).toBe(true);
        expect(server.stats.tilesRequested).toBeGreaterThan(8);
        expect(server.stats.tilesServed).toBe(server.stats.tilesRequested);
        // the zoom happened: viewers are at zoom 3, springs at rest
        const zoom = await ui.page.evaluate(() => (window as any).viewers[0].viewport.getZoom(true));
        expect(zoom).toBeCloseTo(3, 2);
      },
    }, env(testInfo.outputPath('osd')));
  });

  test('plots: drawn and quiet', async ({ browser }, testInfo) => {
    await captureStill(browser, 'commit/plotly', {
      ...base,
      url: '/plotly.html',
      actions: async ui => {
        const { count, quiet } = await ui.page.evaluate(() => {
          const calls = (window as any).__afterplots as number[];
          return { count: calls.length, quiet: Date.now() - calls[calls.length - 1] };
        });
        expect(count).toBeGreaterThanOrEqual(3);
        expect(quiet).toBeGreaterThanOrEqual(300);
      },
    }, env(testInfo.outputPath('plotly')));
  });
});

test.describe('stills', () => {
  test('clock, storage, routes, crop, padding, anchors, masks, determinism', async ({ browser }, testInfo) => {
    const options: ShotOptions = {
      ...base,
      url: d => `${d.baseUrl}/app.html`,
      storage: { extra: 'yes' },
      target: page => page.locator('#card'),
      padding: 16,
      mask: page => [page.locator('#volatile')],
      actions: async ui => {
        const page = ui.page;
        // the clock starts at T0 and flows
        const loaded = new Date(await page.locator('#clock').textContent() ?? '');
        expect(loaded.getTime() - new Date(T0).getTime()).toBeGreaterThanOrEqual(0);
        expect(loaded.getTime() - new Date(T0).getTime()).toBeLessThan(30_000);
        const a = await page.evaluate(() => Date.now());
        await ui.hold(200);
        expect(await page.evaluate(() => Date.now()) - a).toBeGreaterThanOrEqual(150);
        // default localStorage, merged with the shot's
        expect(JSON.parse(await page.locator('#storage').textContent() ?? '{}'))
          .toEqual({ lastSeen: '2026-10-08', controls: 'false', extra: 'yes' });
        // *.kitefin.example answers, the rest of the internet doesn't
        const other = await page.context().newPage();
        const response = await other.goto('https://git.kitefin.example/kitefin/camera-isp');
        expect(response?.status()).toBe(200);
        await expect(other.goto('https://example.org/')).rejects.toThrow();
        await other.close();
        // stills act without drawing
        await ui.click(page.locator('#counter-button'), { modifiers: ['Shift'] });
        await ui.type(page.locator('#field'), 'halo');
        await ui.hover(page.locator('#hover-target'));
        expect(await page.locator('#count').textContent()).toBe('1');
        expect(await page.locator('#modifiers').textContent()).toBe('Shift');
        expect(await page.locator('#field').inputValue()).toBe('halo');
        expect(await page.locator('#tip').isVisible()).toBe(true);
        expect(await page.locator('#__shot-cursor').count()).toBe(0);
        await ui.anchor('counter', page.locator('#counter-button'));
        await ui.caption('ignored in stills');
      },
    };
    const first = await captureStill(browser, 'commit/card', options, env(testInfo.outputPath('card-1')));
    const card = { width: 560, padding: 16 }; // 520 + 2 * 20 padding
    expect(first.meta.width).toBe(card.width + 2 * card.padding);
    expect(first.meta.scale).toBe(2);
    expect(pngSize(path.join(first.dir, 'still.png'))).toEqual({ width: first.meta.width * 2, height: first.meta.height * 2 });
    expect(first.meta).toMatchObject({
      id: 'commit/card', kind: 'still', project: 'image-quality', app_version: '1.1.1+0000000',
      source_spec: 'docs-media/shots/commit.spec.ts', t0: T0, dedupe_tolerance: 0.0005,
    });
    const anchor = first.meta.anchors.counter;
    expect(anchor.x).toBeGreaterThan(0);
    expect(anchor.x + anchor.w).toBeLessThan(100);
    expect(anchor.y).toBeGreaterThan(0);
    // what the anchor says matches where the button is in the image
    const shot = await captureStill(browser, 'commit/card', {
      ...options,
      actions: async ui => {
        await options.actions!(ui);
        const button = await ui.page.locator('#counter-button').boundingBox();
        const cardBox = await ui.page.locator('#card').boundingBox();
        const left = cardBox!.x - 16;
        expect(anchor.x).toBeCloseTo(((button!.x - left) / first.meta.width) * 100, 0);
      },
    }, env(testInfo.outputPath('card-2')));
    // the masked timer changes all the time, the captures don't
    expect(fs.readFileSync(path.join(shot.dir, 'still.png')).equals(fs.readFileSync(path.join(first.dir, 'still.png')))).toBe(true);
  });
});

test('a target of several elements crops to their union', async ({ browser }, testInfo) => {
  let expected = { width: 0, height: 0 };
  const { meta } = await captureStill(browser, 'commit/union', {
    ...base,
    url: '/app.html',
    padding: 0,
    target: page => [page.locator('#counter-button'), page.locator('#hover-target')],
    actions: async ui => {
      const a = (await ui.page.locator('#counter-button').boundingBox())!;
      const b = (await ui.page.locator('#hover-target').boundingBox())!;
      expected = {
        width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x),
        height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y),
      };
    },
  }, env(testInfo.outputPath('union')));
  expect(Math.abs(meta.width - expected.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(meta.height - expected.height)).toBeLessThanOrEqual(2);
});

test('a target box crops to it, within the viewport', async ({ browser }, testInfo) => {
  const { dir, meta } = await captureStill(browser, 'commit/box', {
    ...base,
    url: '/app.html',
    target: async page => {
      const card = (await page.locator('#card').boundingBox())!;
      return { x: card.x + 0.4, y: card.y, width: 320, height: 200 };
    },
  }, env(testInfo.outputPath('box')));
  expect([meta.width, meta.height]).toEqual([320, 200]);
  expect(pngSize(path.join(dir, 'still.png'))).toEqual({ width: 640, height: 400 });
  const { meta: clamped } = await captureStill(browser, 'commit/box-clamped', {
    ...base,
    url: '/app.html',
    target: () => ({ x: 1300, y: 800, width: 400, height: 400 }),
  }, env(testInfo.outputPath('box-clamped')));
  expect([clamped.width, clamped.height]).toEqual([140, 100]);
});

test('a target under a fixed header scrolls below it', async ({ browser }, testInfo) => {
  let card = { x: 0, y: 0, width: 0, height: 0 };
  const options = (anchorHeader: boolean): ShotOptions => ({
    ...base,
    url: '/app.html',
    padding: 0,
    target: page => page.locator('#card'),
    actions: async ui => {
      // a header like the commit page's, two bars, and the card scrolled half under it
      await ui.page.evaluate(() => {
        for (const [id, top] of [['header', 0], ['header-2', 60]] as const) {
          const bar = document.createElement('div');
          bar.id = id;
          bar.style.cssText = `position: fixed; top: ${top}px; left: 0; right: 0; height: 60px; background: #cd4246; z-index: 10`;
          document.body.prepend(bar);
        }
        document.body.style.padding = '160px 24px 2000px';
        window.scrollTo(0, 120);
      });
      card = (await ui.page.locator('#card').boundingBox())!;
      expect(card.y).toBeLessThan(120);
      await ui.anchor('card', ui.page.locator('#card'));
      if (anchorHeader) await ui.anchor('header', ui.page.locator('#header-2'));
    },
  });
  const { meta } = await captureStill(browser, 'commit/under-header', options(false), env(testInfo.outputPath('under-header')));
  // the whole card...
  expect(Math.abs(meta.height - card.height)).toBeLessThanOrEqual(2);
  expect(meta.anchors.card).toMatchObject({ x: 0, y: 0, w: 100 });
  expect(meta.anchors.card.h).toBeGreaterThan(98);
  // ...and none of the header
  await expect(captureStill(browser, 'commit/under-header', options(true), env(testInfo.outputPath('under-header-2'))))
    .rejects.toThrow('anchor "header" is outside the shot');
});

test('a target in a fixed header is shot with it', async ({ browser }, testInfo) => {
  const { meta } = await captureStill(browser, 'commit/in-header', {
    ...base,
    url: '/app.html',
    padding: 0,
    // the header's field and the card below it, like the commit bars' filter box and a run card
    target: page => [page.locator('#header-field'), page.locator('#card')],
    actions: async ui => {
      await ui.page.evaluate(() => {
        const bar = document.createElement('div');
        bar.id = 'header';
        bar.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; height: 60px; background: #cd4246; z-index: 10';
        bar.innerHTML = '<input id="header-field" style="margin: 10px 24px; width: 200px">';
        document.body.prepend(bar);
        document.body.style.padding = '160px 24px 2000px';
      });
      await ui.anchor('field', ui.page.locator('#header-field'));
    },
  }, env(testInfo.outputPath('in-header')));
  // from the field, at the top of the viewport, to the card
  const field = meta.anchors.field;
  expect(field.y).toBeLessThan(5);
  expect(meta.height).toBeGreaterThan(150);
});

test.describe('login', () => {
  test("the project's persona is logged in by default", async ({ browser }, testInfo) => {
    const cookies = async (options: Partial<ShotOptions>) => {
      let value = '';
      await captureStill(browser, 'commit/login', {
        ...base, url: '/app.html', ...options,
        actions: async ui => { value = await ui.page.evaluate(() => document.cookie); },
      }, env(testInfo.outputPath('login')));
      return value;
    };
    expect(await cookies({ login: undefined })).toBe('session=ines');
    expect(await cookies({ login: 'tobias' })).toBe('session=tobias');
    expect(await cookies({ login: undefined, project: null })).toBe('');
  });
});

test.describe('clips', () => {
  test('cursor, ripples, captions and frames', async ({ browser }, testInfo) => {
    let ripples = 0;
    let scripted = 0;
    let waited = 0;
    const options: ClipOptions = {
      ...base,
      alt: 'The cursor hovers a box, clicks a button, types in a field and drags a handle.',
      url: '/app.html',
      region: page => page.locator('body'),
      poster: 1500,
      // before the recording: not drawn
      actions: async ui => {
        await ui.click(ui.page.locator('#counter-button'));
        expect(await ui.page.locator('#__shot-cursor').count()).toBe(0);
      },
      script: async ui => {
        const started = Date.now();
        const page = ui.page;
        expect(await page.locator('#count').textContent()).toBe('1');
        await ui.caption('Hover the box');
        await ui.cursor.moveTo(page.locator('#hover-target'));
        expect(await page.locator('#__shot-cursor').isVisible()).toBe(true);
        expect(await page.locator('#tip').isVisible()).toBe(true);
        await ui.hold(400);
        await ui.caption('Click, type, wheel and drag', { durationMs: 2000 });
        await ui.click(page.locator('#counter-button'));
        await ui.type(page.locator('#field'), 'abc', { delayMs: 40 });
        await ui.wheel(page.locator('#wheel-area'), 300, { steps: 3 });
        await ui.drag(page.locator('#drag-handle'), { x: 1100, y: 520 });
        await ui.anchor('field', page.locator('#field'));
        await ui.cursor.hide();
        expect(await page.locator('#__shot-cursor').isVisible()).toBe(false);
        await ui.hold(600);
        expect(await page.locator('#count').textContent()).toBe('2');
        // in full screen, the cursor is drawn in the full screen element
        await ui.click(page.locator('#fullscreen'));
        await ui.cursor.moveTo({ x: 300, y: 300 });
        expect(await page.evaluate(() => document.getElementById('__shot-cursor')?.parentElement?.id)).toBe('card');
        await ui.page.evaluate(() => document.exitFullscreen());
        // a wait, and a request during a hold: not recorded
        await page.evaluate(() => { void fetch('/api/slow?ms=1500'); });
        const waitStarted = Date.now();
        await ui.settle();
        await page.evaluate(() => { setTimeout(() => void fetch('/api/slow?ms=1000'), 100); });
        await ui.hold(300);
        waited = (Date.now() - waitStarted) / 1000;
        expect(await page.locator('#field').inputValue()).toBe('abc');
        // Chromium scales wheel deltas with the device scale factor: count the events
        expect(Number(await page.locator('#wheel-area').getAttribute('data-events'))).toBe(3);
        expect(Number(await page.locator('#wheel-area').getAttribute('data-total'))).toBeGreaterThan(0);
        ripples = await page.evaluate(() => (window as any).__ripples);
        scripted = (Date.now() - started) / 1000;
      },
    };
    const { dir, meta } = await captureClip(browser, 'commit/interactions', options, env(testInfo.outputPath('clip')));
    expect(ripples).toBeGreaterThanOrEqual(2); // click, and the click that focuses the field
    expect(meta.kind).toBe('clip');
    expect(meta.poster).toBe(1500);
    expect(meta.duration).toBeGreaterThan(3);
    expect(meta.duration).toBeLessThan(15);
    expect(meta.frames).toBeGreaterThan(30);
    // the clip lasts its scripted time, without the waits
    expect(waited).toBeGreaterThan(2.5);
    expect(meta.duration).toBeLessThan(scripted - waited + 0.5);
    expect(meta.anchors.field.w).toBeGreaterThan(0);

    // the concat list covers the whole clip
    const concat = fs.readFileSync(path.join(dir, 'frames.ffconcat'), 'utf8');
    const durations = [...concat.matchAll(/^duration (\S+)$/gm)].map(m => Number(m[1]));
    expect(durations.length).toBe(meta.frames);
    expect(durations.reduce((a, b) => a + b, 0)).toBeCloseTo(meta.duration, 1);
    expect(fs.readdirSync(path.join(dir, 'frames')).length).toBe(meta.frames);
    // the scale is the frames' (publish.py crops the region with it): within them
    const frame = jpegSize(fs.readFileSync(path.join(dir, 'frames', fs.readdirSync(path.join(dir, 'frames')).sort()[0])));
    expect(meta.scale).toBeCloseTo(frame.width / 1440, 2);
    expect((meta.region.x + meta.region.width) * meta.scale).toBeLessThanOrEqual(frame.width + 1);
    expect((meta.region.y + meta.region.height) * meta.scale).toBeLessThanOrEqual(frame.height + 1);

    // captions: two cues, timed from the first frame
    const vtt = fs.readFileSync(path.join(dir, 'captions.vtt'), 'utf8');
    const cues = [...vtt.matchAll(/^(\d\d:\d\d:\d\d\.\d{3}) --> (\d\d:\d\d:\d\d\.\d{3})$/gm)];
    expect(cues.length).toBe(2);
    const seconds0 = (t: string) => t.split(':').reduce((acc, v) => acc * 60 + Number(v), 0);
    expect(seconds0(cues[0][1])).toBeLessThan(0.2);
    const seconds = (t: string) => t.split(':').reduce((acc, v) => acc * 60 + Number(v), 0);
    expect(seconds(cues[1][2]) - seconds(cues[1][1])).toBeCloseTo(2, 1);

    // ffmpeg reads it: same duration at 30 fps
    const probe = path.join(dir, 'probe.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'frames.ffconcat'),
      '-vf', 'fps=30,scale=480:-2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', probe]);
    const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', probe], { encoding: 'utf8' }));
    expect(Math.abs(duration - meta.duration)).toBeLessThan(0.15);
  });

  test('ui.goto opens another page: loaded at once, the cursor where it was, masks applied', async ({ browser }, testInfo) => {
    let waited = 0;
    let scripted = 0;
    let content = '';
    let cursor = '';
    let maskedVisible = true;
    const { meta } = await captureClip(browser, 'commit/goto', {
      ...base,
      alt: 'The cursor moves over a run card, then another page opens, loaded.',
      url: '/app.html',
      // the spinner page's running batch spins forever: masked, it doesn't keep the page busy
      mask: page => [page.locator('#running')],
      script: async ui => {
        const started = Date.now();
        await ui.cursor.moveTo({ x: 400, y: 300 });
        await ui.hold(300);
        const navigating = Date.now();
        await ui.goto('/spinner.html');
        waited = (Date.now() - navigating) / 1000;
        content = (await ui.page.locator('#content').textContent()) ?? '';
        expect(await ui.page.locator('#content').isVisible()).toBe(true);
        cursor = await ui.page.locator('#__shot-cursor').evaluate(el => (el as HTMLElement).style.transform);
        maskedVisible = await ui.page.locator('#running').evaluate(el => getComputedStyle(el).visibility !== 'hidden');
        await ui.hold(300);
        scripted = (Date.now() - started) / 1000;
      },
    }, env(testInfo.outputPath('goto')));
    expect(content).toBe('Loaded');
    // the arrow's tip is at (3, 2) in its box
    expect(cursor).toBe('translate(397px, 298px)');
    expect(maskedVisible).toBe(false);
    // the page loads in a second (spinner.html's requests): not recorded
    expect(waited).toBeGreaterThan(1);
    expect(meta.duration).toBeLessThan(scripted - waited + 0.3);
  });
});
