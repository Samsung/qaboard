/**
 * Tests for copying to the clipboard.
 * Run with: cd webapp && npm test -- clipboard
 */
import copy from 'copy-to-clipboard';
import { Intent } from '@blueprintjs/core';

import { toaster } from '../../toaster';
import { copyText, copyWithToast } from '../clipboard';
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
