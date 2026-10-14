/**
 * Tests for the logs of a batch: where the logs of the commands that started it are.
 * Run with: cd webapp && npm test -- BatchLogs
 */
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { setupIntersectionMocking, resetIntersectionMocking } from 'react-intersection-observer/test-utils';

import { renderWithProviders } from '../../test-utils';
import { BatchLogs, commandLogs } from '../BatchLogs';


const created_at = '2026-10-10T10:00:00'
const commands = {
  'c1000000-ci': { command_created_at_datetime: created_at, argv: ['qa', 'batch', 'ci'], user: 'gitlab', job_url: 'https://gitlab.example.com/job/1', share: false },
  'c2000000-terminal': { command_created_at_datetime: '2026-10-11T10:00:00', argv: ['qa', '--share', 'batch', 'nightly'], user: 'alice', share: true, runner: 'dask' },
}
const makeBatch = (data = {}) => ({
  id: 1,
  label: 'default',
  batch_dir_url: '/s/b',
  data: { commands, ...data },
  // the batch has runs, but none matches the filters
  outputs: { 1: { id: 1 } },
  filtered: { outputs: [] },
})

let files = {}
beforeEach(() => {
  setupIntersectionMocking(vi.fn)
  files = {}
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (!(url in files)) return new Response('Not Found', { status: 404 })
    const bytes = new TextEncoder().encode(files[url])
    return new Response(bytes, { status: 206, headers: { 'Content-Range': `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}` } })
  }))
})

afterEach(() => {
  delete Element.prototype.scrollIntoView
  resetIntersectionMocking()
  vi.unstubAllGlobals()
})

const renderLogs = batch => renderWithProviders(<BatchLogs batch={batch} project="p" commit={{ id: 'abc' }} />)


describe('commandLogs', () => {
  it('knows where the logs of qa batch are', () => {
    expect(commandLogs('a', { job_url: 'https://ci/1' })).toBe('ci')
    expect(commandLogs('a', {}, { submission_ids: new Set(['a']) })).toBe('qaboard')
    expect(commandLogs('a', { share: true, log: 'qa-batch-logs/20261011-100000-c4000000/log.txt' }, { has_batch_log: true })).toBe('saved')
    // anyone can save commands: we only follow the paths qa batch saves logs to
    expect(commandLogs('a', { share: true, log: '../../../api/v1/user/me/' })).toBe('terminal')
    expect(commandLogs('a', { share: true, log: 'qa-batch-logs/../../../api/v1/x/log.txt' })).toBe('terminal')
    expect(commandLogs('a', { share: false }, { has_batch_log: true })).toBe('batch-log')
    expect(commandLogs('a', { share: true }, { has_batch_log: true })).toBe('terminal')
    expect(commandLogs('a', { share: false })).toBe('unknown')
  })
})


describe('BatchLogs', () => {
  it('says where the logs of each command are', async () => {
    renderLogs(makeBatch())
    expect(screen.getByRole('heading', { name: /^Batch: / })).toBeInTheDocument()
    expect(screen.getByLabelText('Open the batch directory')).toHaveAttribute('href', '/s/b/')
    expect(screen.getByLabelText('Copy the path of the batch directory')).toBeInTheDocument()
    expect(screen.getByText('Logs in the CI job').closest('a')).toHaveAttribute('href', 'https://gitlab.example.com/job/1')
    expect(screen.getByText('Logs not saved: started from a terminal')).toBeInTheDocument()
    expect(screen.getByText("Dask workers' logs").closest('a')).toHaveAttribute('href', '/s/b/dask/c2000000/')
    // the most recent first
    const texts = [...document.querySelectorAll('pre code')].map(code => code.textContent)
    expect(texts).toEqual(['qa --share batch nightly', 'qa batch ci'])
    // there is no log.txt in the batch directory
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/s/b/log.txt', expect.anything()))
    expect(screen.queryByText('Batch logs')).toBeNull()
  })

  it('shows the log.txt of batches started from QA-Board before 2026-10', async () => {
    files['/s/b/log.txt'] = 'starting the tuning\n'
    renderLogs(makeBatch({ commands: { 'c3000000-tuning': { command_created_at_datetime: created_at, argv: ['qa', 'optimize'], share: false } } }))
    await screen.findByText('Batch logs')
    fireEvent.click(screen.getByText('Show its logs'))
    expect(await screen.findByText('starting the tuning')).toBeInTheDocument()
  })

  it('links the commands started from QA-Board to their logs', async () => {
    const id = 'abcdef12-0000'
    files['/s/b/qaboard-batches/1/log.txt'] = '+ qa batch\n[qaboard] qa batch exited with code 0\n'
    const submission = { id, created_at: '2026-10-12T08:00:00Z', user: 'alice', runner: 'local', command: 'qa batch --batch nightly', status: 'done', log_dir_url: '/s/b/qaboard-batches/1' }
    renderLogs(makeBatch({
      commands: { [id]: { command_created_at_datetime: created_at, argv: ['qa', 'batch', '--batch', 'nightly'], share: false } },
      submissions: { [id]: submission },
    }))
    expect(screen.getByText('Started from QA-Board', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByLabelText("Open the folder with qa batch's script and logs")).toHaveAttribute('href', '/s/b/qaboard-batches/1/')
    expect(screen.queryByText('[qaboard] qa batch exited with code 0')).toBeNull()
    fireEvent.click(screen.getByText('Show its logs'))
    await screen.findByText('[qaboard] qa batch exited with code 0')
  })

  it('shows the logs of older submissions, hidden by default', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    const submissions = Object.fromEntries([1, 2, 3, 4].map(day => [`s${day}`, {
      id: `s${day}`, created_at: `2026-10-0${day}T08:00:00Z`, runner: 'local', command: `qa batch ${day}`, status: 'done', log_dir_url: `/s/b/qaboard-batches/${day}`,
    }]))
    files['/s/b/qaboard-batches/1/log.txt'] = 'the oldest\n'
    renderLogs(makeBatch({ commands: { s1: { command_created_at_datetime: created_at, argv: ['qa', 'batch', '1'], share: false } }, submissions }))
    expect(screen.getByText('Show 1 older')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Show its logs'))
    expect(await screen.findByText('the oldest')).toBeInTheDocument()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    // the row mounts again: we don't scroll to it again
    fireEvent.click(screen.getByText('Show less'))
    fireEvent.click(screen.getByText('Show 1 older'))
    expect(await screen.findByText('the oldest')).toBeInTheDocument()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('shows the logs that qa batch saved', async () => {
    const log = 'qa-batch-logs/20261011-100000-c4000000/log.txt'
    files[`/s/b/${log}`] = 'starting 3 runs\n'
    renderLogs(makeBatch({ commands: { 'c4000000-saved': { command_created_at_datetime: created_at, argv: ['qa', '--share', 'batch', 'nightly'], share: true, log } } }))
    expect(screen.queryByText('starting 3 runs')).toBeNull()
    fireEvent.click(screen.getByText('Show its logs'))
    expect(await screen.findByText('starting 3 runs')).toBeInTheDocument()
    // the batch's runs are done
    expect(screen.queryByText('Live')).toBeNull()
    fireEvent.click(screen.getByText('Hide its logs'))
    await waitFor(() => expect(screen.queryByText('starting 3 runs')).toBeNull())
  })

  it('follows the logs of the latest command while runs are pending', async () => {
    const log = 'qa-batch-logs/20261011-100000-c4000000/log.txt'
    files[`/s/b/${log}`] = 'waiting for 3 runs\n'
    renderLogs({
      ...makeBatch({ commands: { 'c4000000-saved': { command_created_at_datetime: created_at, argv: ['qa', 'batch'], share: true, log } } }),
      outputs: { 1: { id: 1, is_pending: true } },
    })
    fireEvent.click(screen.getByText('Show its logs'))
    expect(await screen.findByText('waiting for 3 runs')).toBeInTheDocument()
    expect(screen.getByText('Live')).toBeInTheDocument()
  })

  it('says when no command was saved', async () => {
    renderLogs(makeBatch({ commands: {} }))
    expect(await screen.findByText(/command was saved for this batch/)).toBeInTheDocument()
  })
})
