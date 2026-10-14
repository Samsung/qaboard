// Runs before captures (the `setup` project): the demo facts exist, the stack answers, the fonts are the pinned ones.
import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { demo } from './demo';

// The web app's stacks (webapp/src/App.css, Blueprint) and the fonts they must resolve to, with docs-media/fonts.conf
const APP_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif';
const EXPECTED: Array<[string, string, string]> = [
  [APP_SANS, 'Runs 12 · PSNR 31.2 dB', 'Roboto'],
  ['monospace', 'out.png 1.2 MB', 'DejaVu Sans Mono'],
  [APP_SANS, '🏠', 'Noto Color Emoji'],
];
const PACKAGES = 'fonts-roboto fonts-dejavu-core fonts-noto-color-emoji fonts-jetbrains-mono';

test('demo facts and stack', async ({ request }) => {
  const d = demo();
  console.log(`[shots] demo: T0 ${d.t0.toISOString()}, ${d.baseUrl}, app ${d.appVersion}`);
  await expect(async () => {
    const response = await request.get(`${d.baseUrl}/api/v1/health`, { timeout: 5_000 });
    expect(response.ok()).toBeTruthy();
  }).toPass({ timeout: 60_000 });
});

async function platformFonts(page: Page, family: string, text: string) {
  await page.setContent(`<p id="t" style="font-family:${family.replace(/"/g, '&quot;')}">${text}</p>`);
  const client = await page.context().newCDPSession(page);
  await client.send('DOM.enable');
  await client.send('CSS.enable');
  const { root } = await client.send('DOM.getDocument');
  const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#t' });
  const { fonts } = await client.send('CSS.getPlatformFontsForNode', { nodeId });
  await client.detach();
  return fonts.map(f => f.familyName);
}

test('fonts', async ({ page }) => {
  test.skip(!!process.env.SHOTS_SKIP_FONT_CHECK, 'SHOTS_SKIP_FONT_CHECK is set');
  console.log(`[shots] fonts: FONTCONFIG_FILE=${process.env.FONTCONFIG_FILE}`);
  for (const family of ['Roboto', 'DejaVu Sans Mono', 'Noto Color Emoji']) {
    const match = execFileSync('fc-match', ['-f', '%{family}', family], { encoding: 'utf8' });
    expect(match.split(',').map(f => f.trim()), `fc-match "${family}" gives "${match}": install ${PACKAGES}`).toContain(family);
  }
  // what Chromium really draws with
  for (const [family, text, expected] of EXPECTED)
    expect(await platformFonts(page, family, text), `"${text}" in ${family}`).toEqual([expected]);
});
