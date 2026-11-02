// Storage usage (docs-media/shots.yaml: storage/*). Nothing is deleted: the delete dialog is cancelled.
//
// - The usage comes from the `storage_usage` table, which the backend's jobs worker computes when it first starts on a
//   database (a restored snapshot): storageUsageReady() waits for it.
// - Users see other people's usage in the projects where they're members (a grant, a group...): Ines, the camera ISP's
//   lead, is made a developer of kitefin/camera-isp while these shots are taken. Adaeze is the demo stack's admin.
// - "Updated <when>" says when the server last computed the usage, by the server's clock (the time of the capture), while
//   the page's clock is at T0: it's masked.
import { test } from '@playwright/test';
import { shot, type Locator, type Page } from './lib';
import { demo } from './lib/demo';
import { ADMIN, apiAs, removeMembers, setMembers, storageUsageReady } from './demoState';

const ISP = 'kitefin/camera-isp';
// where the demo's results are, as the server sees them (docs-media/compose.demo.yml)
const RESULTS = (process.env.QABOARD_DEMO_RESULTS || '/mnt/qaboard').replace(/\/+$/, '');
const MEMBERS = { ines: 'developer' } as const;

test.beforeAll(async () => {
  const admin = await apiAs(demo(), ADMIN);
  try {
    await storageUsageReady(admin);
    await setMembers(admin, ISP, MEMBERS);
  } finally {
    await admin.dispose();
  }
});

test.afterAll(async () => {
  const admin = await apiAs(demo(), ADMIN);
  try {
    await removeMembers(admin, ISP, Object.keys(MEMBERS));
  } finally {
    await admin.dispose();
  }
});

// Narrower than the default, so that the tables' text stays readable once the shot is scaled down in a page or an email
const VIEWPORT = { width: 1200, height: 1100 };
const updated = (page: Page) => [page.getByText(/^Updated /)];
const rows = (page: Page) => page.getByRole('table').last().locator('tbody > tr');

// From the top of `top` to the bottom of `bottom`, the page's width: a table's rows are too close for a padding
async function between(page: Page, top: Locator, bottom: Locator, padding = 16) {
  const [a, b] = [await top.boundingBox(), await bottom.boundingBox()];
  const width = page.viewportSize()?.width ?? 1440;
  if (!a || !b) throw new Error('[storage.spec] an element of the shot has no box');
  return { x: a.x - padding, y: a.y - padding, width: width - 2 * (a.x - padding), height: b.y + b.height - a.y + padding + 2 };
}

shot('storage/batches', {
  project: null,
  login: 'ines',
  url: d => `${d.baseUrl}/storage/batches?scope=all&project=${encodeURIComponent(ISP)}`,
  alt: 'Storage usage of everyone\'s runs in kitefin/camera-isp: 2.2 GB in 42 batches, mostly the CI\'s. The Batches '
    + 'tab lists them biggest first, each with its commit, branch, folder and who ran it; the two milestones have a lock.',
  caption: 'The biggest batches first: milestones are locked, the others can be checked and their files deleted.',
  // the batches' table needs the width
  viewport: { width: 1440, height: 1100 },
  mask: updated,
  actions: async ui => {
    await rows(ui.page).nth(6).waitFor();
    await ui.cursor.moveTo({ x: 1420, y: 1080 });
    await ui.settle();
  },
  // down to the second milestone
  target: page => between(page, page.getByRole('heading', { name: 'Storage usage' }), rows(page).nth(5)),
});

shot('storage/delete', {
  project: null,
  login: 'ines',
  url: d => `${d.baseUrl}/storage/batches?scope=all&project=${encodeURIComponent(ISP)}`,
  alt: 'The "Delete the runs\' files" dialog for everything in kitefin/camera-isp, as Ines: 196 MB freed, the files of '
    + 'her 65 runs in 2 batches. Kept: other people\'s runs, 800 runs (2.0 GB) run by ci, which they or an admin can delete.',
  caption: 'Before deleting, QA-Board says how much space it frees, and what it keeps: here, the runs other people ran.',
  viewport: { width: 1440, height: 1100 },
  mask: updated,
  actions: async ui => {
    await ui.click(ui.page.getByRole('button', { name: /^Delete all runs that match/ }));
    const dialog = ui.page.getByRole('dialog', { name: 'Delete the runs\' files' });
    await dialog.getByText('Kept', { exact: true }).waitFor();
    await ui.cursor.moveTo({ x: 1180, y: 1080 });
    await ui.settle();
  },
  // the dialog alone: the page's text behind the backdrop would be cut
  target: page => page.getByRole('dialog', { name: 'Delete the runs\' files' }),
  padding: 0,
});

shot('storage/users', {
  project: null,
  login: ADMIN,
  url: d => `${d.baseUrl}/storage/users?scope=all`,
  alt: 'Storage usage, the Users tab of everyone\'s runs: five people use 3.7 GB. The CI uses 91% of it, mostly in '
    + 'kitefin/camera-isp, then Ines, Arjun, Mira and Kaito, each with their share, runs, batches and biggest project.',
  caption: 'Who uses the most, and where: click someone to see their runs.',
  viewport: VIEWPORT,
  mask: updated,
  actions: async ui => {
    await rows(ui.page).nth(4).waitFor();
    await ui.cursor.moveTo({ x: 1180, y: 1080 });
    await ui.settle();
  },
  target: page => [page.getByRole('heading', { name: 'Storage usage' }), rows(page).last()],
});

shot('storage/folders', {
  project: null,
  login: 'ines',
  url: d => `${d.baseUrl}/storage/folders`,
  alt: 'Storage usage, the Folders tab of Ines\'s runs, with /mnt/qaboard/kitefin/camera-isp pasted and opened: 196 MB '
    + 'known to QA-Board there, all in one row, 57/647d61d9314f3b/output, with 65 runs in 2 batches, and buttons to show '
    + 'these runs or delete their files.',
  caption: 'Paste the folder of a quota alert to see what QA-Board knows there: folders that only lead to one subfolder are skipped.',
  viewport: VIEWPORT,
  mask: updated,
  actions: async ui => {
    // the project's folder, like a quota alert would name it
    await ui.type(ui.page.getByRole('textbox', { name: 'Folder' }), `${RESULTS}/${ISP}`);
    await ui.click(ui.page.getByRole('button', { name: 'Open', exact: true }));
    await rows(ui.page).first().waitFor();
    await ui.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await ui.cursor.moveTo({ x: 1180, y: 1080 });
    await ui.settle();
  },
  target: page => [page.getByRole('tablist'), rows(page).last()],
});
