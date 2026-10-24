// The home page, the list of projects (docs-media/shots.yaml: projects/*). Not tied to one demo project: every
// project of the snapshot shows.
import { shot } from './lib';

shot('projects/home', {
  project: null,
  login: 'ines',
  url: d => `${d.baseUrl}/`,
  alt: 'Explore, the QA-Board home page: a filter box, then the Kitefin projects grouped by their path, each card with '
    + 'its avatar, name, description, when it was last used, its runs over 30 days, a star to pin it and a link to its source.',
  caption: 'Explore lists every project with results, grouped by their path. Pin the ones you follow with their star.',
  actions: async ui => {
    // favorites live in the browser: pin the camera pipeline
    const card = ui.page.locator('.bp6-card', { hasText: 'kitefin/camera-isp' }).first();
    await ui.click(card.locator('button', { has: ui.page.locator('.bp6-icon-star-empty') }).first());
    // no focus ring left on the star
    await ui.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await ui.cursor.moveTo({ x: 1300, y: 860 });
    await ui.settle();
  },
  // from the navigation bar to the last project
  target: page => [page.locator('.bp6-navbar').first(), page.locator('.bp6-card').last()],
  padding: 24,
});
