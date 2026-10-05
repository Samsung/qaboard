import { useCallback, useEffect, useRef, useState } from 'react'

import { fetchRange } from './fetchRange'


// Logs can be large: we start with the end of the file
export const INITIAL_BYTES = 512 * 1024

const EMPTY = { text: '', status: 'idle', error: null, start: 0, end: 0, total: null }


/**
 * Reads a log file, and follows it while `live`, like `tail -f`:
 * we only ask the server for the bytes we don't have yet (HTTP Range requests).
 *
 * Returns { text, status: 'idle'|'loading'|'loaded'|'error', error, start, end, total, loadAll, reload }
 * - [start, end[ are the bytes we have. If start > 0, we don't have the start of the file.
 * - total is the size of the file
 */
export function useLogTail(url, { live = false, interval = 2000, initialBytes = INITIAL_BYTES } = {}) {
  const [log, setLog] = useState({ ...EMPTY, key: null, url: null })
  // the url for which users asked for the whole file
  const [all_url, setAllUrl] = useState(null)
  const [generation, setGeneration] = useState(0)
  // where we are in the file
  const cursor = useRef(null)

  const all = !!url && all_url === url
  // Identifies what we read
  const key = url ? `${generation} ${all} ${url}` : null
  const reload = useCallback(() => setGeneration(g => g + 1), [])
  const loadAll = useCallback(() => setAllUrl(url), [url])

  // First read
  useEffect(() => {
    if (!url) return
    const controller = new AbortController()
    const current = { url, end: 0, decoder: new TextDecoder(), controller, busy: false }
    cursor.current = current
    fetchRange(url, all ? null : `bytes=-${initialBytes}`, { signal: controller.signal })
      .then(({ status, bytes, start, end, total }) => {
        let text = current.decoder.decode(bytes, { stream: true })
        // We don't show the first line, it's likely cut
        if (start > 0) {
          const newline = text.indexOf('\n')
          text = newline >= 0 ? text.slice(newline + 1) : ''
        }
        current.end = status === 416 ? 0 : end
        setLog({ text, status: 'loaded', error: null, start, end: current.end, total: total ?? current.end, key, url })
      })
      .catch(error => {
        if (controller.signal.aborted) return
        setLog({ ...EMPTY, status: 'error', error, key, url })
      })
    return () => controller.abort()
  }, [url, all, key, initialBytes])

  let state
  if (!url)
    state = EMPTY
  else if (log.key === key)
    state = log
  else if (all && log.url === url)
    // we keep showing the end of the file while we read everything
    state = { ...log, status: 'loading' }
  else
    state = { ...EMPTY, status: 'loading' }

  // Reads what was added since the last time
  const readMore = useCallback(async () => {
    const current = cursor.current
    if (!current || current.busy || current.url !== url) return
    current.busy = true
    try {
      const { status, bytes, start, end, total } = await fetchRange(url, `bytes=${current.end}-`, { signal: current.controller.signal })
      if (cursor.current !== current) return
      if (status === 206) {
        const chunk = current.decoder.decode(bytes, { stream: true })
        current.end = end
        if (chunk)
          setLog(log => ({ ...log, text: log.text + chunk, end, total: total ?? end }))
      } else if (status === 200) {
        // The server doesn't support ranges, we got everything again
        current.decoder = new TextDecoder()
        current.end = end
        const text = current.decoder.decode(bytes, { stream: true })
        setLog(log => ({ ...log, text, start, end, total: total ?? end }))
      } else if (status === 416 && total !== null && total < current.end) {
        // The file is smaller than before: it was replaced, e.g. the run was restarted
        setGeneration(g => g + 1)
      }
    } catch {
      // we'll retry at the next poll
    } finally {
      current.busy = false
    }
  }, [url])

  // Follow the file while it's written
  const is_loaded = state.status === 'loaded'
  useEffect(() => {
    if (!live || !is_loaded) return
    let timer = null
    let stopped = false
    const poll = async () => {
      await readMore()
      if (!stopped)
        timer = setTimeout(poll, interval)
    }
    timer = setTimeout(poll, interval)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [live, is_loaded, readMore, interval])

  // When the run ends, we read what was written since the last poll
  const was_live = useRef(live)
  useEffect(() => {
    if (was_live.current && !live && is_loaded)
      readMore()
    was_live.current = live
  }, [live, is_loaded, readMore])

  // While runs are starting, their logs may not exist yet.
  // (We depend on the error, not the status: a failed retry gives a new error, the status stays the same)
  const error = state.error
  useEffect(() => {
    if (!live || !error) return
    const timer = setTimeout(reload, 2 * interval)
    return () => clearTimeout(timer)
  }, [live, error, reload, interval])

  return { text: state.text, status: state.status, error: state.error, start: state.start, end: state.end, total: state.total, loadAll, reload }
}
