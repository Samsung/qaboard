// Bundles the release notes (website/release-notes/*.md) in the web app, for the "What's new" panel.
// The app imports them from "virtual:release-notes": they are read when vite builds the app, serves it or runs the tests,
// so there is no generated file to keep up to date. website/release-notes/release_notes.py validates the notes.
import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import MarkdownIt from 'markdown-it'

// In docker, webapp/Dockerfile copies the notes next to the app
export const NOTES_DIR = process.env.QABOARD_RELEASE_NOTES_DIR
  || path.resolve(import.meta.dirname, '../website/release-notes')

// No raw HTML: it is escaped, and markdown-it rejects javascript: links. The web app can show the output as is.
const markdown = new MarkdownIt('commonmark', { html: false }).enable(['table', 'strikethrough'])

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// 2026-10 => October 2026, 2026-q4 => Q4 2026, 2026 => 2026
const periodTitle = period => {
  const m = /^(\d{4})(?:-(0[1-9]|1[0-2])|-q([1-4]))?$/.exec(period)
  if (!m) throw new Error(`Invalid period '${period}': use YYYY-MM, YYYY-qN or YYYY`)
  return m[2] ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : m[3] ? `Q${m[3]} ${m[1]}` : m[1]
}

const str = value => String(value).trim()

export const readNote = file => {
  const text = fs.readFileSync(file, 'utf-8')
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!m) throw new Error(`${path.basename(file)}: missing the --- frontmatter ---`)
  const meta = parse(m[1]) ?? {}
  const stem = path.basename(file, '.md')
  const period = String(meta.period || stem).toLowerCase()
  return {
    draft: !!meta.draft,
    note: {
      slug: meta.slug || stem,
      title: meta.title || periodTitle(period),
      period,
      date: String(meta.date ?? '').slice(0, 10),
      version: meta.version ? String(meta.version) : null,
      description: str(meta.description ?? ''),
      highlights: (meta.highlights || []).map(h => Object.fromEntries(
        ['title', 'description', 'audience', 'icon', 'link'].filter(k => h[k]).map(k => [k, str(h[k])])
      )),
      html: markdown.render(m[2].replace(/<!--[\s\S]*?-->/g, '')).trim(),
    },
  }
}

export const buildNotes = ({ dir = NOTES_DIR, includeDrafts = false } = {}) => {
  if (!fs.existsSync(dir))
    throw new Error(`The release notes are missing: ${dir}. Set QABOARD_RELEASE_NOTES_DIR, or see webapp/Dockerfile.`)
  // Like docusaurus, files starting with _ are not release notes
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('_')).sort()
  const notes = files.map(f => readNote(path.join(dir, f)))
    .filter(n => includeDrafts || !n.draft)
    .map(n => n.note)
  // newest first
  notes.sort((a, b) => a.date !== b.date ? (a.date < b.date ? 1 : -1) : (a.slug < b.slug ? 1 : -1))
  return { notes }
}


const ID = 'virtual:release-notes'
const RESOLVED_ID = '\0' + ID

// Set QABOARD_RELEASE_NOTES_DRAFTS=1 to preview the drafts with `npm start`
export const releaseNotes = ({ includeDrafts = !!process.env.QABOARD_RELEASE_NOTES_DRAFTS } = {}) => ({
  name: 'qaboard-release-notes',
  resolveId: id => id === ID ? RESOLVED_ID : undefined,
  load(id) {
    if (id !== RESOLVED_ID) return
    // rebuilds when a note changes
    fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.md')).forEach(f => this.addWatchFile(path.join(NOTES_DIR, f)))
    return `export default ${JSON.stringify(buildNotes({ includeDrafts }))}`
  },
  configureServer(server) {
    // new notes, and changes to the notes, reload the app
    server.watcher.add(NOTES_DIR)
    const reload = file => {
      if (!file.startsWith(NOTES_DIR) || !file.endsWith('.md')) return
      const module = server.moduleGraph.getModuleById(RESOLVED_ID)
      if (module) server.moduleGraph.invalidateModule(module)
      server.ws.send({ type: 'full-reload' })
    }
    server.watcher.on('add', reload)
    server.watcher.on('change', reload)
    server.watcher.on('unlink', reload)
  },
})
