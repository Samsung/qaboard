/**
 * Tests for the file browser.
 * Run with: cd webapp && npm test -- files
 */
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { HotkeysProvider } from '@blueprintjs/core';
import copy from 'copy-to-clipboard';

import FileBrowser from '../FileBrowser';
import { setPathMappings } from '../../utils/paths';

vi.mock('copy-to-clipboard', () => ({ default: vi.fn() }))
vi.mock('../../toaster', () => ({ toaster: { show: vi.fn() } }))

const now = Date.now() / 1000
const LISTINGS = {
  '/algo/project/': [
    { name: 'outputs', type: 'directory', mtime: now - 3600, owner: 'alice', mode: 'drwxr-xr-x' },
    { name: 'frame10.png', type: 'file', size: 2048, mtime: now - 120, owner: 'bob', mode: '-rw-r--r--' },
    { name: 'frame2.png', type: 'file', size: 1000, mtime: now - 60, owner: 'bob', mode: '-rw-r--r--' },
    { name: '.qaboard', type: 'directory', mtime: now, owner: 'alice', mode: 'drwxr-xr-x' },
    { name: 'latest', type: 'directory', mtime: now, owner: 'alice', mode: 'drwxr-xr-x', link: 'outputs' },
  ],
  '/algo/project/outputs/': [
    { name: 'log.txt', type: 'file', size: 10, mtime: now, owner: 'alice', mode: '-rw-r--r--' },
  ],
  '/algo/': [
    { name: 'project', type: 'directory', mtime: now, owner: 'alice', mode: 'drwxr-xr-x' },
    { name: 'other', type: 'directory', mtime: now, owner: 'alice', mode: 'drwxr-xr-x' },
  ],
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

let server
const makeServer = () => {
  const state = { user: { is_authenticated: false }, restricted: new Set(), run: null, actions: [], config: { login_type: 'LOCAL', path_mappings: [], docs_root: '/' } }
  state.fetch = vi.fn(async (url, options = {}) => {
    if (url === '/api/v1/config') return json(state.config)
    if (url === '/api/v1/user/me/') return json(state.user)
    if (url === '/api/v1/user/auth/') {
      state.user = { is_authenticated: true, user_name: 'alice', full_name: 'Alice' }
      return json({ login_success: true })
    }
    if (url.startsWith('/api/v1/files/authorize')) {
      const path = decodeURIComponent(url.split('path=')[1])
      if (state.restricted.has(path) && !state.user.is_authenticated) return json({ error: 'Only some users can see the project secret. Sign in to see these files.', reason: 'login' }, 401)
      return new Response(null, { status: 204 })
    }
    if (url.startsWith('/api/v1/files/run')) {
      const path = decodeURIComponent(url.split('path=')[1])
      const run = state.run && (path === state.run.folder || path.startsWith(`${state.run.folder}/`)) ? state.run : null
      return json({ run })
    }
    if (url.startsWith('/api/v1/output/')) {
      state.actions.push(`${options.method} ${url}`)
      if (!state.user.is_authenticated) return json({ error: 'You need to be logged-in to do this.' }, 401)
      if (url.startsWith('/api/v1/output/redo/')) state.run = { ...state.run, is_failed: false, is_pending: true }
      return json({ status: 'OK' })
    }
    if (url.startsWith('/s/') && options.headers?.Accept === 'application/json') {
      const path = decodeURIComponent(url.slice(2))
      if (state.restricted.has(path) && !state.user.is_authenticated) {
        // like nginx with auth_request: its error page, not the backend's JSON
        return new Response('<html></html>', { status: 401, headers: { 'Content-Type': 'text/html' } })
      }
      if (!LISTINGS[path]) return json({ error: `${path} is not a folder`, reason: 'not-found' }, 404)
      return json({ path, entries: LISTINGS[path], truncated: false })
    }
    return new Response('Not Found', { status: 404 })
  })
  return state
}

const renderAt = url => {
  window.history.replaceState({}, '', url)
  return render(<HotkeysProvider><FileBrowser/></HotkeysProvider>)
}

const rowNames = () => screen.getAllByRole('row').slice(1).map(row => row.querySelector('.fb-name')?.textContent).filter(Boolean)

beforeEach(() => {
  server = makeServer()
  vi.stubGlobal('fetch', server.fetch)
  window.scrollTo = vi.fn()
  setPathMappings([])
})

afterEach(() => {
  vi.unstubAllGlobals()
  copy.mockClear()
  try { localStorage.clear() } catch { /* jsdom */ }
})


describe('FileBrowser', () => {
  it('lists folders first, in natural order, without hidden files', async () => {
    renderAt('/s/algo/project/')
    await screen.findByText('frame2.png')
    expect(rowNames()).toEqual(['latest/→ outputs', 'outputs/', 'frame2.png', 'frame10.png'])
    expect(screen.getByText('1 hidden')).toBeInTheDocument()
    expect(screen.getByText(/2 folders · 2 files/)).toBeInTheDocument()
    expect(document.title).toBe('project · QA-Board')
    // links work without JavaScript, in new tabs...
    expect(screen.getByRole('link', { name: 'frame2.png' })).toHaveAttribute('href', '/s/algo/project/frame2.png')
    expect(screen.getByRole('link', { name: 'outputs/' })).toHaveAttribute('href', '/s/algo/project/outputs/')
  })

  it('shows hidden files', async () => {
    renderAt('/s/algo/project/')
    fireEvent.click(await screen.findByRole('button', { name: 'Show hidden files' }))
    expect(rowNames()).toContain('.qaboard/')
  })

  it('filters', async () => {
    renderAt('/s/algo/project/')
    await screen.findByText('frame2.png')
    fireEvent.change(screen.getByLabelText('Filter'), { target: { value: '*.png' } })
    expect(rowNames()).toEqual(['frame2.png', 'frame10.png'])
    expect(screen.getByText('2 of 5')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Filter'), { target: { value: 'nothing' } })
    expect(screen.getByText('Nothing matches')).toBeInTheDocument()
  })

  it('sorts', async () => {
    renderAt('/s/algo/project/')
    await screen.findByText('frame2.png')
    fireEvent.click(screen.getByRole('button', { name: 'Size' }))
    expect(rowNames().slice(2)).toEqual(['frame10.png', 'frame2.png'])
    expect(screen.getByRole('columnheader', { name: /Size/ })).toHaveAttribute('aria-sort', 'descending')
  })

  it('navigates without reloading the page, and back', async () => {
    renderAt('/s/algo/project/')
    fireEvent.click(await screen.findByRole('link', { name: 'outputs/' }))
    await screen.findByText('log.txt')
    expect(window.location.pathname).toBe('/s/algo/project/outputs/')
    expect(screen.getByRole('navigation', { name: 'Path' })).toHaveTextContent('algoprojectoutputs')

    // breadcrumbs
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Path' })).getByRole('link', { name: 'algo' }))
    await screen.findByText('other/')
    // we select the folder we come from
    expect(screen.getByRole('row', { name: /project/ })).toHaveAttribute('aria-selected', 'true')

    window.history.back()
    await waitFor(() => expect(window.location.pathname).toBe('/s/algo/project/outputs/'))
    await screen.findByText('log.txt')
  })

  it('has keyboard shortcuts', async () => {
    renderAt('/s/algo/project/')
    await screen.findByText('frame2.png')
    fireEvent.keyDown(document.body, { key: 'j' })
    fireEvent.keyDown(document.body, { key: 'j' })
    expect(screen.getByRole('row', { name: /^outputs/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(document.body, { key: 'c' })
    expect(copy).toHaveBeenCalledWith('/algo/project/outputs')
    fireEvent.keyDown(document.body, { key: 'Enter' })
    await screen.findByText('log.txt')
    fireEvent.keyDown(document.body, { key: 'Backspace' })
    await screen.findByText('frame2.png')
    expect(window.location.pathname).toBe('/s/algo/project/')
    expect(screen.getByRole('row', { name: /^outputs/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(document.body, { key: '/' })
    expect(screen.getByLabelText('Filter')).toHaveFocus()
  })

  it('copies Linux and Windows paths', async () => {
    server.config.path_mappings = [['\\\\netapp\\algo', '/algo']]
    renderAt('/s/algo/project/')
    await screen.findByText('frame2.png')
    await screen.findAllByRole('button', { name: /Copy the Windows path of/ })
    fireEvent.click(screen.getByRole('button', { name: 'Copy the path of frame2.png' }))
    expect(copy).toHaveBeenLastCalledWith('/algo/project/frame2.png')
    fireEvent.click(screen.getByRole('button', { name: 'Copy the Windows path of frame2.png' }))
    expect(copy).toHaveBeenLastCalledWith('\\\\netapp\\algo\\project\\frame2.png')
    fireEvent.click(screen.getByRole('button', { name: 'Windows' }))
    expect(copy).toHaveBeenLastCalledWith('\\\\netapp\\algo\\project')
  })

  it('only offers Windows paths when the server knows them', async () => {
    renderAt('/s/algo/project/')
    await screen.findByText('frame2.png')
    expect(screen.queryByRole('button', { name: /Copy the Windows path/ })).not.toBeInTheDocument()
  })

  it('goes to pasted paths', async () => {
    server.config.path_mappings = [['\\\\netapp\\algo', '/algo']]
    renderAt('/s/algo/project/outputs/')
    await screen.findByText('log.txt')
    fireEvent.click(screen.getByRole('button', { name: 'Type or paste a path' }))
    const input = screen.getByLabelText('Go to a path')
    expect(input).toHaveValue('/algo/project/outputs')
    fireEvent.change(input, { target: { value: '\\\\netapp\\algo\\project' } })
    fireEvent.submit(input.closest('form'))
    await screen.findByText('frame2.png')
    expect(window.location.pathname).toBe('/s/algo/project/')
  })

  it('explains missing folders', async () => {
    renderAt('/s/algo/missing/')
    expect(await screen.findByText('Not found')).toBeInTheDocument()
    // the toolbar has the same button
    fireEvent.click(screen.getAllByRole('button', { name: 'Parent folder' }).at(-1))
    await screen.findByText('other/')
  })

  it('asks users to sign in for restricted folders', async () => {
    server.restricted.add('/algo/project/')
    renderAt('/s/algo/project/')
    expect(await screen.findByText('Sign in to see these files')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign in' }).at(-1))
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'alice' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign in' }).at(-1))
    await screen.findByText('frame2.png')
    expect(await screen.findByText('Alice')).toBeInTheDocument()
  })

  it('explains why nginx refused to send a file', async () => {
    server.restricted.add('/algo/project/secret.txt')
    renderAt('/s/algo/project/secret.txt')
    expect(await screen.findByText('Sign in to see these files')).toBeInTheDocument()
  })

  it('renders only the visible rows of huge folders', async () => {
    LISTINGS['/algo/huge/'] = Array.from({ length: 5000 }, (_, i) => ({ name: `frame${i}.png`, type: 'file', size: i, mtime: now }))
    renderAt('/s/algo/huge/')
    await screen.findByText('frame0.png')
    const rows = screen.getAllByRole('row').length
    expect(rows).toBeLessThan(200)
    expect(screen.getByText(/5,000 files/)).toBeInTheDocument()
    // the filter still sees everything
    fireEvent.change(screen.getByLabelText('Filter'), { target: { value: 'frame4999.png' } })
    expect(rowNames()).toEqual(['frame4999.png'])
    await act(async () => {})
  })
})


describe('runs', () => {
  const RUN = {
    id: 42, folder: '/algo/project/outputs', is_failed: true, is_pending: false, is_running: false, deleted: false,
    input: 'recordings/a.raw', batch: 'tuning', platform: 'linux', user: 'bob', configurations: ['base'],
    project: 'group/project', commit: 'abc', url: '/group/project/commit/abc?batch=tuning&filter=recordings%2Fa.raw&selected_views=logs',
  }
  const signedIn = () => { server.user = { is_authenticated: true, user_name: 'alice' } }

  it("shows the run of the folder, with a link to its results", async () => {
    server.run = RUN
    renderAt('/s/algo/project/outputs/')
    const bar = await screen.findByRole('region', { name: 'Run' })
    expect(within(bar).getByText('Failed')).toBeTruthy()
    expect(within(bar).getByText('recordings/a.raw')).toBeTruthy()
    expect(within(bar).getByText('Results').closest('a').getAttribute('href')).toBe(RUN.url)
  })

  it("doesn't show a run for other folders", async () => {
    server.run = RUN
    renderAt('/s/algo/project/')
    await screen.findByText('frame2.png')
    expect(screen.queryByRole('region', { name: 'Run' })).toBeNull()
  })

  it('redoes the run after a confirmation', async () => {
    server.run = RUN
    signedIn()
    renderAt('/s/algo/project/outputs/')
    const bar = await screen.findByRole('region', { name: 'Run' })
    fireEvent.click(within(bar).getByRole('button', { name: /Redo/ }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Redo' }))
    await waitFor(() => expect(server.actions).toEqual(['POST /api/v1/output/redo/42/']))
    await waitFor(() => expect(within(bar).getByText('Pending')).toBeTruthy())
  })

  it('deletes only the files if asked', async () => {
    server.run = RUN
    signedIn()
    renderAt('/s/algo/project/outputs/')
    const bar = await screen.findByRole('region', { name: 'Run' })
    fireEvent.click(within(bar).getByRole('button', { name: /Delete/ }))
    fireEvent.click(await screen.findByLabelText(/Only delete its files/))
    fireEvent.click(screen.getByRole('button', { name: 'Delete its files' }))
    await waitFor(() => expect(server.actions).toEqual(['DELETE /api/v1/output/42/?soft=true']))
  })

  it('asks to sign in before changing runs', async () => {
    server.run = RUN
    renderAt('/s/algo/project/outputs/')
    const bar = await screen.findByRole('region', { name: 'Run' })
    fireEvent.click(within(bar).getByRole('button', { name: /Redo/ }))
    expect(await screen.findByRole('dialog', { name: /Sign in/ })).toBeTruthy()
    expect(server.actions).toEqual([])
  })
})
