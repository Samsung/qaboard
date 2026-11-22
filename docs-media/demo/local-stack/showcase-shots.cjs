// Screenshots of logged series and media for a showcase, from the local demo stack (see README.md), written to the
// current folder: node docs-media/demo/local-stack/showcase-shots.cjs [scale]. Checked by eye, not part of docs-media's shots.
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }
const stack = process.env.QABOARD_LOCAL_STACK || path.join(require('os').tmpdir(), 'qaboard-local-stack');
const urls = require(path.join(stack, 'seeded.json')).urls;
const scale = Number(process.argv[2] || 2);
const H = 2200, TOP = 190;   // below the commit page's fixed header
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: H }, deviceScaleFactor: scale });
  await ctx.addInitScript(() => localStorage.setItem('qaboard.release-notes.last-seen', '9999-12-31'));
  // from the top of `from` (minus `above`) to the bottom of `to`, in the viewport: no stitching, no fixed header over it
  const shot = async (page, from, name, { to = from, above = 6, settle = 2500, x0 = null, height = null, width = null } = {}) => {
    await from.evaluate((el, top) => window.scrollBy(0, el.getBoundingClientRect().top - top), TOP + above); await wait(settle);
    const a = await from.boundingBox(), z = await to.boundingBox();
    const x = x0 ?? a.x - 6, y = a.y - above, w = width ?? Math.max(a.x + a.width, z.x + z.width) + 6 - x, h = height ?? Math.min(z.y + z.height + 6, H) - y;
    await page.screenshot({ path: `${name}.png`, clip: { x, y, width: w, height: h }, animations: 'disabled' });
    console.log('saved', name, Math.round(w), Math.round(h));
  };
  const open = async url => {
    const p = await ctx.newPage(); p.on('pageerror', e => console.log('pageerror', e.message));
    await p.goto(url, { waitUntil: 'networkidle', timeout: 60000 }); await wait(10000); return p;
  };
  const p = await open(urls['new run vs reference']);
  const key = k => p.locator(`[data-key="${k}"]`).first();
  const series = p.getByTestId('series-viewer').first();
  await shot(p, series, '01-series', { above: 92 });
  await shot(p, p.getByTestId('media-summary').first(), '02-media', { to: key('val/samples') });
  await shot(p, key('val/detections/harbor'), '03-boxes');
  await key('predictions').getByRole('button', { name: 'Diff' }).click(); await wait(1000);
  await shot(p, key('predictions'), '04-table-diff');
  await shot(p, key('weights/conv1'), '05-histogram');
  await key('denoise/audio').getByText('Spectrogram').first().click(); await wait(1500);
  await shot(p, key('denoise/audio'), '06-audio', { settle: 4000 });
  await shot(p, key('answers/prompt-1'), '07-text', { settle: 4000 });
  await key('val/samples').locator('button[aria-label^="Evolution of"]').first().click(); await wait(3000);
  await shot(p, p.getByTestId('evolution-strip').first(), '08-evolution', { settle: 3000 });
  const s = await open(urls['lr sweep, summary']);
  const heading = s.getByText(/^Logged series/).first();
  await shot(s, heading, '09-sweep', { above: 20, settle: 3000, height: 1010, width: 880 });
  // the plot under val/psnr: extend to the footer
  const w = await open(urls['wandb shim']);
  await shot(w, w.getByTestId('media-summary').first(), '10-wandb', { to: w.locator('[data-key="denoise/audio"]').first() });
  await b.close();
})();
