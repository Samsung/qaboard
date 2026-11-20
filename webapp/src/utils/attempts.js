// Runs that were done again (backend/attempts.py, qaboard/attempts.py). A run shows its latest attempt's results;
// the server remembers how the earlier attempts ended (data.previous_attempts), and `qa` keeps their logs next to the
// run's (data.attempt_logs: log.attempt1.txt..., and data.attempt_log_files with their runners' logs: log.attempt1.lsf.txt...).

export const previousAttempts = output => (output?.data?.previous_attempts ?? []).filter(a => a && typeof a === 'object');

// Done again where it was (local runs, projects that opt out, older qa): its files were replaced at the same paths,
// so what viewers show may come from a cache, the browser's or the image server's.
export const doneAgainInPlace = output => previousAttempts(output).some(a => a.in_place);

export const attemptLogName = attempt => `log.attempt${attempt}.txt`;

// log.attempt2.txt, and the logs of its runner: log.attempt2.lsf.txt... (qaboard/attempts.py)
const ATTEMPT_LOG = /^log\.attempt([1-9][0-9]*)(?:\.([a-z0-9]+))?\.txt$/;

// The logs of the earlier attempts kept in the run's folder, the latest first, each attempt's log.txt before its
// runner's: [{attempt, name}]. `qa` lists them in data.attempt_log_files; older versions only kept log.txt (attempt_logs)
export const attemptLogs = output => {
  const files = Array.isArray(output?.data?.attempt_log_files) ? output.data.attempt_log_files : [];
  const attempts = Array.isArray(output?.data?.attempt_logs) ? output.data.attempt_logs : [];
  // both: a server may have the list of an older `qa`, without the runners' logs
  const logs = [
    ...files.flatMap(name => {
      const match = typeof name === 'string' && name.match(ATTEMPT_LOG);
      return match ? [{ attempt: Number(match[1]), runner: match[2] ?? '', name }] : [];
    }),
    ...attempts.filter(a => Number.isInteger(a) && a > 0).map(attempt => ({ attempt, runner: '', name: attemptLogName(attempt) })),
  ];
  const unique = [...new Map(logs.map(log => [log.name, log])).values()];
  return unique
    .sort((a, b) => b.attempt - a.attempt || (a.runner === '' ? -1 : b.runner === '' ? 1 : a.runner.localeCompare(b.runner)))
    .map(({ attempt, name }) => ({ attempt, name }));
};

export const STALE_WARNING = "was done again in the same folder: what you see may come from a cache (your browser's or the image server's). Reload the page without its cache if it looks wrong.";
