// Temporary exploration script (not committed): node zz-explore.mjs <url> <out.png> [js to eval after load]
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const [url, out, evalJs, waitMs = '4000'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  env: { ...process.env, FONTCONFIG_FILE: new URL('../fonts.conf', import.meta.url).pathname } });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC' });
await context.addInitScript(() => {
  try { localStorage.setItem('qaboard.release-notes.last-seen', '2026-10-08'); localStorage.setItem('controls-panel-expanded', 'false'); } catch {}
});
// Trial only: pretend the project sets outputs.style.width (EXPLORE_WIDTH=1180px)
if (process.env.EXPLORE_WIDTH) {
  const patch = o => {
    if (!o || typeof o !== 'object') return;
    if (o.qatools_config?.outputs) o.qatools_config.outputs.style = { width: process.env.EXPLORE_WIDTH };
    Object.values(o).forEach(patch);
  };
  await context.route(/\/api\/v1\/(project|commit)/, async route => {
    const response = await route.fetch();
    const json = await response.json();
    patch(json);
    await route.fulfill({ response, json });
  });
}
if (process.env.EXPLORE_LOGIN) {
  const r = await context.request.post('http://localhost:5151/api/v1/user/auth/', { form: { username: process.env.EXPLORE_LOGIN, password: 'kitefin-demo' } });
  console.log('login', r.status(), (await r.text()).slice(0, 200));
}
const page = await context.newPage();
await page.clock.install({ time: new Date('2026-10-08T16:00:00Z') });
await page.clock.resume();
page.on('console', m => { if (m.type() === 'error') console.log('console error:', m.text().slice(0, 200)); });
page.on('response', r => { if (r.status() >= 400) console.log('HTTP', r.status(), r.url().slice(0, 200)); });
await page.goto(url);
await page.waitForTimeout(Number(waitMs));
if (evalJs) {
  const fn = new Function('page', `return (async () => { ${evalJs} })()`);
  const result = await fn(page);
  if (result !== undefined) console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 1));
}
await page.screenshot({ path: out });
await browser.close();
