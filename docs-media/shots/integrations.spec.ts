// The sidebar's Integrations menu (docs-media/shots.yaml: integrations/*), from the camera ISP's qaboard.yaml: two
// links and a webhook, answered by the demo stack's stub of *.kitefin.example.
import { shot } from './lib';

const IQ = 'image-quality';

shot('integrations/menu', {
  project: IQ,
  // one run: the page behind the menu loads fast
  url: d => d.commitUrl(IQ, 'merge-bilateral', { reference: 'isp-4-1', view: 'output-list', filter: 'photos/facade base linux' }),
  alt: 'The sidebar\'s Integrations menu open on a commit: links to the K3 calibration report and the ISP tuning guide, '
    + 'and the "Send to the tuning bench" webhook, with a status tag saying its job is queued.',
  caption: 'Integrations link to your tools and trigger them: after a click, the webhook\'s tag shows the job\'s status.',
  actions: async ui => {
    const menu = ui.page.getByRole('menuitem', { name: 'Integrations' }).first();
    // Once open, the menu checks its links every 5 s (a HEAD through the server): during the first check, a link is
    // greyed out. Its answer, before the shot
    const linksChecked = ui.page.waitForResponse(response => response.url().includes('/api/v1/webhook/proxy/')
      && (response.request().postData() ?? '').includes('isp-tuning-guide'), { timeout: 30_000 });
    await ui.hover(menu);
    const webhook = ui.page.getByRole('menuitem', { name: 'Send to the tuning bench' });
    await webhook.waitFor();
    await ui.click(webhook);
    await ui.settle();
    // the status tag, with the job's status
    await webhook.locator('.bp6-tag').waitFor();
    // back on Integrations, the menu stays open with no item highlighted, and no focus ring on the webhook
    await ui.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await ui.hover(menu);
    await linksChecked;
    await ui.settle();
  },
  target: page => [
    page.getByRole('menuitem', { name: 'Integrations' }).first(),
    page.locator('.bp6-popover .bp6-menu', { hasText: 'Send to the tuning bench' }),
  ],
  padding: 4,
});

// An organized menu: dividers with titles, a submenu of CI jobs, an item's label and intent, the search box past 5
// items. The demo projects' qaboard.yaml only have links and a webhook (changing examples/ reseeds the demo data), so
// this shot shows the docs' own example: the snippet of "Organize the menu" in
// website/docs/triggering-external-ci-tools.mdx, keep them the same. It is injected in the API's answer for the
// commit (its qaboard.yaml, data.qatools_config.integrations), not the camera ISP's config: the web app renders it as
// it would for a commit with that qaboard.yaml. No job is started, so the CI items show no status, as before a
// click (a status would need a real GitLab and Jenkins).
const ORGANIZED_MENU = [
  { text: 'ISP tuning guide', icon: 'manual', href: 'https://docs.kitefin.example/imaging/isp-tuning-guide' },
  { text: 'Release checklist', icon: 'build', label: 'docs', intent: 'danger' },
  { divider: true, title: 'CI' },
  {
    text: 'Builds', icon: 'box', sub: [
      { text: 'Linux', gitlabCI: { job_name: 'build-linux' } },
      { text: 'Windows', jenkins: { build_url: 'https://jenkins.kitefin.example/job/camera-isp-windows' } },
    ],
  },
  { divider: true, title: 'Tuning' },
  { text: 'Send to the tuning bench', icon: 'send-to', webhook: { url: 'http://tuning-bench.kitefin.example/api/jobs', method: 'POST' } },
];

shot('integrations/organized-menu', {
  project: IQ,
  url: d => d.commitUrl(IQ, 'merge-bilateral', { reference: 'isp-4-1', view: 'output-list', filter: 'photos/facade base linux' }),
  alt: 'The Integrations menu with a search box at the top, the ISP tuning guide link, a red Release checklist item '
    + 'labeled docs, a divider titled CI over a Builds submenu open on its Linux and Windows jobs, each with a play icon, '
    + 'and a divider titled Tuning over a webhook.',
  caption: 'Dividers with titles group the items, a submenu holds the CI jobs, and past 5 items a search box filters '
    + 'them. The jobs start on a click.',
  actions: async ui => {
    const { page, demo: d } = ui;
    const sha = d.sha(IQ, 'merge-bilateral');
    await page.route(`**/api/v1/commit/${sha}*`, async route => {
      const response = await route.fetch();
      const commit = await response.json();
      if (commit?.data?.qatools_config) commit.data.qatools_config.integrations = ORGANIZED_MENU;
      await route.fulfill({ response, json: commit });
    });
    await page.reload();
    await ui.settle();
    const menu = page.getByRole('menuitem', { name: 'Integrations' }).first();
    // the menu checks its links when it opens (a HEAD through the server): during the check, a link is greyed out
    const linksChecked = page.waitForResponse(response => response.url().includes('/api/v1/webhook/proxy/')
      && (response.request().postData() ?? '').includes('isp-tuning-guide'), { timeout: 30_000 });
    await ui.hover(menu);
    await page.getByRole('searchbox', { name: 'Search integrations' }).or(page.getByLabel('Search integrations')).first().waitFor();
    await linksChecked;
    const builds = page.getByRole('menuitem', { name: 'Builds' });
    await ui.hover(builds);
    await page.getByRole('menuitem', { name: 'Windows' }).waitFor();
    await ui.settle();
  },
  target: page => [
    page.getByRole('menuitem', { name: 'Integrations' }).first(),
    page.locator('.bp6-popover .bp6-menu', { hasText: 'Release checklist' }).first(),
    // the submenu, nested in the menu's Builds item
    page.locator('.bp6-popover .bp6-menu', { hasText: 'Windows', hasNotText: 'Builds' }),
  ],
  padding: 4,
});
