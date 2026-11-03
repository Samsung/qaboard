/**
 * Tests for copying to the clipboard.
 * Run with: cd webapp && npm test -- clipboard
 */
import copy from 'copy-to-clipboard';
import { Intent } from '@blueprintjs/core';

import { toaster } from '../../toaster';
import { copyText, copyWithToast, copyHtml, copyLink, link_html } from '../clipboard';
import { copyDirectory, directoryPath } from '../../components/logs/DirectoryActions';
import { setPathMappings } from '../paths';

vi.mock('copy-to-clipboard', () => ({ default: vi.fn(() => true) }))
vi.mock('../../toaster', () => ({ toaster: { show: vi.fn() } }))


const secureClipboard = writeText => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  vi.stubGlobal('isSecureContext', true)
}

afterEach(() => {
  delete navigator.clipboard
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  setPathMappings([])
})


describe('copyText', () => {
  it('uses navigator.clipboard in secure contexts', async () => {
    const writeText = vi.fn(async () => {})
    secureClipboard(writeText)
    expect(await copyText('hello')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(copy).not.toHaveBeenCalled()
  })

  it('falls back to copy-to-clipboard over http', async () => {
    expect(navigator.clipboard).toBeUndefined()
    expect(await copyText('hello')).toBe(true)
    expect(copy).toHaveBeenCalledWith('hello', { format: 'text/plain' })
  })

  it('falls back to copy-to-clipboard when navigator.clipboard fails', async () => {
    secureClipboard(vi.fn(async () => { throw new Error('Document is not focused') }))
    copy.mockReturnValueOnce(false)
    expect(await copyText('hello')).toBe(false)
    expect(copy).toHaveBeenCalledWith('hello', { format: 'text/plain' })
  })
})


describe('copyWithToast', () => {
  it('says what it copied', async () => {
    expect(await copyWithToast('qa batch', { what: 'the command' })).toBe(true)
    expect(copy).toHaveBeenCalledWith('qa batch', { format: 'text/plain' })
    expect(toaster.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Copied the command', intent: Intent.SUCCESS, icon: 'tick' }), 'copy')
  })

  it('takes other toast props', async () => {
    await copyWithToast('x', { what: 'the logs', message: 'Copied 6 lines', timeout: 4000, key: 'logs' })
    expect(toaster.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Copied 6 lines', timeout: 4000 }), 'logs')
  })

  it('says when it could not copy', async () => {
    copy.mockReturnValueOnce(false)
    expect(await copyWithToast('qa batch', { what: 'the command', message: 'Copied!' })).toBe(false)
    expect(toaster.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Could not copy the command', intent: Intent.DANGER }), 'copy')
  })
})


describe('copyDirectory', () => {
  it('copies paths, not URLs', async () => {
    expect(directoryPath('/s/algo/a%20b%2311/')).toBe('/algo/a b#11')
    await copyDirectory('/s/algo/a%20b%2311')
    expect(copy).toHaveBeenLastCalledWith('/algo/a b#11', expect.anything())
    expect(toaster.show.mock.lastCall[0].action).toBeUndefined()
  })

  it('copies Windows paths', async () => {
    setPathMappings([['\\\\netapp\\algo', '/algo']])
    await copyDirectory('/s/algo/a%20b')
    expect(copy).toHaveBeenLastCalledWith('/algo/a b', expect.anything())
    // the Windows path is one click away
    const { action } = toaster.show.mock.lastCall[0]
    action.onClick()
    await vi.waitFor(() => expect(copy).toHaveBeenLastCalledWith('\\\\netapp\\algo\\a b', expect.anything()))
    await copyDirectory('/s/algo/a%20b', { windows: true })
    expect(copy).toHaveBeenLastCalledWith('\\\\netapp\\algo\\a b', expect.anything())
  })
})


describe('copyLink', () => {
  const secureHtmlClipboard = () => {
    const write = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true })
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('ClipboardItem', class { constructor(items) { this.items = items } })
    return write
  }
  // jsdom's blobs are not Node's: read them like a browser
  const blobText = blob => new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(blob); })

  it('copies the link as HTML, with the URL as plain text, and says how it pastes', async () => {
    const write = secureHtmlClipboard()
    const url = 'http://qa/p/commit/abc?label=ISP%20v2'
    expect(await copyLink({ url, text: 'ISP v2 vs baseline · p', details: 'Faster denoising · 40 runs: 37 passed, 3 failed' })).toBe(true)
    const [item] = write.mock.calls[0][0]
    expect(await blobText(item.items['text/html'])).toBe(`<a href="${url}">ISP v2 vs baseline · p</a>: Faster denoising · 40 runs: 37 passed, 3 failed`)
    expect(await blobText(item.items['text/plain'])).toBe(url)
    expect(toaster.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Copied the link: it pastes as “ISP v2 vs baseline · p”', intent: Intent.SUCCESS }), 'copy')
  })

  it('escapes the HTML', () => {
    expect(link_html({ url: 'http://qa/?a=1&b=2', text: '<b> & "q"' })).toBe('<a href="http://qa/?a=1&amp;b=2">&lt;b&gt; &amp; &quot;q&quot;</a>')
  })

  it('falls back to a copy event over http, with both formats', async () => {
    const setData = vi.fn()
    document.execCommand = vi.fn(() => {
      const event = new Event('copy', { bubbles: true })
      event.clipboardData = { setData, clearData: vi.fn() }
      document.body.querySelector('span').dispatchEvent(event)
      return true
    })
    expect(await copyHtml('<a href="http://qa/">qa</a>', 'http://qa/')).toBe(true)
    expect(setData).toHaveBeenCalledWith('text/html', '<a href="http://qa/">qa</a>')
    expect(setData).toHaveBeenCalledWith('text/plain', 'http://qa/')
    expect(document.body.querySelector('span')).toBeNull()
    delete document.execCommand
  })

  it('says when it could not copy', async () => {
    document.execCommand = vi.fn(() => false)
    expect(await copyLink({ url: 'http://qa/', text: 'qa' })).toBe(false)
    expect(toaster.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Could not copy the link', intent: Intent.DANGER }), 'copy')
    delete document.execCommand
  })
})
