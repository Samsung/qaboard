// Smoke tests: the production build, served by `vite preview`, with a mocked API.
// npm run build && npm run e2e
// Performance benchmark (e2e/perf/): npm run build && npm run bench
//   BENCH_BUILD_DIR=path/to/other/build compares with another build
import { defineConfig, devices } from '@playwright/test';

const port = 4173;

export default defineConfig({
  testDir: './e2e',
  testMatch: process.env.BENCH ? '**/*.bench.js' : '**/*.spec.js',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['junit', { outputFile: 'e2e-junit.xml' }]] : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      // To use a browser that's already installed instead of `npx playwright install chromium`
      launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined },
    },
  }],
  webServer: {
    command: `npx vite preview --port ${port} --strictPort${process.env.BENCH_BUILD_DIR ? ` --outDir ${process.env.BENCH_BUILD_DIR}` : ''}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
  },
});
