/**
 * Tests for batches started from QA-Board.
 * Run with: cd webapp && npm test -- submissions
 */
import { render, screen, renderHook, waitFor, fireEvent } from '@testing-library/react';

import { batchSubmissions, lastErrorLine, parseExitMarker, submissionState, useSubmissionStatus } from '../submissions';
import { SubmissionCallout, failureSummary } from '../BatchSubmissions';
import { parseLsfReport } from '../lsf';


const lsf_submission = {
  id: 'abcdef12-0000', created_at: '2026-10-05T10:00:00Z', user: 'roee', runner: 'lsf',
  command: 'qa batch --batch nightly', status: 'submitted', lsf_job_id: '1234', queue: 'normal',
  log_dir_url: '/s/batch/qaboard-batches/20261005-100000-abcdef12',
}
const memlimit = parseLsfReport('Sender: LSF System <a>\nTERM_MEMLIMIT: job killed after reaching LSF memory usage limit.\nExited with exit code 137.\n')


describe('submissionState', () => {
  it('trusts the backend when it knows', () => {
    expect(submissionState({ status: 'failed', exit_code: 2 }).state).toBe('failed')
    expect(submissionState({ status: 'failed', error: 'bsub: not found' }).error).toBe('bsub: not found')
    expect(submissionState({ status: 'done' }).state).toBe('done')
  })

  it('follows LSF jobs', () => {
    expect(submissionState(lsf_submission, { log: { exists: false } }).state).toBe('queued')
    expect(submissionState(lsf_submission, { log: { exists: true, tail: '+ qa batch\n' } }).state).toBe('running')
    expect(submissionState(lsf_submission, { log: { exists: true, tail: '[qaboard] qa batch exited with code 0\n' } }).state).toBe('done')
    const failed = submissionState(lsf_submission, { log: { exists: true, tail: "+ echo '[qaboard] qa batch exited with code 1'\n[qaboard] qa batch exited with code 1\n" } })
    expect(failed).toMatchObject({ state: 'failed', exit_code: 1 })
    // Killed by LSF: the script could not say goodbye
    expect(submissionState(lsf_submission, { log: { exists: true, tail: 'Killed' }, report: memlimit })).toMatchObject({ state: 'failed', exit_code: 137 })
  })

  it('finds the error that made qa batch fail', () => {
    const tail = [
      '+ qa batch', 'WARNING: no server', 'Traceback (most recent call last):', '  File "x.py", line 1', "\x1b[31mModuleNotFoundError: No module named 'sirc'\x1b[0m",
      "+ echo '[qaboard] qa batch exited with code 1'", '[qaboard] qa batch exited with code 1',
    ].join('\n')
    expect(lastErrorLine(tail)).toBe("ModuleNotFoundError: No module named 'sirc'")
    expect(submissionState(lsf_submission, { log: { exists: true, tail } }).last_error).toBe("ModuleNotFoundError: No module named 'sirc'")
    expect(lastErrorLine('all good\n')).toBeNull()
  })

  it('parseExitMarker uses the last marker', () => {
    expect(parseExitMarker(null)).toBeNull()
    expect(parseExitMarker('[qaboard] qa batch exited with code 3\n[qaboard] qa batch exited with code 0')).toBe(0)
  })

  it('batchSubmissions sorts the most recent first', () => {
    const batch = { data: { submissions: { a: { id: 'a', created_at: '2026-10-01T00:00:00Z' }, b: { id: 'b', created_at: '2026-10-05T00:00:00Z' } } } }
    expect(batchSubmissions(batch).map(s => s.id)).toEqual(['b', 'a'])
    expect(batchSubmissions({ data: {} })).toEqual([])
  })

  it('failureSummary', () => {
    expect(failureSummary(lsf_submission, { report: memlimit })).toMatch(/^LSF: out of memory\. The run used more memory.*definition of the batch/)
    expect(failureSummary(lsf_submission, { exit_code: 1 })).toBe('qa batch exited with code 1.')
    expect(failureSummary({ ...lsf_submission, status: 'failed' }, { exit_code: null })).toBe('Could not submit the job to LSF.')
  })
})


describe('useSubmissionStatus', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('polls until qa batch is done', async () => {
    const files = {}
    vi.stubGlobal('fetch', vi.fn(async url => {
      const name = url.split('/').pop()
      if (!(name in files)) return new Response('Not Found', { status: 404 })
      const bytes = new TextEncoder().encode(files[name])
      return new Response(bytes, { status: 206, headers: { 'Content-Range': `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}` } })
    }))
    const { result } = renderHook(() => useSubmissionStatus(lsf_submission, { interval: 10 }))
    expect(result.current.state).toBe('queued')
    files['log.txt'] = '+ qa batch\n'
    await waitFor(() => expect(result.current.state).toBe('running'))
    files['log.lsf.txt'] = 'Sender: LSF System <a>\nSuccessfully completed.\n'
    await waitFor(() => expect(result.current.state).toBe('done'))
    const calls = fetch.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(fetch.mock.calls.length).toBe(calls)
  })
})


describe('SubmissionCallout', () => {
  it('says why the batch failed, and links to the logs', () => {
    window.history.replaceState(null, '', '/p/commit/abc?batch=nightly')
    const batch = { data: { submissions: { a: { ...lsf_submission, runner: 'local', status: 'failed', exit_code: 1 } } } }
    render(<SubmissionCallout batch={batch} has_runs={true} />)
    expect(screen.getByText('The batch you started from QA-Board failed')).toBeInTheDocument()
    expect(screen.getByText('qa batch exited with code 1.')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Show the logs'))
    expect(window.location.pathname).toBe('/p/commit/abc')
    expect(new URLSearchParams(window.location.search).getAll('selected_views')).toEqual(['logs'])
    expect(new URLSearchParams(window.location.search).get('batch')).toBe('nightly')
  })

  it('says nothing when runs show the batch is fine', () => {
    const batch = { data: { submissions: { a: { ...lsf_submission, status: 'done' } } } }
    const { container } = render(<SubmissionCallout batch={batch} has_runs={true} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('explains batches without runs', () => {
    const batch = { data: { submissions: { a: { ...lsf_submission, status: 'done' } } } }
    render(<SubmissionCallout batch={batch} has_runs={false} />)
    expect(screen.getByText("qa batch didn't start any run")).toBeInTheDocument()
  })

  it('renders nothing for batches not started from QA-Board', () => {
    const { container } = render(<SubmissionCallout batch={{ data: {} }} has_runs={false} />)
    expect(container).toBeEmptyDOMElement()
  })
})
