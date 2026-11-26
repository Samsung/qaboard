/**
 * Tests how to run a qa batch again (reproduce.js).
 * Run with: cd webapp && npm test -- reproduce
 */
import { againLabel, commandText, formPrefill, rawLabel, runSpec, shellQuote, snapshotFileName, terminalCommands } from '../reproduce'


const submission = {
  id: 's1', created_at: '2026-11-17T09:00:00Z', command: 'qa batch ...', log_dir_url: '/s/sub', batch: 'a b',
  batches_snapshot: { path: 'batches.yaml', batches: ['a', 'b'], aliases: [], files: ['qa/b.yaml'], inputs: [] },
  request: { selected_group: ['a', 'b'], platform: 'linux', tuning_search: { search_type: 'grid', parameter_search: { t: [1, 2] } }, overwrite: false },
}

describe('reproduce', () => {
  it('quotes for the shell', () => {
    expect(shellQuote('a-b/c.yaml')).toBe('a-b/c.yaml')
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`)
    expect(shellQuote('')).toBe("''")
    expect(commandText(['/home/a/.venv/bin/qa', '--share', 'batch', 'my batch'])).toBe("qa --share batch 'my batch'")
    expect(commandText(['python', '-m', 'qaboard', 'batch'])).toBe('python -m qaboard batch')
  })

  it('names files and labels', () => {
    expect(snapshotFileName('@alice| night run')).toBe('batches.night-run.yaml')
    expect(snapshotFileName('')).toBe('batches.yaml')
    expect(rawLabel('@alice| x')).toBe('x')
    expect(againLabel('x', ['x', 'x-again'])).toBe('x-again-2')
  })

  it('runs submissions again, from a terminal and from QA-Board', () => {
    const spec = runSpec({ kind: 'submission', submission }, { label: 'night' })
    expect(spec.snapshot.url).toBe('/s/sub/batches.yaml')
    const { local, server } = terminalCommands(spec, { file: 'batches.night.yaml', commit_id: 'abcdef123456789', label: 'night-again' })
    expect(local).toBe(`qa --label night-again --platform linux batch --batches-file batches.night.yaml a b --tuning-search '{"search_type":"grid","parameter_search":{"t":[1,2]}}'`)
    expect(server).toContain('batch --commit abcdef1234 --batches-file batches.night.yaml a b')
    // the form selects one batch: an alias for both
    const prefill = formPrefill(spec, { yaml: 'a: {}\nb: {}\n', label: 'night-again', created_at: submission.created_at })
    expect(prefill.selected_group).toBe('night-again-batches')
    expect(prefill.batches_snapshot.files).toEqual([
      { path: 'batches.night.yaml', content: 'a: {}\nb: {}\n' },
      { path: 'run-again.yaml', content: '# The batches night ran, together\naliases:\n  "night-again-batches": ["a","b"]\n' },
    ])
    expect(prefill.parameter_search).toBe('{\n  "t": [1, 2]\n}')
    expect(prefill).toMatchObject({ experiment_name: 'night-again', platform: 'linux', overwrite: false, search_type: 'grid' })
  })

  it('runs automated tunings again from QA-Board', () => {
    const optimize = { ...submission, request: { selected_group: ['a'], tuning_search: { search_type: 'optimize', parameter_search: 'objective: {}' } } }
    const spec = runSpec({ kind: 'submission', submission: optimize }, { label: 'opt' })
    expect(terminalCommands(spec, { file: 'f.yaml', commit_id: 'abc', label: 'x' }).server).toBeNull()
    expect(formPrefill(spec, { yaml: 'a: {}', label: 'x' })).toMatchObject({ search_type: 'optimize', parameter_search_auto: 'objective: {}', selected_group: 'a' })
  })

  it('without a snapshot, gives what was typed', () => {
    const spec = runSpec({ kind: 'command', id: 'c', command: { argv: ['qa', 'batch', 'x'] } }, { label: 'l' })
    expect(spec.snapshot).toBeNull()
    expect(terminalCommands(spec, { file: 'f', commit_id: 'abc', label: 'l-again' })).toEqual({ local: 'qa batch x', server: null })
    const too_large = runSpec({ kind: 'command', id: 'c', command: { argv: ['qa'], batches_snapshot: { too_large: 300000, batches: ['x'] } } }, { label: 'l' })
    expect(too_large.snapshot).toBeNull()
    expect(too_large.snapshot_error).toMatch(/too large/)
  })
})
