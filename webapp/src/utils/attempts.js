// Runs that were done again (backend/attempts.py, qaboard/attempts.py). A run shows its latest attempt's results;
// the server remembers how the earlier attempts ended (data.previous_attempts), and `qa` keeps their logs next to the
// run's (data.attempt_logs: log.attempt1.txt...).

export const previousAttempts = output => (output?.data?.previous_attempts ?? []).filter(a => a && typeof a === 'object');

// Done again where it was (local runs, projects that opt out, older qa): its files were replaced at the same paths,
// so what viewers show may come from a cache, the browser's or the image server's.
export const doneAgainInPlace = output => previousAttempts(output).some(a => a.in_place);

export const attemptLogName = attempt => `log.attempt${attempt}.txt`;

// The logs of the earlier attempts kept in the run's folder, the latest first: [{attempt, name}]
export const attemptLogs = output => {
  const attempts = (output?.data?.attempt_logs ?? []).filter(a => Number.isInteger(a) && a > 0);
  return [...new Set(attempts)].sort((a, b) => b - a).map(attempt => ({ attempt, name: attemptLogName(attempt) }));
};

export const STALE_WARNING = "was done again in the same folder: what you see may come from a cache (your browser's or the image server's). Reload the page without its cache if it looks wrong.";
