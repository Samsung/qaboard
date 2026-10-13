// What's new (docs-media/shots.yaml: whats-new/*): the release notes of the web app's build, from
// website/release-notes/. At T0 (a Thursday in October), September's note is the newest finished one, October's is
// "In progress".
import { shot } from './lib';

// The last note this browser has seen: March's, so the newer finished ones are new
const lastSeen = { 'qaboard.release-notes.last-seen': '2026-03' };

shot('whats-new/dialog', {
  project: null,
  login: 'ines',
  url: d => `${d.baseUrl}/`,
  storage: lastSeen,
  alt: 'The "What\'s new in QA-Board" dialog over the projects list: the latest release note\'s summary, its highlights '
    + 'as cards with an icon, an audience tag and a link to the docs, and the See all changes and Got it buttons.',
  caption: 'Once a month is over, What\'s new pops up with its highlights, tagged with who they matter to.',
  actions: async ui => {
    // it opens a second after the notes load
    await ui.page.getByRole('dialog').waitFor();
    await ui.settle();
  },
  target: page => page.getByRole('dialog'),
  padding: 0,
});

shot('whats-new/drawer', {
  project: null,
  login: 'ines',
  // the link that opens the panel
  url: d => `${d.baseUrl}/#whats-new`,
  storage: lastSeen,
  alt: 'The What\'s new panel: a search box, then the release notes newest first. The current month\'s note is tagged '
    + 'In progress and open on its highlights; the notes not seen yet are tagged New.',
  caption: 'The What\'s new panel keeps every release note, newest first, with a search box. The current month shows as '
    + 'In progress.',
  actions: async ui => {
    const drawer = ui.page.locator('.bp6-drawer');
    await drawer.waitFor();
    await ui.settle();
    // the newest note opens on all its changes: fold them, so that the next note, a new one, shows too
    await ui.click(drawer.getByRole('button', { name: 'Hide details' }).first());
    // no focus ring left on the button
    await ui.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await ui.cursor.moveTo({ x: 300, y: 860 });
    await ui.settle();
  },
  target: page => page.locator('.bp6-drawer'),
  padding: 0,
});
