// Log lines as text: without colors, as a terminal shows them, and whether they are errors or warnings.
// The log viewer's parser, with colors, is in lineParser.js.

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
export const stripAnsi = text => text.replace(ANSI, '')


// What a terminal shows: progress bars (e.g. tqdm) rewrite the line with \r
export function terminalLine(line) {
  if (!line.includes('\r')) return line
  const parts = line.split('\r')
  for (let i = parts.length - 1; i >= 0; i--)
    if (parts[i]) return parts[i]
  return ''
}


const ERROR = new RegExp([
  /^Traceback \(most recent call last\)/,
  /^\s*[\w.]*(Error|Exception|Exit|Interrupt)(: |$)/,
  /\b(ERROR|CRITICAL|FATAL|FAILED)\b/,
  /\berror:/,
  /\[error\]/i,
  /Segmentation fault|core dumped|Bus error|Killed$/,
  /^Aborted!/,
  /^TERM_[A-Z_]+:/,
  /^Exited with (exit code|signal)/,
].map(r => r.source).join('|'))

const WARNING = /\b(WARNING|WARN)\b|\bwarning:|\w+Warning: |\[warn(ing)?\]/i

export function lineLevel(plain) {
  if (ERROR.test(plain)) return 'error'
  if (WARNING.test(plain)) return 'warning'
  return null
}

