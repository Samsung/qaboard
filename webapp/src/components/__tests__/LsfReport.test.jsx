/**
 * Tests for the LSF job report summary shown with the logs.
 * Run with: cd webapp && npm test -- LsfReport
 */
import { render, screen } from '@testing-library/react';

import { LsfReport, LsfTag } from '../LsfReport';
import { parseLsfReport } from '../lsf';


const report = parseLsfReport(`Sender: LSF System <lsfadmin@host-a>
Subject: Job 1234[3]: <abcdefgh_xyz[1-5]%2> in cluster <cluster1> Exited

Job was executed on host(s) <host-a>, in queue <normal>, as user <alice> in cluster <cluster1> at Mon Oct  5 10:00:05 2026
TERM_MEMLIMIT: job killed after reaching LSF memory usage limit.
Exited with exit code 137.

Resource usage summary:

    Max Memory :                                 4000 MB
    Total Requested Memory :                     4096.00 MB
    Run time :                                   120 sec.
`)


describe('LsfReport', () => {
  it('explains why LSF killed the job', () => {
    render(<LsfReport report={report} />)
    expect(screen.getByText(/Exited with exit code 137 \(SIGKILL\) · TERM_MEMLIMIT/)).toBeInTheDocument()
    expect(screen.getByText(/Raise runners.lsf.max_memory/)).toBeInTheDocument()
    expect(screen.getByText('1234[3]')).toBeInTheDocument()
    expect(screen.getByText('host-a')).toBeInTheDocument()
    expect(screen.getByText('4000 MB / 4096.00 MB requested')).toBeInTheDocument()
  })

  it('renders nothing without a report', () => {
    const { container } = render(<><LsfReport report={null} /><LsfTag report={null} /></>)
    expect(container).toBeEmptyDOMElement()
  })

  it('tags failed jobs only', () => {
    render(<LsfTag report={report} />)
    expect(screen.getByText(/LSF: TERM_MEMLIMIT/)).toBeInTheDocument()
    const { container } = render(<LsfTag report={parseLsfReport('Successfully completed.\n')} />)
    expect(container).toBeEmptyDOMElement()
  })
})
