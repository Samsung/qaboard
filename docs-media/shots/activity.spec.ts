// Runs activity (docs-media/shots.yaml: activity/*).
//
// The page shows what waits, runs and ended relative to the server's clock, not the browser's: the demo stack's
// server runs at the time of the capture, days or weeks after T0, so its timeline and "ended in the last 24 hours" are
// empty, and the runs the stories leave running at T0 (one CI batch per project) are pending for days. What holds on
// every capture made over a week after T0 is that those 39 runs are stuck: the page offers admins to clean them up.
import { test } from '@playwright/test';
import { shot } from './lib';
import { demo } from './lib/demo';
import { ADMIN } from './demoState';

const DAY = 24 * 3600 * 1000;

shot('activity/stuck-runs', {
  project: null,
  login: ADMIN,
  url: d => `${d.baseUrl}/activity?scope=all`,
  alt: 'Runs activity, everyone\'s runs: 28 runs waiting and 11 running, 39 of them pending for over a day, none ended. '
    + 'A warning says 39 runs have been pending for over a week, with buttons to show them, mark them as failed, or do '
    + 'it every night.',
  caption: 'Runs whose job died stay "running" until they\'re marked as failed: admins do it now, or every night.',
  actions: async ui => {
    // the runs the stories leave running must be pending for over a week by the server's clock
    test.skip(Date.now() - demo().t0.getTime() < 8 * DAY, 'the demo\'s running batches are pending for less than a week');
    await ui.page.getByTestId('stuck').waitFor();
    await ui.cursor.moveTo({ x: 1080, y: 880 });
    await ui.settle();
  },
  // narrower than the default, to stay readable once scaled down in a page or an email
  viewport: { width: 1100, height: 900 },
  target: page => [page.getByRole('heading', { name: 'Runs activity' }), page.getByTestId('stuck')],
  // the timeline is 16 px under the warning
  padding: 12,
});
