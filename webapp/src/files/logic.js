// The file browser's logic, without React: paths and URLs, sorting, filtering, formatting.
// nginx serves the files under /s/: the URL of /algo/a b/x.txt is /s/algo/a%20b/x.txt
import { humanFileSize } from "../viewers/bit_accuracy/utils";
import { path_to_windows, windows_to_linux } from "../utils/paths";

export const URL_PREFIX = '/s'

// "/s/algo/a%20b/" => "/algo/a b/"
export const pathFromUrl = pathname => {
  const path = pathname.startsWith(`${URL_PREFIX}/`) ? pathname.slice(URL_PREFIX.length) : pathname
  return path.split('/').map(part => {
    try {
      return decodeURIComponent(part)
    } catch {
      return part
    }
  }).join('/')
}

// "/algo/a b/" => "/s/algo/a%20b/"
export const urlFromPath = path => URL_PREFIX + path.split('/').map(encodeURIComponent).join('/')

export const joinPath = (folder, name) => `${folder.replace(/\/+$/, '')}/${name}`

// "/algo/x/" => "/algo/", "/" => null
export const parentPath = path => {
  const trimmed = path.replace(/\/+$/, '')
  if (!trimmed) return null
  return trimmed.slice(0, trimmed.lastIndexOf('/') + 1)
}

export const baseName = path => path.replace(/\/+$/, '').split('/').pop()

// "/algo/x/" => [{name: "/", path: "/"}, {name: "algo", path: "/algo/"}, {name: "x", path: "/algo/x/"}]
export const breadcrumbs = path => {
  const parts = path.split('/').filter(Boolean)
  return [
    { name: '/', path: '/' },
    ...parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join('/')}/` })),
  ]
}

// What users paste to go somewhere: a Linux path, a Windows path, or a QA-Board URL. Returns a path, or null
export const parseLocation = input => {
  let value = input.trim().replace(/^["']|["']$/g, '')
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:')
      return pathFromUrl(url.pathname)
  } catch {
    // not a URL
  }
  if (value.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(value) || value.includes('\\'))
    return windows_to_linux(value)
  if (value.startsWith(`${URL_PREFIX}/`))
    return pathFromUrl(value)
  if (value.startsWith('~'))
    return null
  return value.startsWith('/') ? value : null
}

export const windowsPath = path => path_to_windows(path.replace(/(.)\/+$/, '$1'))
export const linuxPath = path => path.replace(/(.)\/+$/, '$1')


const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

const compareBy = {
  name: (a, b) => collator.compare(a.name, b.name),
  size: (a, b) => (a.size ?? -1) - (b.size ?? -1) || collator.compare(a.name, b.name),
  mtime: (a, b) => (a.mtime ?? 0) - (b.mtime ?? 0) || collator.compare(a.name, b.name),
  owner: (a, b) => collator.compare(a.owner ?? '', b.owner ?? '') || collator.compare(a.name, b.name),
}

// Folders first, then "natural" order: frame2 before frame10
export const sortEntries = (entries, { key = 'name', desc = false } = {}) => {
  const compare = compareBy[key] ?? compareBy.name
  return [...entries].sort((a, b) => {
    const folders = (b.type === 'directory') - (a.type === 'directory')
    if (folders) return folders
    return desc ? compare(b, a) : compare(a, b)
  })
}

export const isHidden = entry => entry.name.startsWith('.')

// Case-insensitive. Supports globs: *.png, frame_??.raw
export const makeMatcher = query => {
  const q = query.trim()
  if (!q) return () => true
  if (/[*?]/.test(q)) {
    const pattern = q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
    const regex = new RegExp(`^${pattern}$`, 'i')
    return name => regex.test(name)
  }
  const lower = q.toLowerCase()
  return name => name.toLowerCase().includes(lower)
}

export const filterEntries = (entries, { query = '', showHidden = false } = {}) => {
  const matches = makeMatcher(query)
  // With a query, we show hidden files that match it
  return entries.filter(entry => (showHidden || query.trim() || !isHidden(entry)) && matches(entry.name))
}

export const summarize = entries => {
  let folders = 0, files = 0, size = 0
  for (const entry of entries) {
    if (entry.type === 'directory') folders += 1
    else {
      files += 1
      size += entry.size ?? 0
    }
  }
  return { folders, files, size }
}

const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`

export const formatSummary = ({ folders, files, size }) => {
  const parts = []
  if (folders) parts.push(plural(folders, 'folder'))
  if (files) parts.push(`${plural(files, 'file')} (${formatSize(size)})`)
  return parts.join(' · ')
}

export const formatSize = bytes => humanFileSize(bytes, true)


const MINUTE = 60, HOUR = 60 * MINUTE, DAY = 24 * HOUR

// Compact, like file managers: "just now", "5 min ago", "3 h ago", "yesterday", "Mar 4", "Mar 4, 2024"
export const formatRelativeTime = (mtime, now = Date.now() / 1000) => {
  if (mtime === undefined || mtime === null) return ''
  const elapsed = now - mtime
  if (elapsed < 0) return formatDate(mtime, now)
  if (elapsed < MINUTE) return 'just now'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`
  if (elapsed < 2 * DAY) return 'yesterday'
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)} days ago`
  return formatDate(mtime, now)
}

const formatDate = (mtime, now) => {
  const date = new Date(mtime * 1000)
  const sameYear = date.getFullYear() === new Date(now * 1000).getFullYear()
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

export const formatAbsoluteTime = mtime => mtime === undefined || mtime === null ? '' : new Date(mtime * 1000).toLocaleString()


// Same idea as the bit-accuracy viewer's icons
const ICONS = [
  [/\.(png|jpe?g|bmp|gif|tiff?|webp|svg|hex|raw|imgprops|exr|dng)$/i, 'media'],
  [/\.(mp4|avi|mkv|mov|webm)$/i, 'video'],
  [/\.plotly\.json$/i, 'timeline-line-chart'],
  [/\.(json|ya?ml|toml|ini|cfg|conf|cde|set)$/i, 'numerical'],
  [/\.(csv|tsv|xlsx?)$/i, 'th'],
  [/\.(log|txt|out|err)$/i, 'align-left'],
  [/\.(md|rst|pdf|docx?|pptx?)$/i, 'document'],
  [/\.(xml|html?|css|jsx?|tsx?|py|c|cc|cpp|h|hpp|m|java|go|rs)$/i, 'code'],
  [/\.(sh|bash|bat|ps1|exe|bin)$/i, 'console'],
  [/\.(zip|tar|gz|tgz|bz2|xz|7z|zst)$/i, 'compressed'],
  [/\.(pcd|ply|obj|stl)$/i, 'cube'],
]

export const iconName = entry => {
  if (entry.broken) return 'error'
  if (entry.type === 'directory') return entry.link !== undefined ? 'folder-shared' : 'folder-close'
  if (entry.type === 'other') return 'help'
  for (const [regex, icon] of ICONS)
    if (regex.test(entry.name)) return icon
  return 'document'
}
