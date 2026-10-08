/**
 * Tests for the runs in the logs view.
 * Run with: cd webapp && npm test -- RunLogs
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupIntersectionMocking, resetIntersectionMocking } from 'react-intersection-observer/test-utils';

import { RunLogs, configurationSummary, runName } from '../RunLogs';


const output = {
  id: 7,
  output_type: 'slam',
  platform: 'linux',
  configurations: ['base', { isp: { denoise: 0.8 }, roi: [1, 2] }],
  extra_parameters: { lr: 0.1 },
  is_failed: false,
  is_pending: false,
  is_running: false,
  data: {},
  output_dir_url: '/s/out/7',
  test_input_database: '/db',
  test_input_path: 'scenes/indoor/sequence_7.mp4',
  test_input_metadata: {},
}

beforeEach(() => {
  setupIntersectionMocking(vi.fn)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Not Found', { status: 404 })))
})

afterEach(() => {
  resetIntersectionMocking()
  vi.unstubAllGlobals()
})


describe('configurationSummary', () => {
  it('lists the configurations and tuning parameters on one line', () => {
    expect(configurationSummary(output)).toBe('base · isp: {"denoise":0.8} · lr=0.1')
  })
  it('mentions unusual platforms', () => {
    expect(configurationSummary({ ...output, platform: 'windows', configurations: [], extra_parameters: {} })).toBe('@windows')
  })
  it('handles runs without configurations', () => {
    expect(configurationSummary({})).toBe('')
  })
})


describe('runName', () => {
  it('prefers labels', () => {
    expect(runName(output)).toBe('scenes/indoor/sequence_7.mp4')
    expect(runName({ ...output, test_input_metadata: { label: 'Indoor 7' } })).toBe('Indoor 7')
    expect(runName({ ...output, test_input_database: '/', test_input_path: 'abs/path' })).toBe('/abs/path')
  })
})


describe('RunLogs', () => {
  const renderRun = (props = {}) => {
    const onToggle = vi.fn()
    const view = render(<RunLogs id={7} output={output} project="p" commit={{ id: 'abc' }} dispatch={vi.fn()} expanded={false} onToggle={onToggle} {...props} />)
    return { ...view, onToggle }
  }

  it('shows the run and its configuration as text, without waiting to be on screen', () => {
    renderRun()
    expect(screen.getByText('scenes/indoor/sequence_7.mp4')).toBeInTheDocument()
    expect(screen.getByText('base · isp: {"denoise":0.8} · lr=0.1')).toBeInTheDocument()
    // the configuration tags are only rendered for expanded runs
    expect(screen.queryByText('Configuration')).toBeNull()
    expect(screen.getByLabelText('Open the output directory')).toHaveAttribute('href', '/s/out/7/') // the file browser, even if the folder is missing
  })

  it('toggles when clicking the row, not its buttons', () => {
    const { onToggle } = renderRun()
    fireEvent.click(screen.getByText('scenes/indoor/sequence_7.mp4'))
    expect(onToggle).toHaveBeenCalledWith(7)
    onToggle.mockClear()
    fireEvent.click(screen.getByLabelText('Run actions'))
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('has the run actions in a menu', async () => {
    renderRun()
    fireEvent.click(screen.getByLabelText('Run actions'))
    expect(await screen.findByText('Redo')).toBeInTheDocument()
    expect(screen.getByText('Delete')).toBeInTheDocument()
  })

  it('shows the full configuration with the logs', async () => {
    renderRun({ expanded: true })
    expect(screen.getByText('Configuration')).toBeInTheDocument()
    expect(screen.getByText('base', { selector: '.bp6-tag *' })).toBeInTheDocument()
    expect(screen.getByLabelText('Download')).toHaveAttribute('href', '/s/out/7/log.txt')
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/s/out/7/log.dask.txt', expect.anything()))
    await screen.findByText('No log.txt yet')
  })

  it('has no run actions for the batch logs', () => {
    renderRun({ title: 'Batch logs', output: { ...output, output_type: 'batch', id: undefined } })
    expect(screen.getByText('Batch logs')).toBeInTheDocument()
    expect(screen.queryByLabelText('Run actions')).toBeNull()
    expect(screen.queryByText(/lr=0\.1/)).toBeNull()
  })
})
