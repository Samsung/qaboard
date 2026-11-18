/**
 * Tests comparing the batches two commands ran (batchesDiff.js, BatchesComparison.jsx).
 * Run with: cd webapp && npm test -- batchesDiff
 */
import { screen, fireEvent, waitFor } from '@testing-library/react';

import { renderWithProviders } from '../../../test-utils';
import { batchesChanges, changesSummary, snapshotBody, snapshotOptions } from '../batchesDiff';
import { BatchesComparison } from '../BatchesComparison';

vi.mock('../../MonacoEditor', () => ({
  MonacoDiffEditor: ({ original, value }) => <pre data-testid="diff">{original} ➡️ {value}</pre>,
}));


const header = '# The batches this command ran\n# Started: 2026-11-17T08:00:00Z\n#\n'
const snapshot = (body, started = '') => `${header.replace('2026-11-17T08:00:00Z', started || '2026-11-17T08:00:00Z')}${body}`
const command = (yaml, at) => ({ command_created_at_datetime: at, argv: ['qa', 'batch', 'ci'], user: 'ci', job_url: 'https://ci/1', batches_snapshot: { yaml, batches: [], names: ['ci'] } })

describe('batchesChanges', () => {
  it('ignores the header, the order of keys and comments', () => {
    expect(snapshotBody(snapshot('a: {}\n'))).toBe('a: {}\n')
    const changes = batchesChanges('# from x.yaml\na: {inputs: [1], configurations: [b]}\n', 'a: {configurations: [b], inputs: [1]}\n')
    expect(changes.same).toBe(true)
    expect(changesSummary(changes)).toBe('Same batches')
  })

  it('says which batches and aliases changed', () => {
    const changes = batchesChanges(
      'aliases: {all: [a, b]}\na: {inputs: [1]}\nb: {inputs: [2]}\n',
      'aliases: {all: [a, c]}\na: {inputs: [1, 3]}\nc: {inputs: [4]}\n',
    )
    expect(changes.batches).toEqual({ added: ['c'], removed: ['b'], changed: ['a'] })
    expect(changesSummary(changes)).toBe('a changed, c added, b removed, 1 alias changed')
    expect(changesSummary(batchesChanges('a: [', 'a: {}'))).toMatch(/^Could not compare/)
  })

  it('lists the commands with snapshots', () => {
    const batch = { id: 1, label: 'night', data: { commands: { c1: command('a: {}\n', '2026-11-10T08:00:00'), c2: { argv: ['qa'] } } } }
    const options = snapshotOptions(batch, 'This batch')
    expect(options.map(o => o.key)).toEqual(['1:c1'])
    expect(options[0].label).toMatch(/^This batch: night · CI by ci/)
  })
})

describe('BatchesComparison', () => {
  const batch = { id: 1, label: 'new', data: { commands: { c1: command(snapshot('a: {inputs: [1, 2]}\n'), '2026-11-17T08:00:00') } } }
  const ref_batch = { id: 2, label: 'ref', data: { commands: { c2: command(snapshot('a: {inputs: [1]}\n', '2026-11-10T08:00:00Z'), '2026-11-10T08:00:00') } } }

  it('compares with the reference batch, and shows the changes', async () => {
    renderWithProviders(<BatchesComparison batch={batch} ref_batch={ref_batch} />)
    expect(screen.getByText('a changed')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Show the changes'))
    // without the headers, which always differ
    await waitFor(() => expect(screen.getByTestId('diff')).toHaveTextContent('a: {inputs: [1]} ➡️ a: {inputs: [1, 2]}'))
  })

  it('says when the batches are the same, and shows nothing without two to compare', () => {
    const same = { ...ref_batch, data: { commands: { c2: command(snapshot('a: {inputs: [1, 2]}\n'), '2026-11-10T08:00:00') } } }
    renderWithProviders(<BatchesComparison batch={batch} ref_batch={same} />)
    expect(screen.getByText('Same batches')).toBeInTheDocument()
    expect(screen.queryByText('Show the changes')).toBeNull()
    const { container } = renderWithProviders(<BatchesComparison batch={batch} ref_batch={batch} />)
    expect(container).toBeEmptyDOMElement()
  })
})
