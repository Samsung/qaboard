/**
 * Tests for the "What's new" release notes.
 * Run with: cd webapp && npm test -- --testPathPattern=releaseNotes
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Provider } from 'react-redux';
import { createStore } from 'redux';
import { IconNames } from '@blueprintjs/icons';

import bundle from '../release-notes.json';
import {
  LAST_SEEN_KEY,
  popupNotes,
  unseenNotes,
  newestDate,
  resolveLink,
  searchNotes,
  renderHtml,
} from '../logic';
import { ReleaseNotesProvider, WhatsNewButton } from '../ReleaseNotes';


const note = (slug, date, extra = {}) => ({
  slug, date, title: slug, period: slug, version: null, description: `About ${slug}`,
  highlights: [], html: '', ...extra,
});
const notes = [note('2026-10', '2026-10-01'), note('2026-09', '2026-09-30'), note('2026-q2', '2026-06-30')];
const now = new Date('2026-10-05T12:00:00Z');


describe('which notes are new', () => {
  test('without a last seen date, all notes are unseen but only the recent ones pop up', () => {
    expect(unseenNotes(notes, null)).toHaveLength(3);
    expect(popupNotes(notes, null, now).map(n => n.slug)).toEqual(['2026-10', '2026-09']);
  });
  test('only notes newer than the last seen one pop up', () => {
    expect(popupNotes(notes, '2026-09-30', now).map(n => n.slug)).toEqual(['2026-10']);
    expect(popupNotes(notes, '2026-10-01', now)).toEqual([]);
  });
  test('newest date', () => {
    expect(newestDate(notes)).toBe('2026-10-01');
    expect(newestDate([])).toBe(null);
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
  // The web app bundles website/release-notes/*.md as release-notes.json
  const notes_dir = path.join(__dirname, '../../../../website/release-notes');
  const sources = fs.existsSync(notes_dir)
    ? fs.readdirSync(notes_dir).filter(f => f.endsWith('.md') && !f.startsWith('_'))
    : [];

  (sources.length > 0 ? test : test.skip)('is up to date with website/release-notes/', () => {
    const published = sources.map(f => {
      const text = fs.readFileSync(path.join(notes_dir, f));
      const frontmatter = text.toString('utf-8').split(/^---$/m)[1] || '';
      return {
        slug: (frontmatter.match(/^slug:\s*(\S+)/m) || [])[1] || f.replace(/\.md$/, ''),
        draft: /^draft:\s*true/m.test(frontmatter),
        sha256: crypto.createHash('sha256').update(text).digest('hex'),
      };
    }).filter(n => !n.draft);
    const message = 'Run: website/release-notes/release_notes.py build';
    const bundled = Object.fromEntries(bundle.notes.map(n => [n.slug, n.sha256]));
    for (const n of published)
      expect([n.slug, bundled[n.slug] === n.sha256 ? 'up to date' : message]).toEqual([n.slug, 'up to date']);
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

  test('has no raw HTML (release_notes.py escapes it)', () => {
    for (const n of bundle.notes)
      expect([n.slug, /<(script|iframe|style|img)\b|\son\w+=|javascript:/i.test(n.html)]).toEqual([n.slug, false]);
  });

  test('is sorted newest first', () => {
    const dates = bundle.notes.map(n => n.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });
});


describe('the What\'s new popup', () => {
  const store = createStore(() => ({ siteConfig: { docs_root: '/' } }));
  const recent = note('2099-01', '2099-01-31', {
    title: 'January 2099',
    highlights: [{ title: 'Flying cars', description: 'They fly.', audience: 'users', icon: 'airplane', link: '/docs/faq' }],
    html: '<h2>Web app</h2><ul><li>Added flying cars</li></ul>',
  });
  const renderApp = () => render(
    <Provider store={store}>
      <ReleaseNotesProvider load={() => Promise.resolve([recent])} popupDelay={0}>
        <WhatsNewButton />
      </ReleaseNotesProvider>
    </Provider>
  );
  beforeEach(() => window.localStorage.clear());

  test('opens once for new notes, then the button reopens them', async () => {
    renderApp();
    expect(await screen.findByText('Flying cars')).toBeInTheDocument();
    expect(screen.getByTestId('whats-new-unread')).toBeInTheDocument();
    expect(screen.getByText('Learn more').closest('a')).toHaveAttribute('href', '/docs/faq');

    fireEvent.click(screen.getByText('Got it'));
    expect(window.localStorage.getItem(LAST_SEEN_KEY)).toBe('2099-01-31');
    await waitFor(() => expect(screen.queryByTestId('whats-new-unread')).not.toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("What's new"));
    expect(await screen.findByPlaceholderText(/search the release notes/i)).toBeInTheDocument();
    expect(screen.getByText('Added flying cars')).toBeInTheDocument();
  });

  test('does not open for notes already seen', async () => {
    window.localStorage.setItem(LAST_SEEN_KEY, '2099-01-31');
    renderApp();
    // let the notes load
    await waitFor(() => expect(screen.getByLabelText("What's new")).toBeInTheDocument());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.queryByText('Flying cars')).not.toBeInTheDocument();
    expect(screen.queryByTestId('whats-new-unread')).not.toBeInTheDocument();
  });
});
