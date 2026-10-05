// Reads (part of) files served by nginx, with HTTP Range requests.
// https://developer.mozilla.org/en-US/docs/Web/HTTP/Range_requests
//
// - 206: the server sent the range we asked for
// - 200: the server ignored the range and sent the whole file (e.g. it compressed the response)
// - 416: the range starts after the end of the file (nothing new, or the file shrunk)


export class HttpError extends Error {
  constructor(status, url) {
    super(`${status === 404 ? 'Not found' : `HTTP ${status}`}: ${url}`)
    this.status = status
  }
}


// "bytes 0-99/1234" or "bytes */1234"
export function parseContentRange(header) {
  const match = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+|\*)$/.exec((header ?? '').trim())
  if (!match) return null
  return {
    start: match[1] !== undefined ? parseInt(match[1], 10) : null,
    end: match[2] !== undefined ? parseInt(match[2], 10) : null,
    total: match[3] === '*' ? null : parseInt(match[3], 10),
  }
}


// Returns the bytes we got, and where they are in the file: [start, end[
export async function fetchRange(url, range, { signal } = {}) {
  const response = await fetch(url, {
    headers: range ? { Range: range } : {},
    // logs change while runs are running, and browsers could otherwise cache them
    cache: 'no-store',
    signal,
  })
  if (![200, 206, 416].includes(response.status))
    throw new HttpError(response.status, url)
  const content_range = parseContentRange(response.headers.get('content-range'))
  const bytes = response.status === 416 ? new Uint8Array(0) : new Uint8Array(await response.arrayBuffer())
  const start = response.status === 206 ? (content_range?.start ?? 0) : 0
  const total = content_range?.total ?? (response.status === 200 ? bytes.byteLength : null)
  return {
    status: response.status,
    bytes,
    start,
    end: start + bytes.byteLength,
    total,
  }
}


export const decodeText = bytes => new TextDecoder().decode(bytes)
