// Captures for the docs (docs-media/README.md). Each shot()/clip() is one test, tagged @still or @clip.
//   npm run capture                          # every shot, against the restored demo stack
//   SHOTS_ONLY='commit/image-*' npm run capture
//   npm test                                 # the lib's own tests, on local fixture pages
// PLAYWRIGHT_CHROMIUM_EXECUTABLE uses a Chromium that's already installed instead of `npx playwright install chromium`.
import path from 'node:path';
import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';

// Only the pinned fonts (docs-media/fonts.conf), whatever the host has. SHOTS_FONTCONFIG_FILE overrides it.
const FONTCONFIG_FILE = process.env.SHOTS_FONTCONFIG_FILE || path.resolve(import.meta.dirname, '..', 'fonts.conf');
process.env.FONTCONFIG_FILE = FONTCONFIG_FILE;

const rendering: PlaywrightTestConfig['use'] = {
  browserName: 'chromium',
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  locale: 'en-US',
  timezoneId: 'UTC',
  colorScheme: 'light',
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    env: { ...process.env, FONTCONFIG_FILE },
    // the same rendering on every machine: no GPU, no font hinting differences from the host
    args: ['--disable-gpu', '--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb', '--hide-scrollbars'],
  },
};

export default defineConfig({
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // One capture at a time: clips record scripted time only (lib/record.ts), but their waits for the page to draw are
  // shorter on a machine that isn't busy
  workers: process.env.SHOTS_WORKERS ? Number(process.env.SHOTS_WORKERS) : 1,
  timeout: 120_000,
  reporter: process.env.CI ? [['list'], ['junit', { outputFile: '../out/junit.xml' }]] : 'list',
  outputDir: '../out/test-results',
  use: rendering,
  projects: [
    // Before capturing: the demo facts, the stack answers, the pinned fonts
    { name: 'setup', testDir: './lib', testMatch: 'capture.setup.ts' },
    {
      name: 'stills',
      testDir: '.',
      testMatch: '*.spec.ts',
      grep: /@still/,
      dependencies: ['setup'],
      use: { ...rendering, reducedMotion: 'reduce' },
    },
    {
      name: 'clips',
      testDir: '.',
      testMatch: '*.spec.ts',
      grep: /@clip/,
      dependencies: ['setup'],
      use: { ...rendering, reducedMotion: 'no-preference' },
    },
    // The lib's tests: fixture pages served locally, no demo stack needed
    { name: 'lib', testDir: './lib/test', testMatch: '*.test.ts', use: rendering },
  ],
});
