import { Colors } from '@blueprintjs/core'
import Convert from 'ansi-to-html'


// Terminal colors that are readable on light and dark backgrounds
const ANSI_COLORS = {
  0: Colors.DARK_GRAY5, 1: Colors.RED3, 2: Colors.GREEN3, 3: Colors.GOLD3,
  4: Colors.BLUE3, 5: Colors.VIOLET3, 6: Colors.TURQUOISE3, 7: Colors.GRAY3,
  8: Colors.GRAY1, 9: Colors.RED4, 10: Colors.GREEN4, 11: Colors.ORANGE3,
  12: Colors.BLUE4, 13: Colors.VIOLET4, 14: Colors.TURQUOISE4, 15: Colors.GRAY4,
}

const newConverter = stream => new Convert({
  // "reset" codes should not paint text white on white
  fg: 'inherit',
  bg: 'transparent',
  colors: ANSI_COLORS,
  escapeXML: true,
  // keeps colors across lines
  stream,
})


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


const parseLine = (raw, converter) => {
  const line = terminalLine(raw)
  const plain = stripAnsi(line)
  return { html: converter.toHtml(line), plain, level: lineLevel(plain) }
}


/**
 * Splits logs in lines, converts ANSI colors to (escaped) HTML, and finds errors and warnings.
 * Logs grow while runs are running: if the new text starts with the previous text,
 * we only parse what was added.
 *
 * const parse = createLineParser()
 * parse("hello\nwor")  // [{html: 'hello', plain: 'hello', level: null}, {html: 'wor', ...}]
 * parse("hello\nworld\n")
 */
export function createLineParser() {
  let text = ''
  // complete lines (the text ended with a \n)
  let lines = []
  let converter = newConverter(true)
  let complete_length = 0 // length of the text in complete lines

  return function parse(next) {
    if (!next.startsWith(text)) {
      lines = []
      converter = newConverter(true)
      complete_length = 0
    }
    text = next
    const pending = next.slice(complete_length)
    const last_newline = pending.lastIndexOf('\n')
    if (last_newline >= 0) {
      const new_lines = pending.slice(0, last_newline).split('\n').map(raw => parseLine(raw, converter))
      lines = lines.concat(new_lines)
      complete_length += last_newline + 1
    }
    const partial = next.slice(complete_length)
    // The last line is not over, we parse it without updating the colors' state
    return partial ? [...lines, parseLine(partial, newConverter(false))] : lines
  }
}
