/**
 * Tests for parsing LSF job reports in log.lsf.txt
 * Run with: cd webapp && npm test -- lsf
 */
import { parseLsfReport, lsfHeadline, lsfHint, lsfNearMemoryLimit, fetchLsfReport } from '../lsf';


const script = `------------------------------------------------------------
# LSBATCH: User input
export LC_ALL=en_US.utf8 LANG=en_US.utf8 MPLBACKEND=agg
case "$LSB_JOBINDEX" in
1)
  echo "Exited with exit code 0."
  ;;
esac
------------------------------------------------------------`

const memlimit_report = `Sender: LSF System <lsfadmin@host-a>
Subject: Job 1234[3]: <abcdefgh_xyz[1-5]%2> in cluster <cluster1> Exited

Job <abcdefgh_xyz[1-5]%2> was submitted from host <host-b> by user <alice> in cluster <cluster1> at Mon Oct  5 10:00:00 2026
Job was executed on host(s) <4*host-a>, in queue <normal>, as user <alice> in cluster <cluster1> at Mon Oct  5 10:00:05 2026
</home/alice> was used as the home directory.
</proj/work> was used as the working directory.
Started at Mon Oct  5 10:00:05 2026
Terminated at Mon Oct  5 10:02:05 2026
Results reported at Mon Oct  5 10:02:05 2026

Your job looked like:

${script}

TERM_MEMLIMIT: job killed after reaching LSF memory usage limit.
Exited with exit code 137.

Resource usage summary:

    CPU time :                                   12.34 sec.
    Max Memory :                                 4096 MB
    Average Memory :                             2000.00 MB
    Total Requested Memory :                     4096.00 MB
    Delta Memory :                               0.00 MB
    Max Swap :                                   -
    Max Processes :                              5
    Max Threads :                                9
    Run time :                                   120 sec.
    Turnaround time :                            125 sec.

The output (if any) follows:


`


describe('parseLsfReport', () => {
  it('returns null without a report', () => {
    expect(parseLsfReport('')).toBeNull()
    expect(parseLsfReport(null)).toBeNull()
    expect(parseLsfReport('Outputs: /some/dir\nTraceback (most recent call last):\n')).toBeNull()
  })

  it('parses a report appended after the output', () => {
    const report = parseLsfReport(`Outputs: /some/dir\nloading...\nKilled\n${memlimit_report}`)
    expect(report).toMatchObject({
      successful: false,
      exited: true,
      exit_code: 137,
      signal: 'SIGKILL',
      term_reason: 'TERM_MEMLIMIT',
      term_message: 'job killed after reaching LSF memory usage limit.',
      job_id: '1234[3]',
      job_name: 'abcdefgh_xyz[1-5]%2',
      cluster: 'cluster1',
      user: 'alice',
      submission_host: 'host-b',
      submitted_at: 'Mon Oct  5 10:00:00 2026',
      hosts: ['4*host-a'],
      queue: 'normal',
      started_at: 'Mon Oct  5 10:00:05 2026',
      terminated_at: 'Mon Oct  5 10:02:05 2026',
    })
    expect(report.resources).toEqual({
      'CPU time': '12.34 sec',
      'Max Memory': '4096 MB',
      'Average Memory': '2000.00 MB',
      'Total Requested Memory': '4096.00 MB',
      'Delta Memory': '0.00 MB',
      'Max Processes': '5',
      'Max Threads': '9',
      'Run time': '120 sec',
      'Turnaround time': '125 sec',
    })
    expect(lsfHeadline(report)).toBe('Exited with exit code 137 (SIGKILL)')
    expect(lsfHint(report)).toMatch(/max_memory/)
    expect(lsfNearMemoryLimit(report)).toBe(true)
  })

  it('parses the old format, with the report before the output', () => {
    const text = `Sender: LSF System <lsfadmin@host-a>
Subject: Job 42: <abcdefgh_xyz> in cluster <cluster1> Done

Job <abcdefgh_xyz> was submitted from host <host-b> by user <alice> in cluster <cluster1> at Mon Oct  5 10:00:00 2026
Job was executed on host(s) <host-a>, in queue <normal>, as user <alice> in cluster <cluster1> at Mon Oct  5 10:00:05 2026
Started at Mon Oct  5 10:00:05 2026
Terminated at Mon Oct  5 10:00:10 2026

Your job looked like:

${script}

Successfully completed.

Resource usage summary:

    CPU time :                                   1.00 sec.
    Max Memory :                                 10 MB
    Total Requested Memory :                     -

The output (if any) follows:

TERM_RUNLIMIT: this is the job's output, not LSF's
Exited with exit code 3.
`
    const report = parseLsfReport(text)
    expect(report.successful).toBe(true)
    expect(report.exited).toBe(false)
    expect(report.exit_code).toBeNull()
    expect(report.term_reason).toBeNull()
    expect(report.job_id).toBe('42')
    expect(report.hosts).toEqual(['host-a'])
    expect(report.resources).toEqual({ 'CPU time': '1.00 sec', 'Max Memory': '10 MB' })
    expect(lsfHeadline(report)).toBe('Successfully completed')
    expect(lsfHint(report)).toBeNull()
    expect(lsfNearMemoryLimit(report)).toBe(false)
  })

  it('parses a report cut in the middle of the script', () => {
    const report = parseLsfReport(memlimit_report.slice(memlimit_report.indexOf('case')))
    expect(report.exit_code).toBe(137)
    expect(report.term_reason).toBe('TERM_MEMLIMIT')
    expect(report.job_id).toBeNull()
  })

  it('parses multiple hosts and signals', () => {
    const report = parseLsfReport(`Sender: LSF System <lsfadmin@host-a>
Subject: Job 7: <name> Exited

Job was executed on host(s) <2*host-a>
                            <host-b>, in queue <long>, as user <alice> at Mon Oct  5 10:00:05 2026
Exited with exit code 139.
`)
    expect(report.hosts).toEqual(['2*host-a', 'host-b'])
    expect(report.queue).toBe('long')
    expect(report.cluster).toBeNull()
    expect(lsfHeadline(report)).toBe('Exited with exit code 139 (SIGSEGV)')
    expect(lsfHint(report)).toMatch(/Segmentation fault/)
  })

  it('uses the last report', () => {
    const report = parseLsfReport(`Sender: LSF System <a>\nExited with exit code 1.\nSender: LSF System <a>\nSuccessfully completed.\n`)
    expect(report.successful).toBe(true)
    expect(report.exit_code).toBeNull()
  })
})


describe('fetchLsfReport', () => {
  it('reads the end of the file', async () => {
    const get = vi.fn().mockResolvedValue({ status: 206, data: memlimit_report, headers: { 'content-range': 'bytes 0-10/100000' } })
    const report = await fetchLsfReport(get, '/s/log.lsf.txt')
    expect(report.exit_code).toBe(137)
    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0][1].headers.Range).toBe('bytes=-65536')
  })

  it('reads the start of large files when the report is not at the end', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ status: 206, data: 'lots of output', headers: { 'content-range': 'bytes 34464-99999/100000' } })
      .mockResolvedValueOnce({ status: 206, data: memlimit_report, headers: { 'content-range': 'bytes 0-65535/100000' } })
    const report = await fetchLsfReport(get, '/s/log.lsf.txt')
    expect(report.term_reason).toBe('TERM_MEMLIMIT')
    expect(get.mock.calls[1][1].headers.Range).toBe('bytes=0-65535')
  })

  it('does not read twice small files, or when the server ignores ranges', async () => {
    for (const response of [
      { status: 206, data: 'output', headers: { 'content-range': 'bytes 0-5/6' } },
      { status: 200, data: 'output', headers: {} },
    ]) {
      const get = vi.fn().mockResolvedValue(response)
      expect(await fetchLsfReport(get, '/s/log.lsf.txt')).toBeNull()
      expect(get).toHaveBeenCalledTimes(1)
    }
  })
})
