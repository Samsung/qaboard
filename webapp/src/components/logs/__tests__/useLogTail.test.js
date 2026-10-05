/**
 * Tests for following logs with HTTP Range requests.
 * Run with: cd webapp && npm test -- useLogTail
 */
import { renderHook, waitFor, act } from '@testing-library/react';

import { useLogTail } from '../useLogTail';
import { parseContentRange } from '../fetchRange';


// Answers like nginx
function fakeServer({ ranges = true } = {}) {
  const server = { content: '', exists: true, requests: [] }
  server.fetch = vi.fn(async (url, { headers }) => {
    const range = headers.Range
    server.requests.push(range ?? 'all')
    if (!server.exists) return new Response('Not Found', { status: 404 })
    const bytes = new TextEncoder().encode(server.content)
    const size = bytes.byteLength
    if (!range || !ranges)
      return new Response(bytes, { status: 200 })
    let [, start, end] = /bytes=(\d*)-(\d*)/.exec(range)
    if (start === '') {
      start = Math.max(0, size - parseInt(end, 10))
      end = size - 1
    } else {
      start = parseInt(start, 10)
      end = end === '' ? size - 1 : Math.min(parseInt(end, 10), size - 1)
    }
    if (start >= size)
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    return new Response(bytes.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${size}` } })
  })
  vi.stubGlobal('fetch', server.fetch)
  return server
}

afterEach(() => {
  vi.unstubAllGlobals()
})


it('parseContentRange', () => {
  expect(parseContentRange('bytes 0-99/1234')).toEqual({ start: 0, end: 99, total: 1234 })
  expect(parseContentRange('bytes */1234')).toEqual({ start: null, end: null, total: 1234 })
  expect(parseContentRange(null)).toBeNull()
})


describe('useLogTail', () => {
  it('reads the end of large files, without the first partial line', async () => {
    const server = fakeServer()
    server.content = 'line 1\nline 2\nline 3\n'
    const { result } = renderHook(() => useLogTail('/s/log.txt', { initialBytes: 10 }))
    await waitFor(() => expect(result.current.status).toBe('loaded'))
    expect(result.current.text).toBe('line 3\n')
    expect(result.current.start).toBe(11)
    expect(result.current.total).toBe(21)
    expect(server.requests).toEqual(['bytes=-10'])

    act(() => result.current.loadAll())
    await waitFor(() => expect(result.current.start).toBe(0))
    expect(result.current.text).toBe(server.content)
    expect(server.requests[1]).toBe('all')
  })

  it('reads only new bytes while live', async () => {
    const server = fakeServer()
    server.content = 'start\n'
    const { result, rerender } = renderHook(({ live }) => useLogTail('/s/log.txt', { live, interval: 10 }), { initialProps: { live: true } })
    await waitFor(() => expect(result.current.text).toBe('start\n'))

    server.content += 'more é\n'
    await waitFor(() => expect(result.current.text).toBe('start\nmore é\n'))
    expect(server.requests).toContain('bytes=6-')
    expect(server.requests).toContain('bytes=14-')

    // The run ends: we read what's left
    server.content += 'done\n'
    rerender({ live: false })
    await waitFor(() => expect(result.current.text).toBe('start\nmore é\ndone\n'))
    const count = server.requests.length
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(server.requests.length).toBe(count)
  })

  it('starts over when the file is replaced', async () => {
    const server = fakeServer()
    server.content = 'old run, long logs\n'
    const { result } = renderHook(() => useLogTail('/s/log.txt', { live: true, interval: 10 }))
    await waitFor(() => expect(result.current.text).toBe('old run, long logs\n'))
    server.content = 'new run\n'
    await waitFor(() => expect(result.current.text).toBe('new run\n'))
  })

  it('works when the server ignores ranges', async () => {
    const server = fakeServer({ ranges: false })
    server.content = 'a\n'
    const { result } = renderHook(() => useLogTail('/s/log.txt', { live: true, interval: 10 }))
    await waitFor(() => expect(result.current.text).toBe('a\n'))
    server.content = 'a\nb\n'
    await waitFor(() => expect(result.current.text).toBe('a\nb\n'))
  })

  it('waits for logs that do not exist yet', async () => {
    const server = fakeServer()
    server.exists = false
    const { result } = renderHook(() => useLogTail('/s/log.txt', { live: true, interval: 10 }))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error.status).toBe(404)
    server.exists = true
    server.content = 'started\n'
    await waitFor(() => expect(result.current.text).toBe('started\n'))
  })
})
