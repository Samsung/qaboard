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
