// What's new: which release notes a user hasn't seen, links, search.
// The notes are written in website/release-notes/ and bundled in release-notes.json
// by website/release-notes/release_notes.py build

export const LAST_SEEN_KEY = 'qaboard.release-notes.last-seen';
// Notes older than that don't pop up, e.g. for new users, or after a long vacation
export const POPUP_MAX_AGE_DAYS = 60;
// The hash that opens the panel: https://qa/#whats-new
export const HASH = '#whats-new';

export const AUDIENCES = {
  'users': { label: 'Users', intent: 'primary' },
  'project-leads': { label: 'Project leads', intent: 'success' },
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


// The notes are sorted newest first; dates are YYYY-MM-DD, so they compare as strings
export const unseenNotes = (notes, lastSeen) => notes.filter(n => !lastSeen || n.date > lastSeen);

export const popupNotes = (notes, lastSeen, now = new Date()) => {
  const oldest = new Date(now.getTime() - POPUP_MAX_AGE_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);
  return unseenNotes(notes, lastSeen).filter(n => n.date >= oldest);
};

export const newestDate = notes => notes.reduce((newest, n) => (!newest || n.date > newest ? n.date : newest), null);


// Links in the notes are /docs/page-id, /release-notes/slug or full URLs
export const resolveLink = (link, docs_root) => {
  if (!link) return link;
  if (link.startsWith('/docs/'))
    return `${docs_root}${link.slice(1)}`;
  if (link.startsWith('/release-notes'))
    return HASH;
  return link;
};


const textOf = html => html.replace(/<[^>]+>/g, ' ');

export const searchNotes = (notes, query) => {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return notes;
  return notes.filter(n => {
    const text = [
      n.title, n.period, n.version, n.description, textOf(n.html),
      ...n.highlights.flatMap(h => [h.title, h.description, AUDIENCES[h.audience]?.label]),
    ].join(' ').toLowerCase();
    return words.every(w => text.includes(w));
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
