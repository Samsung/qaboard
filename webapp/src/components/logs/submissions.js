import { useCallback, useMemo, useSyncExternalStore } from 'react'

import { fetchRange, decodeText } from './fetchRange'
import { fetchLsfReport } from './lsf'
import { lineLevel, stripAnsi } from './logLines'


// Batches started from QA-Board run `qa batch` with a script that ends by printing this
const EXIT_MARKER = /\[qaboard\] qa batch exited with code (\d+)/g

export function parseExitMarker(text) {
  let code = null
  for (const match of (text ?? '').matchAll(EXIT_MARKER))
    code = parseInt(match[1], 10)
  return code
}


// The last error in the logs, e.g. "ModuleNotFoundError: No module named 'foo'"
export function lastErrorLine(text) {
  const lines = (text ?? '').split('\n').map(line => stripAnsi(line).trim())
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    // bash's `set -x` echoes commands
    if (line.startsWith('+ ') || EXIT_MARKER_LINE.test(line)) continue
    if (lineLevel(line) === 'error') return line
  }
  return null
}
const EXIT_MARKER_LINE = /\[qaboard\] qa batch exited with code/


// The submissions recorded in batch.data, most recent first
export function batchSubmissions(batch) {
  return Object.values(batch?.data?.submissions ?? {})
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
}


/**
 * Where is `qa batch` at, for a batch started from QA-Board?
 * - queued: LSF didn't start the job yet
 * - running
 * - done: `qa batch` exited successfully
 * - failed: we could not submit the job, `qa batch` failed, or LSF killed it
 *
 * `report` is LSF's job report (from log.lsf.txt), `log` what we know of log.txt: {exists, tail}
 */
export function submissionState(submission, { report = null, log = null } = {}) {
  if (submission.status === 'failed')
    return { state: 'failed', exit_code: submission.exit_code ?? null, error: submission.error ?? null, report }
  if (submission.status === 'done')
    return { state: 'done', exit_code: 0, report }
  if (report?.successful)
    return { state: 'done', exit_code: 0, report }
  if (report?.exited)
    return { state: 'failed', exit_code: report.exit_code, report, last_error: lastErrorLine(log?.tail) }
  const exit_code = parseExitMarker(log?.tail)
  if (exit_code !== null)
    return { state: exit_code === 0 ? 'done' : 'failed', exit_code, report, last_error: exit_code ? lastErrorLine(log?.tail) : null }
  if (log?.exists || submission.status === 'submitting')
    return { state: 'running', report }
  return { state: 'queued', report }
}

export const is_final = state => state === 'done' || state === 'failed'


// We only need the end of log.txt
const TAIL_BYTES = 4096

async function readLogTail(url, signal) {
  try {
    const { bytes } = await fetchRange(url, `bytes=-${TAIL_BYTES}`, { signal })
    return { exists: true, tail: decodeText(bytes) }
  } catch (error) {
    if (error.status === 404) return { exists: false, tail: '' }
    throw error
  }
}

async function readReport(url, signal) {
  try {
    return await fetchLsfReport(url, { signal })
  } catch (error) {
    if (error.status === 404) return null
    throw error
  }
}


// Several components show the status of the same submission: they share the polling.
const stores = new Map()

const storeKey = submission => `${submission.status} ${submission.log_dir_url}`

function getStore(submission) {
  const key = storeKey(submission)
  if (!stores.has(key))
    stores.set(key, { status: submissionState(submission), listeners: new Set(), controller: null, timer: null })
  return stores.get(key)
}

function startPolling(store, submission, interval) {
  const { log_dir_url, status: backend_status } = submission
  if (store.controller || is_final(store.status.state) || !log_dir_url || backend_status === 'failed' || backend_status === 'done') return
  const controller = new AbortController()
  store.controller = controller
  const is_lsf = submission.runner === 'lsf'
  const check = async () => {
    try {
      const [log, report] = await Promise.all([
        readLogTail(`${log_dir_url}/log.txt`, controller.signal),
        is_lsf ? readReport(`${log_dir_url}/log.lsf.txt`, controller.signal) : null,
      ])
      store.status = submissionState({ status: backend_status }, { log, report })
      store.listeners.forEach(listener => listener())
      if (is_final(store.status.state)) {
        store.controller = null
        return
      }
    } catch {
      if (controller.signal.aborted) return
    }
    store.timer = setTimeout(check, interval)
  }
  check()
}

function stopPolling(store) {
  store.controller?.abort()
  clearTimeout(store.timer)
  store.controller = null
}


/**
 * Follows the status of a batch started from QA-Board, until `qa batch` is done.
 */
export function useSubmissionStatus(submission, { interval = 10000 } = {}) {
  // The submission object changes with each refresh of the batch, not the fields we need
  const { status, log_dir_url, runner, exit_code, error } = submission
  const fields = useMemo(() => ({ status, log_dir_url, runner, exit_code, error }), [status, log_dir_url, runner, exit_code, error])
  const subscribe = useCallback(listener => {
    const store = getStore(fields)
    store.listeners.add(listener)
    startPolling(store, fields, interval)
    return () => {
      store.listeners.delete(listener)
      if (!store.listeners.size) stopPolling(store)
    }
  }, [fields, interval])
  const getSnapshot = useCallback(() => getStore(fields).status, [fields])
  return useSyncExternalStore(subscribe, getSnapshot)
}
