/**
 * Tests for the "What's new" release notes.
 * Run with: cd webapp && npm test -- releaseNotes
 */
import fs from 'fs';
import path from 'path';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { IconNames } from '@blueprintjs/icons';

import bundle from 'virtual:release-notes';
import {
  LAST_SEEN_KEY,
  popupNotes,
  unseenNotes,
  periodEnd,
  isPreview,
  lastSeenSlug,
  resolveLink,
  searchNotes,
  renderHtml,
} from '../logic';
import { ReleaseNotesProvider, WhatsNewButton } from '../ReleaseNotes';
import { renderWithProviders } from '../../test-utils';


const note = (slug, date, extra = {}) => ({
  slug, date, title: slug, period: slug, version: null, description: `About ${slug}`,
  highlights: [], html: '', ...extra,
});
const notes = [note('2026-10', '2026-10-01'), note('2026-09', '2026-09-30'), note('2026-q2', '2026-06-30')];
const now = new Date('2026-10-05T12:00:00Z');


describe('which notes are new', () => {
  test('period ends', () => {
    expect(periodEnd(note('2026-02', '2026-02-03'))).toBe('2026-02-28');
    expect(periodEnd(note('2024-02', '2024-02-03'))).toBe('2024-02-29');
    expect(periodEnd(note('2026-q3', '2026-07-01'))).toBe('2026-09-30');
    expect(periodEnd(note('2026-q4', '2026-07-01'))).toBe('2026-12-31');
    expect(periodEnd(note('2019', '2019-05-01'))).toBe('2019-12-31');
    expect(periodEnd({ ...note('x', '2026-05-01'), period: 'whatever' })).toBe('2026-05-01');
  });
  test('the current period is a preview, until its last day included', () => {
    expect(isPreview(notes[0], now)).toBe(true);
    expect(isPreview(notes[0], new Date('2026-10-31T12:00:00Z'))).toBe(true);
    expect(isPreview(notes[0], new Date('2026-11-01T12:00:00Z'))).toBe(false);
    expect(isPreview(notes[1], now)).toBe(false);
  });
  test('without a last seen period, finished notes are unseen but only the recent ones pop up', () => {
    expect(unseenNotes(notes, null, now).map(n => n.slug)).toEqual(['2026-09', '2026-q2']);
    expect(popupNotes(notes, null, now).map(n => n.slug)).toEqual(['2026-09']);
  });
  test('the current period pops up once it is over, with the changes added meanwhile', () => {
    // read in October: September is remembered, not the October preview
    expect(lastSeenSlug(notes, now)).toBe('2026-09');
    expect(popupNotes(notes, '2026-09', now)).toEqual([]);
    const november = new Date('2026-11-02T12:00:00Z');
    expect(popupNotes(notes, '2026-09', november).map(n => n.slug)).toEqual(['2026-10']);
    expect(lastSeenSlug(notes, november)).toBe('2026-10');
    // editing or re-dating a finished note doesn't notify again
    expect(popupNotes([note('2026-10', '2026-11-20'), ...notes.slice(1)], '2026-10', november)).toEqual([]);
  });
  test('dates stored by older versions are still understood', () => {
    // the October note was seen mid-October: it pops up again once October is over
    expect(popupNotes(notes, '2026-10-01', now)).toEqual([]);
    expect(popupNotes(notes, '2026-10-01', new Date('2026-11-02T12:00:00Z')).map(n => n.slug)).toEqual(['2026-10']);
    expect(popupNotes(notes, '2026-09-29', now).map(n => n.slug)).toEqual(['2026-09']);
  });
});


describe('links', () => {
  test('docs links use docs_root', () => {
    expect(resolveLink('/docs/user-guide/overview', 'https://example.com/qaboard/')).toBe('https://example.com/qaboard/docs/user-guide/overview');
    expect(resolveLink('/docs/x', '/')).toBe('/docs/x');
  });
  test('release notes links open the panel, full URLs are kept', () => {
    expect(resolveLink('/release-notes/2026-10', '/')).toBe('#whats-new');
    expect(resolveLink('https://github.com', '/')).toBe('https://github.com');
  });
  test('links open in a new tab, except links to release notes', () => {
    const html = renderHtml('<p><a href="/docs/faq">faq</a> <a href="/release-notes/2026-10">oct</a></p>', '/');
    expect(html).toBe('<p><a href="/docs/faq" target="_blank" rel="noopener noreferrer">faq</a> <a href="#whats-new">oct</a></p>');
  });
});


test('search matches every word, in any field', () => {
  const searchable = [
    note('a', '2026-01-01', { html: '<li>Added a <code>dask</code> runner</li>' }),
    note('b', '2026-02-01', { highlights: [{ title: 'Faster image viewer', description: 'Sync zoom', audience: 'admins' }] }),
  ];
  expect(searchNotes(searchable, '').map(n => n.slug)).toEqual(['a', 'b']);
  expect(searchNotes(searchable, 'DASK runner').map(n => n.slug)).toEqual(['a']);
  expect(searchNotes(searchable, 'zoom admins').map(n => n.slug)).toEqual(['b']);
  expect(searchNotes(searchable, 'zoom dask')).toEqual([]);
});


describe('the bundle', () => {
  // vite bundles website/release-notes/*.md (see webapp/releaseNotes.js)
  const notes_dir = path.join(import.meta.dirname, '../../../../website/release-notes');
  const sources = fs.readdirSync(notes_dir).filter(f => f.endsWith('.md') && !f.startsWith('_'));

  test('has every published note of website/release-notes/', () => {
    const published = sources.filter(f => !/^draft:\s*true/m.test(fs.readFileSync(path.join(notes_dir, f), 'utf-8')));
    expect(published.length).toBeGreaterThan(0);
    expect(bundle.notes.length).toBe(published.length);
  });

  test('uses valid icons and audiences', () => {
    const icons = new Set(Object.values(IconNames));
    for (const n of bundle.notes)
      for (const h of n.highlights) {
        expect([n.slug, h.title, icons.has(h.icon || 'star')]).toEqual([n.slug, h.title, true]);
        expect(['users', 'project-integration', 'admins', undefined]).toContain(h.audience);
      }
  });

  test('has no raw HTML (it is escaped)', () => {
    for (const n of bundle.notes)
      expect([n.slug, /<(script|iframe|style|img)\b|\son\w+=|javascript:/i.test(n.html)]).toEqual([n.slug, false]);
  });

  test('is sorted newest first', () => {
    const dates = bundle.notes.map(n => n.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });
});


describe('the What\'s new popup', () => {
  // last month: finished, and recent enough to pop up
  const d = new Date();
  const lastMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
  const slug = lastMonth.toISOString().slice(0, 7);
  const recent = note(slug, lastMonth.toISOString().slice(0, 10), {
    title: 'Last month',
    highlights: [{ title: 'Flying cars', description: 'They fly.', audience: 'users', icon: 'airplane', link: '/docs/faq' }],
    html: '<h2>Web app</h2><ul><li>Added flying cars</li></ul>',
  });
  const renderApp = () => renderWithProviders(
    <ReleaseNotesProvider load={() => Promise.resolve([recent])} popupDelay={0}>
      <WhatsNewButton />
    </ReleaseNotesProvider>,
    { siteConfig: { docs_root: '/' } }
  );
  beforeEach(() => window.localStorage.clear());

  test('opens once for new notes, then the button reopens them', async () => {
    renderApp();
    expect(await screen.findByText('Flying cars')).toBeInTheDocument();
    expect(screen.getByTestId('whats-new-unread')).toBeInTheDocument();
    expect(screen.getByText('Learn more').closest('a')).toHaveAttribute('href', '/docs/faq');

    fireEvent.click(screen.getByText('Got it'));
    expect(window.localStorage.getItem(LAST_SEEN_KEY)).toBe(slug);
    await waitFor(() => expect(screen.queryByTestId('whats-new-unread')).not.toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("What's new"));
    expect(await screen.findByPlaceholderText(/search the release notes/i)).toBeInTheDocument();
    expect(screen.getByText('Added flying cars')).toBeInTheDocument();
  });

  test('does not open for notes already seen', async () => {
    window.localStorage.setItem(LAST_SEEN_KEY, slug);
    renderApp();
    // let the notes load
    await waitFor(() => expect(screen.getByLabelText("What's new")).toBeInTheDocument());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.queryByText('Flying cars')).not.toBeInTheDocument();
    expect(screen.queryByTestId('whats-new-unread')).not.toBeInTheDocument();
  });

  test('opens on any page, and navigating afterwards does not reopen it', async () => {
    window.history.pushState({}, '', '/some/project/commit/abc');
    const { rerender } = renderApp();
    expect(await screen.findByText('Flying cars')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Got it'));
    await waitFor(() => expect(screen.queryByText('Flying cars')).not.toBeInTheDocument());
    window.history.pushState({}, '', '/other/project');
    rerender(
      <ReleaseNotesProvider load={() => Promise.resolve([recent])} popupDelay={0}>
        <WhatsNewButton />
      </ReleaseNotesProvider>
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.queryByText('Flying cars')).not.toBeInTheDocument();
  });

  test('does not pop up the current period, but shows it in the panel as in progress', async () => {
    const current = note(new Date().toISOString().slice(0, 7), new Date().toISOString().slice(0, 10), {
      highlights: [{ title: 'Hover boards', description: 'Soon.', audience: 'users', icon: 'airplane' }],
    });
    renderWithProviders(
      <ReleaseNotesProvider load={() => Promise.resolve([current])} popupDelay={0}>
        <WhatsNewButton />
      </ReleaseNotesProvider>,
      { siteConfig: { docs_root: '/' } }
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.queryByText('Hover boards')).not.toBeInTheDocument();
    expect(screen.queryByTestId('whats-new-unread')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("What's new"));
    expect(await screen.findByText('Hover boards')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    // seeing the preview doesn't count as seeing the period
    expect(window.localStorage.getItem(LAST_SEEN_KEY)).toBe(null);
  });
});
