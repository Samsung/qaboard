// Parses the job report LSF writes in the job's output file (bsub -o).
// With qaboard >= 2026-10, log.lsf.txt has the job's output, then LSF's report.
// Before, LSF wrote its report first, then the output.
//
// Sender: LSF System <lsfadmin@host-a>
// Subject: Job 1234[3]: <abcdefgh_xyz[1-5]%2> in cluster <cluster> Exited
//
// Job <abcdefgh_xyz[1-5]%2> was submitted from host <host-b> by user <user> in cluster <cluster> at Mon Oct  5 10:00:00 2026
// Job was executed on host(s) <host-a>, in queue <normal>, as user <user> in cluster <cluster> at Mon Oct  5 10:00:05 2026
// [...]
// TERM_MEMLIMIT: job killed after reaching LSF memory usage limit.
// Exited with exit code 137.
//
// Resource usage summary:
//
//     CPU time :                                   12.34 sec.
//     Max Memory :                                 4096 MB
// [...]
// The output (if any) follows:

const SIGNALS = {
  1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE', 9: 'SIGKILL',
  11: 'SIGSEGV', 12: 'SIGUSR2', 13: 'SIGPIPE', 15: 'SIGTERM', 24: 'SIGXCPU', 25: 'SIGXFSZ',
}

// What happened, and what to do about it
const TERM_HINTS = {
  TERM_MEMLIMIT: 'The run used more memory than it requested. Raise runners.lsf.max_memory in qaboard.yaml, or use --lsf-max-memory.',
  TERM_SWAP: 'The run reached its swap limit.',
  TERM_RUNLIMIT: "The run reached its run time limit. Use a queue with a longer limit, or ask for more time with -W in runners.lsf.options.",
  TERM_CPULIMIT: 'The run reached its CPU time limit.',
  TERM_PROCESSLIMIT: 'The run started more processes than allowed.',
  TERM_THREADLIMIT: 'The run started more threads than allowed.',
  TERM_OWNER: 'Killed by its owner (bkill), for instance when the batch was stopped from QA-Board.',
  TERM_FORCE_OWNER: 'Killed by its owner (bkill), for instance when the batch was stopped from QA-Board.',
  TERM_ADMIN: 'Killed by an LSF administrator.',
  TERM_FORCE_ADMIN: 'Killed by an LSF administrator.',
  TERM_PREEMPT: 'Preempted by a higher priority job.',
  TERM_REQUEUE_OWNER: 'Requeued by its owner.',
  TERM_REQUEUE_ADMIN: 'Requeued by an LSF administrator.',
  TERM_LOAD: "Killed because of the host's load.",
  TERM_WINDOW: "Killed because the queue's run window closed.",
  TERM_DEADLINE: 'Killed because it reached its deadline.',
  TERM_CWD_NOTEXIST: "The working directory doesn't exist on the host, check the shared filesystem.",
  TERM_ZOMBIE: 'LSF lost track of the job, maybe the host went down.',
  TERM_EXTERNAL_SIGNAL: 'Killed by a signal from outside LSF, for instance the kernel out-of-memory killer.',
  TERM_UNKNOWN: 'LSF does not know why the job was terminated. The host may have rebooted, or the kernel out-of-memory killer killed it.',
}

const SIGNAL_HINTS = {
  SIGKILL: 'Killed with SIGKILL, often by the kernel out-of-memory killer.',
  SIGSEGV: 'Segmentation fault: a crash in native code.',
  SIGABRT: 'Aborted: often a failed assertion, or an uncaught C++ exception.',
  SIGBUS: 'Bus error: often a crash in native code, or a file that was truncated while it was read.',
  SIGTERM: 'Terminated, often because LSF killed the job.',
  SIGINT: 'Interrupted, often because LSF killed the job.',
}

const REPORT_START = /^Sender: LSF System.*$/gm
const OUTPUT_FOLLOWS = /^The output \(if any\) follows:\s*$/m
const SEPARATOR = /^-{20,}\s*$/m


function lastMatchIndex(regexp, text) {
  let index = -1
  for (const match of text.matchAll(regexp))
    index = match.index
  return index
}


// Returns null if the text has no LSF job report
export function parseLsfReport(text) {
  if (!text)
    return null
  let report = text
  const start = lastMatchIndex(REPORT_START, text)
  if (start >= 0)
    report = report.slice(start)
  // The old format has the job's output after the report
  const output_follows = report.search(OUTPUT_FOLLOWS)
  if (output_follows >= 0)
    report = report.slice(0, output_follows)
  // The job's script can be long, and look like anything
  const script_start = report.indexOf('Your job looked like:')
  if (script_start >= 0) {
    const after_script = report.slice(script_start)
    const first = after_script.search(SEPARATOR)
    const rest = first >= 0 ? after_script.slice(first).replace(SEPARATOR, '') : ''
    const second = rest.search(SEPARATOR)
    report = report.slice(0, script_start) + (second >= 0 ? rest.slice(second).replace(SEPARATOR, '') : '')
  }

  const successful = /^Successfully completed\.\s*$/m.test(report)
  const exit_code_match = report.match(/^Exited with exit code (\d+)\.?\s*$/m)
  const signal_match = report.match(/^Exited with signal termination: (.*?)\.?\s*$/m)
  const has_resources = /^Resource usage summary:/m.test(report)
  if (start < 0 && !successful && !exit_code_match && !signal_match && !has_resources)
    return null

  const parsed = {
    successful,
    exited: !!exit_code_match || !!signal_match,
    exit_code: exit_code_match ? parseInt(exit_code_match[1], 10) : null,
    signal: null,
    signal_description: signal_match ? signal_match[1] : null,
    term_reason: null,
    term_message: null,
    job_id: null,
    job_name: null,
    cluster: null,
    user: null,
    submission_host: null,
    submitted_at: null,
    hosts: [],
    queue: null,
    started_at: null,
    terminated_at: null,
    resources: {},
  }

  const subject = report.match(/^Subject: Job (\d+(?:\[\d+\])?): <([^>]*)>(?: in cluster <([^>]*)>)? (Done|Exited)\s*$/m)
  if (subject) {
    parsed.job_id = subject[1]
    parsed.job_name = subject[2]
    parsed.cluster = subject[3] ?? null
    if (subject[4] === 'Exited')
      parsed.exited = true
  }
  const submitted = report.match(/^Job <.*> was submitted from host <([^>]*)> by user <([^>]*)>(?: in cluster <[^>]*>)? at (.*?)\.?\s*$/m)
  if (submitted) {
    parsed.submission_host = submitted[1]
    parsed.user = submitted[2]
    parsed.submitted_at = submitted[3]
  }
  // The hosts can span multiple lines: <4*host-a> <host-b>
  const executed = report.match(/^Job was executed on host\(s\) ([\s\S]*?), in queue <([^>]*)>/m)
  if (executed) {
    parsed.hosts = [...executed[1].matchAll(/<([^>]*)>/g)].map(m => m[1])
    parsed.queue = executed[2]
  }
  parsed.started_at = report.match(/^Started at (.*?)\s*$/m)?.[1] ?? null
  parsed.terminated_at = report.match(/^Terminated at (.*?)\s*$/m)?.[1] ?? null

  const term = report.match(/^(TERM_[A-Z_]+): (.*?)\s*$/m)
  if (term) {
    parsed.term_reason = term[1]
    parsed.term_message = term[2]
  }
  if (parsed.exit_code !== null && parsed.exit_code > 128)
    parsed.signal = SIGNALS[parsed.exit_code - 128] ?? `signal ${parsed.exit_code - 128}`

  const resources = report.split(/^Resource usage summary:\s*$/m)[1] ?? ''
  for (const match of resources.matchAll(/^\s+([A-Za-z][A-Za-z ]*?)\s*:\s+(.*?)\s*$/gm)) {
    const value = match[2].replace(/\.$/, '')
    if (value !== '-')
      parsed.resources[match[1]] = value
  }
  return parsed
}


// A one-line summary, e.g. "Exited with exit code 137 (SIGKILL)"
export function lsfHeadline(report) {
  if (report.successful)
    return 'Successfully completed'
  if (report.exit_code !== null)
    return `Exited with exit code ${report.exit_code}${report.signal ? ` (${report.signal})` : ''}`
  if (report.signal_description)
    return `Exited with signal termination: ${report.signal_description}`
  if (report.exited)
    return 'Exited'
  return 'No exit status'
}


// Explains why the job failed, when we know
export function lsfHint(report) {
  if (report.term_reason && TERM_HINTS[report.term_reason])
    return TERM_HINTS[report.term_reason]
  if (report.signal && SIGNAL_HINTS[report.signal])
    return SIGNAL_HINTS[report.signal]
  return null
}


function megabytes(value) {
  const match = (value ?? '').match(/^([\d.]+)\s*(KB|MB|GB|TB)/i)
  if (!match)
    return null
  const factor = { KB: 1 / 1024, MB: 1, GB: 1024, TB: 1024 * 1024 }[match[2].toUpperCase()]
  return parseFloat(match[1]) * factor
}

// True if the job used (almost) all the memory it asked for
export function lsfNearMemoryLimit(report) {
  const max = megabytes(report.resources['Max Memory'])
  const requested = megabytes(report.resources['Total Requested Memory'])
  return max !== null && !!requested && max >= 0.9 * requested
}


// Fetches log.lsf.txt and parses its report.
// The report is at the end of the file (or at the start, before 2026-10), and the logs can be large,
// so we read only the end, and then the start, of the file.
export async function fetchLsfReport(get, url, chunk_size = 64 * 1024) {
  const options = range => ({
    headers: { Range: range },
    responseType: 'text',
    transformResponse: [data => data],
  })
  const tail = await get(url, options(`bytes=-${chunk_size}`))
  const report = parseLsfReport(tail.data)
  if (report || tail.status !== 206)
    return report
  const total = parseInt((tail.headers?.['content-range'] ?? '').split('/')[1], 10)
  if (!(total > chunk_size))
    return null
  const head = await get(url, options(`bytes=0-${chunk_size - 1}`))
  return parseLsfReport(head.data)
}
