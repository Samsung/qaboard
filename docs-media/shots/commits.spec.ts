// A project's commits (docs-media/shots.yaml: commits/*): the sidebar's menus.
import { shot } from './lib';

const DE = 'detection-eval';

shot('commits/milestones-menu', {
  project: DE,
  // the abandoned entropy calibration branch, saved as a private milestone first
  url: d => d.commitUrl(DE, 'entropy-calib', { view: 'table-kpi' }),
  alt: 'The sidebar\'s Milestones menu on the detector\'s commits: the shared milestones kd-1.3 and kd-1.2, each with '
    + 'its branch, commit and author, then a private milestone, entropy-try, on the quant/entropy branch.',
  caption: 'The Milestones menu lists the shared milestones, then your private ones: pick one to compare with.',
  actions: async ui => {
    const { page } = ui;
    // A private milestone stays in the browser: the server must not get one. New milestones start shared
    await page.route('**/api/v1/project/milestones/**', route => route.abort());
    await ui.click(page.locator('button:has(.bp6-icon-star-empty)').first());
    const dialog = page.locator('.bp6-popover', { hasText: 'Milestone Info' });
    await dialog.waitFor();
    const shared = dialog.getByRole('switch', { name: 'Shared' }).or(dialog.locator('input[type="checkbox"]')).first();
    if (await shared.isChecked()) await ui.click(dialog.locator('label', { hasText: 'Shared' }));
    if (await shared.isChecked()) throw new Error('[commits.spec] the milestone would be shared');
    await ui.type(dialog.locator('#text-input'), 'entropy-try');
    await ui.type(dialog.locator('textarea'), 'entropy calibration: a little worse everywhere');
    await ui.click(dialog.getByRole('button', { name: 'Save' }));
    await dialog.waitFor({ state: 'hidden' });
    // the project's commits, without reloading the page (the milestone is in the app's state)
    await ui.click(page.locator('.bp6-menu-item, a', { hasText: /^detector$/ }).or(page.getByText('detector', { exact: true })).first());
    await page.waitForURL(/\/kitefin\/detector\/?(commits)?(\?.*)?$/);
    await ui.settle();
    // "set 1 hour ago": the private milestone was just saved, and "N seconds ago" would change from one capture to the next
    await page.clock.fastForward('01:00:00');
    await ui.hover(page.getByText('Milestones', { exact: true }).first());
    const menu = page.locator('.bp6-popover .bp6-menu', { hasText: 'Select a private milestone' });
    await menu.getByText('entropy-try').waitFor();
    await ui.settle();
  },
  // the sidebar's menu item and the menu
  target: page => [
    page.getByText('Milestones', { exact: true }).first().locator('xpath=ancestor::a[1]'),
    page.locator('.bp6-popover .bp6-menu', { hasText: 'Select a private milestone' }),
  ],
  padding: 8,
});
