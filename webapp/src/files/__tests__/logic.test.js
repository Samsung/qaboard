/**
 * Tests for the file browser's logic.
 * Run with: cd webapp && npm test -- files
 */
import {
  pathFromUrl, urlFromPath, parentPath, baseName, breadcrumbs, parseLocation, windowsPath, linuxPath,
  sortEntries, filterEntries, makeMatcher, summarize, formatSummary, formatRelativeTime, iconName,
} from '../logic';
import { setPathMappings, linux_to_windows, windows_to_linux, folder_url } from '../../utils/paths';

afterEach(() => setPathMappings([]))


describe('paths and URLs', () => {
  it('round-trips awkward names', () => {
    const path = '/algo/a b/#1 100%?/é.txt'
    expect(urlFromPath(path)).toBe('/s/algo/a%20b/%231%20100%25%3F/%C3%A9.txt')
    expect(pathFromUrl(urlFromPath(path))).toBe(path)
  })
  it('keeps the trailing slash of folders', () => {
    expect(urlFromPath('/algo/x/')).toBe('/s/algo/x/')
    expect(pathFromUrl('/s/algo/x/')).toBe('/algo/x/')
    expect(pathFromUrl('/s/')).toBe('/')
  })
  it('tolerates malformed URLs', () => {
    expect(pathFromUrl('/s/algo/100%/')).toBe('/algo/100%/')
  })
  it('knows parents and names', () => {
    expect(parentPath('/algo/x/')).toBe('/algo/')
    expect(parentPath('/algo/x/log.txt')).toBe('/algo/x/')
    expect(parentPath('/algo/')).toBe('/')
    expect(parentPath('/')).toBeNull()
    expect(baseName('/algo/x/')).toBe('x')
    expect(baseName('/algo/x/log.txt')).toBe('log.txt')
  })
  it('makes breadcrumbs', () => {
    expect(breadcrumbs('/algo/x/')).toEqual([
      { name: '/', path: '/' },
      { name: 'algo', path: '/algo/' },
      { name: 'x', path: '/algo/x/' },
    ])
    expect(breadcrumbs('/')).toEqual([{ name: '/', path: '/' }])
  })
  it('links to folders with a trailing slash, to get the file browser', () => {
    expect(folder_url('/s/algo/run')).toBe('/s/algo/run/')
    expect(folder_url('/s/algo/run/')).toBe('/s/algo/run/')
    expect(folder_url(undefined)).toBeUndefined()
  })
  it('copies paths without the trailing slash', () => {
    expect(linuxPath('/algo/x/')).toBe('/algo/x')
    expect(linuxPath('/')).toBe('/')
  })
})


describe('Windows paths', () => {
  beforeEach(() => setPathMappings([['\\\\netapp\\algo', '/algo'], ['Z:\\', '/stage/']]))

  it('converts paths', () => {
    expect(windowsPath('/algo/a b/x/')).toBe('\\\\netapp\\algo\\a b\\x')
    expect(windowsPath('/stage/x')).toBe('Z:\\x')
  })
  it('keeps converting URLs like before', () => {
    expect(linux_to_windows('/s/algo/a%20b')).toBe('\\\\netapp\\algo\\a b')
    expect(linux_to_windows(null)).toBeNull()
  })
  it('converts Windows paths back', () => {
    expect(windows_to_linux('\\\\netapp\\algo\\a b\\x')).toBe('/algo/a b/x')
    expect(windows_to_linux('\\\\NETAPP\\Algo\\x')).toBe('/algo/x')
    expect(windows_to_linux('z:\\x\\y')).toBe('/stage/x/y')
    expect(windows_to_linux('\\\\netapp\\algorithms\\x')).toBeNull()
    expect(windows_to_linux('\\\\other\\x')).toBeNull()
  })
})


describe('parseLocation', () => {
  beforeEach(() => setPathMappings([['\\\\netapp\\algo', '/algo']]))

  it('understands what users paste', () => {
    expect(parseLocation('/algo/x')).toBe('/algo/x')
    expect(parseLocation('  "/algo/x/"  ')).toBe('/algo/x/')
    expect(parseLocation('\\\\netapp\\algo\\x')).toBe('/algo/x')
    expect(parseLocation('https://qa/s/algo/a%20b/')).toBe('/algo/a b/')
    expect(parseLocation('/s/algo/x/')).toBe('/algo/x/')
  })
  it('refuses what it does not understand', () => {
    expect(parseLocation('')).toBeNull()
    expect(parseLocation('relative/path')).toBeNull()
    expect(parseLocation('~/x')).toBeNull()
    expect(parseLocation('\\\\unknown\\share')).toBeNull()
  })
})


const entries = [
  { name: 'frame10.png', type: 'file', size: 10, mtime: 300, owner: 'bob' },
  { name: 'frame2.png', type: 'file', size: 2000, mtime: 100, owner: 'alice' },
  { name: 'Logs', type: 'directory', mtime: 50, owner: 'alice' },
  { name: '.qaboard', type: 'directory', mtime: 10, owner: 'alice' },
  { name: 'a.txt', type: 'file', size: 5, mtime: 200, owner: 'carol' },
]
const names = list => list.map(e => e.name)

describe('sortEntries', () => {
  it('puts folders first, in natural order', () => {
    expect(names(sortEntries(entries))).toEqual(['.qaboard', 'Logs', 'a.txt', 'frame2.png', 'frame10.png'])
  })
  it('sorts by size, date or owner', () => {
    expect(names(sortEntries(entries, { key: 'size', desc: true }))).toEqual(['Logs', '.qaboard', 'frame2.png', 'frame10.png', 'a.txt'])
    expect(names(sortEntries(entries, { key: 'mtime' })).slice(2)).toEqual(['frame2.png', 'a.txt', 'frame10.png'])
    expect(names(sortEntries(entries, { key: 'owner' })).slice(2)).toEqual(['frame2.png', 'frame10.png', 'a.txt'])
  })
  it("doesn't change its input", () => {
    const copy = [...entries]
    sortEntries(entries, { key: 'size' })
    expect(entries).toEqual(copy)
  })
})

describe('filterEntries', () => {
  it('hides hidden files unless asked', () => {
    expect(names(filterEntries(entries))).not.toContain('.qaboard')
    expect(names(filterEntries(entries, { showHidden: true }))).toContain('.qaboard')
  })
  it('filters by name, case-insensitive', () => {
    expect(names(filterEntries(entries, { query: 'LOG' }))).toEqual(['Logs'])
  })
  it('shows the hidden files that match', () => {
    expect(names(filterEntries(entries, { query: 'qab' }))).toEqual(['.qaboard'])
  })
  it('supports globs', () => {
    expect(names(filterEntries(entries, { query: '*.png' }))).toEqual(['frame10.png', 'frame2.png'])
    expect(names(filterEntries(entries, { query: 'frame?.png' }))).toEqual(['frame2.png'])
    expect(makeMatcher('a+b(*)')('a+b(1)')).toBe(true)
  })
})

describe('summaries', () => {
  it('counts folders, files and their size', () => {
    expect(summarize(entries)).toEqual({ folders: 2, files: 3, size: 2015 })
    expect(formatSummary(summarize(entries))).toBe('2 folders · 3 files (2.0 kB)')
    expect(formatSummary({ folders: 1, files: 0, size: 0 })).toBe('1 folder')
    expect(formatSummary({ folders: 0, files: 0, size: 0 })).toBe('')
  })
})

describe('formatRelativeTime', () => {
  const now = new Date(2026, 9, 6, 12, 0).getTime() / 1000
  it('is compact', () => {
    expect(formatRelativeTime(now - 10, now)).toBe('just now')
    expect(formatRelativeTime(now - 5 * 60, now)).toBe('5 min ago')
    expect(formatRelativeTime(now - 3 * 3600, now)).toBe('3 h ago')
    expect(formatRelativeTime(now - 30 * 3600, now)).toBe('yesterday')
    expect(formatRelativeTime(now - 3 * 86400, now)).toBe('3 days ago')
    expect(formatRelativeTime(undefined, now)).toBe('')
  })
  it('shows dates for older files', () => {
    expect(formatRelativeTime(new Date(2026, 2, 4).getTime() / 1000, now)).toMatch(/Mar/)
    expect(formatRelativeTime(new Date(2024, 2, 4).getTime() / 1000, now)).toMatch(/2024/)
  })
})

describe('iconName', () => {
  it('picks icons like the bit-accuracy viewer', () => {
    expect(iconName({ name: 'x', type: 'directory' })).toBe('folder-close')
    expect(iconName({ name: 'x', type: 'directory', link: '/y' })).toBe('folder-shared')
    expect(iconName({ name: 'a.PNG', type: 'file' })).toBe('media')
    expect(iconName({ name: 'a.plotly.json', type: 'file' })).toBe('timeline-line-chart')
    expect(iconName({ name: 'metrics.json', type: 'file' })).toBe('numerical')
    expect(iconName({ name: 'log.txt', type: 'file' })).toBe('align-left')
    expect(iconName({ name: 'run', type: 'file' })).toBe('document')
    expect(iconName({ name: 'x', type: 'file', link: '/y', broken: true })).toBe('error')
  })
})
