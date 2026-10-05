/**
 * Tests for the log viewer.
 * Run with: cd webapp && npm test -- LogViewer
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';

import { LogViewer, formatBytes } from '../LogViewer';


const files = {
  '/s/run/log.txt': 'Outputs: /s/run\n\x1b[32mloading\x1b[0m <model>\nframe 1\nframe 2\nTraceback (most recent call last):\nValueError: bad frame\n',
  '/s/run/log.lsf.txt': 'everything\nSuccessfully completed.\n',
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (!(url in files)) return new Response('Not Found', { status: 404 })
    const bytes = new TextEncoder().encode(files[url])
    return new Response(bytes, { status: 206, headers: { 'Content-Range': `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}` } })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})


const Viewer = props => {
  const [file, setFile] = useState('log.txt')
  return <LogViewer
    files={[{ name: 'log.txt', url: '/s/run/log.txt' }, { name: 'log.lsf.txt', url: '/s/run/log.lsf.txt' }]}
    file={file}
    onFileChange={setFile}
    {...props}
  />
}


describe('LogViewer', () => {
  it('shows lines, with numbers, colors and errors', async () => {
    const { container } = render(<Viewer />)
    await waitFor(() => expect(screen.getByText('frame 2')).toBeInTheDocument())
    expect(screen.getByText('<model>', { exact: false })).toBeInTheDocument()
    const lines = container.querySelectorAll('.line')
    expect(lines).toHaveLength(6)
    expect(lines[1].querySelector('.number').textContent).toBe('2')
    expect(lines[1].querySelector('.content span').getAttribute('style')).toMatch(/^color:#/)
    expect(container.querySelectorAll('.line.error')).toHaveLength(2)
    expect(container.querySelector('.meta').textContent).toMatch(/^6 lines · \d+ B$/)
    expect(screen.getByRole('button', { name: /2 errors/ })).toBeInTheDocument()
  })

  it('searches', async () => {
    const { container } = render(<Viewer />)
    await waitFor(() => expect(screen.getByText('frame 2')).toBeInTheDocument())
    const search = screen.getByPlaceholderText('Search…')
    fireEvent.change(search, { target: { value: 'FRAME' } })
    await waitFor(() => expect(screen.getByText('1/3')).toBeInTheDocument())
    expect(container.querySelectorAll('.line.match')).toHaveLength(3)
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(screen.getByText('2/3')).toBeInTheDocument()
    fireEvent.keyDown(search, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(search, { key: 'Enter', shiftKey: true })
    expect(screen.getByText('3/3')).toBeInTheDocument()
    fireEvent.keyDown(search, { key: 'Escape' })
    await waitFor(() => expect(container.querySelectorAll('.line.match')).toHaveLength(0))
  })

  it('switches files', async () => {
    render(<Viewer />)
    await waitFor(() => expect(screen.getByText('frame 2')).toBeInTheDocument())
    fireEvent.click(screen.getByText('log.lsf.txt'))
    await waitFor(() => expect(screen.getByText('Successfully completed.')).toBeInTheDocument())
    expect(screen.queryByText('frame 2')).not.toBeInTheDocument()
  })

  it('explains missing files', async () => {
    render(<LogViewer files={[{ name: 'log.lsf.txt', url: '/s/other/log.lsf.txt' }]} emptyHint={{ 'log.lsf.txt': 'Only runs on LSF have it.' }} />)
    await waitFor(() => expect(screen.getByText('No log.lsf.txt yet')).toBeInTheDocument())
    expect(screen.getByText('Only runs on LSF have it.')).toBeInTheDocument()
  })
})


it('formatBytes', () => {
  expect(formatBytes(0)).toBe('0 B')
  expect(formatBytes(1536)).toBe('1.5 KB')
  expect(formatBytes(512 * 1024)).toBe('512 KB')
  expect(formatBytes(12.3 * 1024 * 1024)).toBe('12 MB')
})
