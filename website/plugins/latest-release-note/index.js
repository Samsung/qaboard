// The latest published release note (release-notes/*.md, see CLAUDE.md), for the landing page: its title, date,
// description and highlights, as global data (useGlobalData()['qaboard-latest-release-note'].default).
// Drafts are skipped; the newest `date` wins.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const PERIOD_RE = /^(\d{4})(?:-(\d{2})|-q([1-4]))?$/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];

// "2026-10" → "October 2026", "2026-q2" → "Q2 2026", "2019" → "2019", like the release notes' default titles
function periodTitle(name) {
  const match = name.match(PERIOD_RE);
  if (!match)
    return name;
  const [, year, month, quarter] = match;
  return month ? `${MONTHS[Number(month) - 1]} ${year}` : quarter ? `Q${quarter} ${year}` : year;
}

function frontMatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? yaml.load(match[1]) ?? {} : {};
}

function latestReleaseNote(dir) {
  const notes = fs.readdirSync(dir)
    .filter(file => file.endsWith('.md') && !file.startsWith('_'))
    .map(file => {
      const name = path.basename(file, '.md');
      const fm = frontMatter(fs.readFileSync(path.join(dir, file), 'utf8'));
      const date = fm.date instanceof Date ? fm.date.toISOString().slice(0, 10) : String(fm.date ?? '');
      return {name, fm, date};
    })
    .filter(({fm, date}) => !fm.draft && date)
    .sort((a, b) => b.date.localeCompare(a.date) || b.name.localeCompare(a.name));
  if (!notes.length)
    return null;
  const {name, fm, date} = notes[0];
  return {
    title: fm.title ?? periodTitle(name),
    date,
    permalink: `/release-notes/${String(fm.slug ?? name).replace(/^\//, '')}`,
    frontMatter: {description: fm.description, version: fm.version, highlights: fm.highlights ?? []},
  };
}

module.exports = function latestReleaseNotePlugin(context) {
  const dir = path.join(context.siteDir, 'release-notes');
  return {
    name: 'qaboard-latest-release-note',
    getPathsToWatch() {
      return [path.join(dir, '*.md')];
    },
    async loadContent() {
      return latestReleaseNote(dir);
    },
    async contentLoaded({content, actions}) {
      actions.setGlobalData(content);
    },
  };
};

module.exports.latestReleaseNote = latestReleaseNote;
