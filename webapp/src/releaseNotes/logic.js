// What's new: which release notes a user hasn't seen, links, search.
// The notes are written in website/release-notes/, vite bundles them (webapp/releaseNotes.js)

export const LAST_SEEN_KEY = 'qaboard.release-notes.last-seen';
// Notes older than that don't pop up, e.g. for new users, or after a long vacation
export const POPUP_MAX_AGE_DAYS = 60;
// The hash that opens the panel: https://qa/#whats-new
export const HASH = '#whats-new';

export const AUDIENCES = {
  'users': { label: 'Users', intent: 'primary' },
  'project-integration': { label: 'Project integration', intent: 'success' },
  'admins': { label: 'Admins', intent: 'warning' },
};


// localStorage can be unavailable (private mode, blocked storage...)
export const getLastSeen = () => {
  try {
    return window.localStorage.getItem(LAST_SEEN_KEY);
  } catch {
    return null;
  }
};

export const setLastSeen = date => {
  try {
    window.localStorage.setItem(LAST_SEEN_KEY, date);
  } catch {}
};


// The last day of a period: 2026-10, 2026-q4 or 2026. Unknown formats use the note's date.
export const periodEnd = note => {
  const m = /^(\d{4})(?:-(\d{2})|-q([1-4]))?$/.exec(note.period || '');
  if (!m) return note.date;
  const year = Number(m[1]);
  const lastMonth = m[2] ? Number(m[2]) : m[3] ? 3 * Number(m[3]) : 12;
  // day 0 of the next month is the last day of this one
  return new Date(Date.UTC(year, lastMonth, 0)).toISOString().slice(0, 10);
};

const today = now => now.toISOString().slice(0, 10);

// The notes of the current period are a preview: they are still updated as work lands, so they
// don't pop up and don't count as unread. They pop up once the period is over, with everything in it.
export const isPreview = (note, now = new Date()) => periodEnd(note) >= today(now);

// What's stored is the period (slug) of the newest finished note the user has seen, so the popup
// only opens when a period ends: editing or re-dating a published note doesn't re-trigger it.
// The notes are sorted newest first, so the unseen ones are those before the last seen period.
// Older versions stored the date of the newest note, possibly published mid-period: the periods
// that ended after it are unseen.
export const unseenNotes = (notes, lastSeen, now = new Date()) => {
  const finished = notes.filter(n => !isPreview(n, now));
  if (!lastSeen) return finished;
  const index = notes.findIndex(n => n.slug === lastSeen);
  if (index >= 0) return finished.filter(n => notes.indexOf(n) < index);
  return finished.filter(n => periodEnd(n) > lastSeen);
};

export const popupNotes = (notes, lastSeen, now = new Date()) => {
  const oldest = new Date(now.getTime() - POPUP_MAX_AGE_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);
  return unseenNotes(notes, lastSeen, now).filter(n => periodEnd(n) >= oldest);
};

// What to remember once the notes were shown: the newest finished period
export const lastSeenSlug = (notes, now = new Date()) => notes.find(n => !isPreview(n, now))?.slug ?? null;



// Links in the notes are /docs/page-id, /release-notes/slug or full URLs
export const resolveLink = (link, docs_root) => {
  if (!link) return link;
  if (link.startsWith('/docs/'))
    return `${docs_root}${link.slice(1)}`;
  if (link.startsWith('/release-notes'))
    return HASH;
  return link;
};


// Search filters the notes down to what matches: the highlights, and the bullets of "All changes" with
// their section headings. A highlight or bullet matches when it has every word of the query, counting
// its note's title and its section headings: "image" keeps the bullets under "### Comparing images".
// A query that matches a note's title, period or version keeps all of that note.
const matchesAll = (words, ...texts) => {
  const text = texts.join(' ').toLowerCase();
  return words.every(w => text.includes(w));
};

const isList = el => el.nodeName === 'UL' || el.nodeName === 'OL';
const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const indexList = el => ({
  tag: el.nodeName.toLowerCase(),
  items: [...el.children].map(li => {
    const own = [...li.childNodes].filter(c => !isList(c));
    return {
      html: li.outerHTML,
      text: own.map(c => c.textContent).join(' '),
      ownHtml: own.map(c => c.outerHTML ?? escape(c.textContent)).join(''),
      sublists: [...li.children].filter(isList).map(indexList),
    };
  }),
});

// The html is flat: ## sections, ### groups, then lists or paragraphs. It is parsed once per note.
const blocksCache = new Map();
const blocksOf = html => {
  if (!blocksCache.has(html)) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    blocksCache.set(html, [...doc.body.children].map(el => {
      if (/^H[1-6]$/.test(el.nodeName)) return { heading: el.nodeName, text: el.textContent, html: el.outerHTML };
      if (isList(el)) return { list: indexList(el) };
      return { text: el.textContent, html: el.outerHTML };
    }));
  }
  return blocksCache.get(html);
};

// The list items that match. An item with sub-items is kept whole when its own text matches,
// else with only the sub-items that match.
const filterList = (list, words, context) => {
  const items = list.items.flatMap(item => {
    if (matchesAll(words, context, item.text)) return [item.html];
    const sublists = item.sublists.map(sub => filterList(sub, words, `${context} ${item.text}`)).filter(Boolean);
    return sublists.length ? [`<li>${item.ownHtml}${sublists.join('')}</li>`] : [];
  });
  return items.length ? `<${list.tag}>\n${items.join('\n')}\n</${list.tag}>` : null;
};

const filterHtml = (html, words, context) => {
  if (!html) return html;
  const headings = [];  // the current h2, h3...
  const shown = new Set();  // the headings already kept
  const kept = [];
  for (const block of blocksOf(html)) {
    if (block.heading) {
      // a heading ends the sections of its level and below
      while (headings.length && headings.at(-1).heading >= block.heading) headings.pop();
      headings.push(block);
      continue;
    }
    const ctx = [context, ...headings.map(h => h.text)].join(' ');
    const out = block.list ? filterList(block.list, words, ctx) : matchesAll(words, ctx, block.text) ? block.html : null;
    if (!out) continue;
    // the headings above what's kept, once each
    headings.filter(h => !shown.has(h)).forEach(h => { shown.add(h); kept.push(h.html) });
    kept.push(out);
  }
  return kept.join('\n');
};

export const searchNotes = (notes, query) => {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return notes;
  return notes.flatMap(n => {
    const context = [n.title, n.period, n.version].join(' ');
    if (matchesAll(words, context)) return [n];
    const highlights = n.highlights.filter(h => matchesAll(words, context, h.title, h.description, AUDIENCES[h.audience]?.label));
    const html = filterHtml(n.html, words, context);
    if (highlights.length === 0 && !html && !matchesAll(words, context, n.description)) return [];
    return [{ ...n, highlights, html }];
  });
};


// The html is safe: release_notes.py renders the markdown without raw HTML.
// Links to the docs use docs_root and open in a new tab, links to release notes open the panel.
export const renderHtml = (html, docs_root) => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('a[href]').forEach(a => {
    const href = resolveLink(a.getAttribute('href'), docs_root);
    a.setAttribute('href', href);
    if (href !== HASH) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return doc.body.innerHTML;
};
