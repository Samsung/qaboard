/**
 * The sidebar's "Logs" entry hints at failures and runs in progress.
 * Run with: cd webapp && npm test -- AppSiderLogsItem
 */
import { render, screen } from '@testing-library/react';

import { LogsMenuItem, logsHint } from '../AppSiderLogsItem';


describe('logsHint', () => {
  it('says nothing for a finished batch', () => {
    expect(logsHint(undefined)).toBeNull()
    expect(logsHint({ valid_outputs: 4, failed_outputs: 0, pending_outputs: 0, running_outputs: 0 })).toBeNull()
  })

  it('counts failed runs', () => {
    expect(logsHint({ failed_outputs: 3, pending_outputs: 2, running_outputs: 1 })).toMatchObject({
      intent: 'danger', tag: '3 failed', title: '3 runs failed: see why in the logs',
    })
    expect(logsHint({ failed_outputs: 1 }).title).toBe('1 run failed: see why in the logs')
  })

  it('knows when qa batch failed, from the latest submission', () => {
    const submissions = {
      a: { created_at: '2026-10-05T10:00:00Z', status: 'done' },
      b: { created_at: '2026-10-05T11:00:00Z', status: 'failed' },
    }
    expect(logsHint({ failed_outputs: 0, data: { submissions } })).toMatchObject({ intent: 'danger', tag: 'failed' })
    expect(logsHint({ failed_outputs: 2, data: { submissions } }).title).toBe('2 runs failed and qa batch failed: see why in the logs')
    // An older failure was fixed by a new submission
    submissions.c = { created_at: '2026-10-05T12:00:00Z', status: 'submitted' }
    expect(logsHint({ failed_outputs: 0, data: { submissions } })).toBeNull()
  })

  it('shows runs in progress', () => {
    // pending_outputs includes the running ones
    expect(logsHint({ pending_outputs: 3, running_outputs: 1 })).toMatchObject({ intent: 'none', tag: '1 running' })
    expect(logsHint({ pending_outputs: 3, running_outputs: 0 }).tag).toBe('3 pending')
    expect(logsHint({ data: { submissions: { a: { status: 'submitting' } } } }).tag).toBe('starting')
  })
})


describe('LogsMenuItem', () => {
  it('shows the failures on the Logs entry', () => {
    render(<LogsMenuItem batch={{ failed_outputs: 3, pending_outputs: 0, running_outputs: 0 }} />)
    expect(screen.getByText('3 failed').closest('.bp6-tag')).toHaveClass('bp6-intent-danger')
    expect(screen.getByRole('menuitem')).toHaveAttribute('title', '3 runs failed: see why in the logs')
    expect(screen.getByRole('menuitem')).toHaveTextContent('Logs')
  })

  it('stays plain when all is well', () => {
    render(<LogsMenuItem batch={{ failed_outputs: 0, pending_outputs: 0, running_outputs: 0 }} />)
    expect(screen.getByRole('menuitem')).toHaveTextContent(/^Logs$/)
    expect(screen.getByRole('menuitem')).not.toHaveAttribute('title')
  })
})
