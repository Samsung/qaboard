// The command palette's matching and ranking (CommandPalette.jsx): pure functions, so they're easy to test.
// Items are {key, section, title, positions (matched characters in the title), score, ...what rows show}.
import { batch_name, batch_url } from "../BatchList";
import { path_segment, project_url } from "../selection";

const day_ms = 24 * 3600 * 1000;
const time = date => {
  const t = date ? Date.parse(date) : NaN;
  return Number.isNaN(t) ? null : t;
};

// Where words start: after a separator, or the start of the text
const separators = /[\s/_\-.:@|()[\]]/;
const at_boundary = (text, index) => index === 0 || separators.test(text[index - 1]);

// One word of the query in the text, already lowercased => {score, positions} or null.
// Substrings score best, at the start of a word better. Otherwise the letters in order ("k3den" finds
// kitefin/k3/denoise), as few runs of them as we can, starting words: scattered letters match too much
// among hundreds of projects.
const match_word = (word, text) => {
  let best = null;
  for (let index = text.indexOf(word); index >= 0; index = text.indexOf(word, index + 1)) {
    const boundary = at_boundary(text, index);
    const score = 10 * word.length + (boundary ? 15 : 0) + (index === 0 ? 10 : 0) + (word.length === text.length ? 25 : 0);
    if (!best || score > best.score) best = { score, start: index };
    if (boundary) break;
  }
  if (best) return { score: best.score + 10 * word.length / text.length, positions: Array.from(word, (_, i) => best.start + i) };

  // the letters in order: the first place where they all are, then from its end backwards, the shortest span
  let end = -1;
  for (let i = 0, from = 0; i < word.length; i++) {
    end = text.indexOf(word[i], from);
    if (end < 0) return null;
    from = end + 1;
  }
  const positions = Array.from({ length: word.length });
  for (let i = word.length - 1, at = end; i >= 0; i--) {
    at = text.lastIndexOf(word[i], at);
    positions[i] = at;
    at -= 1;
  }
  // runs of consecutive letters: those that start a word are fine
  let runs = 0;
  let inside_words = 0;
  for (let i = 0; i < positions.length; i++) {
    if (i > 0 && positions[i] === positions[i - 1] + 1) continue;
    runs += 1;
    if (!at_boundary(text, positions[i])) inside_words += 1;
  }
  if (inside_words > Math.floor((word.length - 1) / 3)) return null;
  const spread = positions[positions.length - 1] - positions[0] + 1 - word.length;
  return { score: 6 * word.length - 4 * runs - 6 * inside_words - Math.min(spread, 20) * 0.25 + 5, positions };
};

/**
 * Whether the text matches the query: every word of the query, in any order.
 * => {score, positions} (indexes of the matched characters, sorted), or null. An empty query matches with 0.
 */
export function fuzzy_match(query, text) {
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { score: 0, positions: [] };
  const lower = (text ?? '').toLowerCase();
  let score = 0;
  const positions = new Set();
  for (const word of words) {
    const match = match_word(word, lower);
    if (!match) return null;
    score += match.score;
    for (const p of match.positions) positions.add(p);
  }
  return { score, positions: [...positions].sort((a, b) => a - b) };
}

// The title, or else other words that describe the item (they count less, and highlight nothing)
const match_title_or = (query, title, others) => {
  const in_title = fuzzy_match(query, title);
  if (in_title) return in_title;
  const in_others = others ? fuzzy_match(query, `${title} ${others}`) : null;
  return in_others ? { score: in_others.score * 0.7, positions: in_others.positions.filter(p => p < title.length) } : null;
};

const by_score = (a, b) => (b.score - a.score) || (a.title.length - b.title.length) || a.title.localeCompare(b.title);


// When users last ran something in the project, or looked at it
export const my_time = details => Math.max(time(details?.my_latest_activity) ?? 0, time(details?.my_last_view) ?? 0) || null;
export const recent_days = 90;

/**
 * Projects, from /api/v1/projects ({[id]: details}). Without a query: those users pinned, then those they used lately.
 * With one: the best matches of their path, pinned and recently used ones first among similar matches.
 */
export function rank_projects(projects, query, { favorites = {}, now = Date.now(), limit = query?.trim() ? 8 : 6 } = {}) {
  const items = [];
  const since = now - recent_days * day_ms;
  for (const [id, details] of Object.entries(projects ?? {})) {
    const pinned = !!favorites[id];
    const used = my_time(details);
    const recent = used !== null && used >= since;
    const item = { key: `project:${id}`, section: 'projects', title: id, url: project_url(id), project: id, details, pinned };
    if (!query?.trim()) {
      if (pinned || recent) items.push({ ...item, positions: [], score: (pinned ? 1e15 : 0) + (recent ? used : 0) });
      continue;
    }
    const match = fuzzy_match(query, id);
    if (!match) continue;
    // matches in the last part of the path (the subproject's name) say more
    const last = id.lastIndexOf('/') + 1;
    const in_name = last > 0 && match.positions.length > 0 && match.positions[0] >= last ? 4 : 0;
    const age_days = recent ? (now - used) / day_ms : Infinity;
    const usage = (pinned ? 7 : 0) + (age_days < 1 ? 6 : age_days < 7 ? 4 : age_days < recent_days ? 2 : 0);
    // a project matched as well as a batch is where users more likely want to go
    items.push({ ...item, positions: match.positions, score: match.score + in_name + usage + 2 });
  }
  return items.sort(by_score).slice(0, limit);
}

/**
 * The user's batches, from /api/v1/batches?scope=mine (the latest first): that order without a query,
 * else those whose name or project match (not their branch: many batches share one).
 */
export function rank_batches(batches, query, { limit = query?.trim() ? 6 : 4 } = {}) {
  const items = (batches ?? []).map((batch, index) => {
    const title = batch_name(batch);
    const item = {
      key: `batch:${batch.id}`, section: 'batches', title, batch, project: batch.project,
      url: batch_url(batch.project, batch),
    };
    if (!query?.trim()) return { ...item, positions: [], score: -index };
    const match = match_title_or(query, title, `${batch.project} ${batch.label}`);
    return match ? { ...item, positions: match.positions, score: match.score } : null;
  }).filter(Boolean);
  return (query?.trim() ? items.sort(by_score) : items).slice(0, limit);
}

/**
 * The project's branches, from /api/v1/project/branches?q= (the most recently active first, containing the query).
 * They may answer an older query while users type: we keep only those that still match.
 */
export function rank_branches(project, branches, query, { limit = 6 } = {}) {
  if (!project || !query?.trim()) return [];
  return (branches ?? []).map((branch, index) => {
    const match = fuzzy_match(query, branch);
    if (!match) return null;
    return {
      key: `branch:${branch}`, section: 'branches', title: branch, positions: match.positions,
      url: `/${path_segment(project)}/commits/${path_segment(branch)}`,
      // the server's order (recent activity) breaks ties
      score: match.score - index * 0.01,
    };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, limit);
}

// What users type when they paste or remember the start of a commit's hash
export const looks_like_sha = query => /^[0-9a-f]{4,40}$/i.test((query ?? '').trim());

/**
 * Commits whose hash starts with the query, from /api/v1/commits?q=id:<prefix> (the server says they exist).
 * A long prefix is almost surely a hash: it comes first.
 */
export function rank_commits(project, commits, query, { limit = 5 } = {}) {
  const prefix = (query ?? '').trim().toLowerCase();
  if (!project || !looks_like_sha(prefix)) return [];
  return (commits ?? [])
    .filter(commit => commit.id?.toLowerCase().startsWith(prefix))
    .slice(0, limit)
    .map(commit => ({
      key: `commit:${commit.id}`, section: 'commits', title: commit.id.slice(0, Math.max(8, prefix.length)), commit,
      positions: Array.from(prefix, (_, i) => i),
      url: `/${path_segment(project)}/commit/${path_segment(commit.id)}`,
      score: prefix.length >= 7 ? 1000 : 20 * prefix.length,
    }));
}


export const settings_tabs = [
  { id: 'profile', title: 'Profile', icon: 'person', keywords: 'account name email git' },
  { id: 'preferences', title: 'Preferences', icon: 'settings', keywords: 'options' },
  { id: 'sign-in', title: 'Sign-in methods', icon: 'log-in', keywords: 'password login ldap saml' },
  { id: 'sessions', title: 'Sessions', icon: 'desktop', keywords: 'devices browsers' },
  { id: 'tokens', title: 'Access tokens', icon: 'key', keywords: 'api token' },
  { id: 'cli', title: 'CLI sign-ins', icon: 'console', keywords: 'qa auth login terminal' },
  { id: 'activity', title: 'Activity', icon: 'history', keywords: 'audit log' },
];

/**
 * The app's pages, and what users can do from anywhere. `suggested` ones show without a query.
 * Items with `url` navigate, `href` leave the app, `action` is done by the palette.
 */
export function app_items({ user, docs_root = '/', is_dark = false }) {
  const logged = !!user?.is_logged;
  const pages = [
    { key: 'home', title: 'Home', icon: 'home', url: '/', keywords: 'start', suggested: true },
    { key: 'explore', title: 'Explore projects', icon: 'projects', url: '/projects', keywords: 'all every list tree', suggested: true },
    logged && { key: 'activity', title: 'Runs activity', icon: 'pulse', url: '/activity', keywords: 'running waiting queue jobs pending', suggested: true },
    logged && { key: 'storage', title: 'Storage usage', icon: 'database', url: '/storage', keywords: 'disk space quota delete files', suggested: true },
    logged && { key: 'settings', title: 'Settings', icon: 'cog', url: '/settings', keywords: 'account', suggested: true },
    ...(logged ? settings_tabs.map(tab => ({ key: `settings-${tab.id}`, title: tab.title, subtitle: 'Settings', icon: tab.icon, url: `/settings/${tab.id}`, keywords: `settings ${tab.keywords}` })) : []),
    user?.is_admin && { key: 'admin', title: 'Admin', icon: 'shield', url: '/admin', keywords: 'administration users groups server' },
    { key: 'docs', title: 'User guide', icon: 'manual', href: `${docs_root}docs/user-guide/overview`, keywords: 'docs documentation help' },
  ].filter(Boolean).map(page => ({ ...page, key: `page:${page.key}`, section: 'pages' }));
  const actions = [
    { key: 'whats-new', title: "What's new", icon: 'clean', action: 'whats-new', keywords: 'release notes changelog news', suggested: true },
    { key: 'theme', title: is_dark ? 'Switch to the light theme' : 'Switch to the dark theme', icon: is_dark ? 'flash' : 'moon', action: 'theme', keywords: 'theme dark light mode appearance colors', suggested: true },
    { key: 'cheat-sheet', title: 'Keyboard shortcuts', icon: 'key-command', action: 'cheat-sheet', shortcut: '?', keywords: 'cheat sheet help keys' },
    logged
      ? { key: 'sign-out', title: 'Sign out', icon: 'log-out', action: 'sign-out', keywords: 'logout log out' }
      : { key: 'sign-in', title: 'Sign in', icon: 'log-in', action: 'sign-in', keywords: 'login log in', suggested: true },
  ].map(action => ({ ...action, key: `action:${action.key}`, section: 'actions' }));
  return [...pages, ...actions];
}

// Pages and actions that match the query, or the suggested ones
export function rank_app_items(items, query) {
  if (!query?.trim()) return items.filter(item => item.suggested).map(item => ({ ...item, positions: [], score: 0 }));
  return items.map(item => {
    const match = match_title_or(query, item.title, `${item.subtitle ?? ''} ${item.keywords ?? ''}`);
    return match ? { ...item, positions: match.positions, score: match.score } : null;
  }).filter(Boolean).sort(by_score).slice(0, 6);
}


export const section_titles = {
  commits: 'Commits',
  projects: 'Projects',
  branches: 'Branches',
  batches: 'Your recent batches',
  pages: 'Pages',
  actions: 'Actions',
};
const section_order = Object.keys(section_titles);

/**
 * Items grouped by section: without a query in a fixed order, else the section with the best match first,
 * so that the first item, active when the palette opens or users type, is the best match.
 * => [{id, title, items}]
 */
export function group_sections(items, query) {
  const sections = new Map();
  for (const item of items) {
    if (!sections.has(item.section)) sections.set(item.section, { id: item.section, title: section_titles[item.section], items: [] });
    sections.get(item.section).items.push(item);
  }
  const order = id => section_order.indexOf(id);
  const best = section => Math.max(...section.items.map(item => item.score));
  return [...sections.values()].sort(query?.trim()
    ? (a, b) => (best(b) - best(a)) || (order(a.id) - order(b.id))
    : (a, b) => order(a.id) - order(b.id));
}

// The words of the text, the matched characters highlighted: [{text, match}]
export function highlight_parts(text, positions = []) {
  const matched = new Set(positions);
  const parts = [];
  for (let i = 0; i < text.length; i++) {
    const match = matched.has(i);
    const last = parts[parts.length - 1];
    if (last && last.match === match) last.text += text[i];
    else parts.push({ text: text[i], match });
  }
  return parts;
}
