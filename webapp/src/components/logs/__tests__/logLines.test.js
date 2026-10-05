/**
 * Tests for splitting logs in lines.
 * Run with: cd webapp && npm test -- logLines
 */
import { createLineParser, lineLevel, stripAnsi, terminalLine } from '../logLines';


describe('createLineParser', () => {
  it('splits lines and escapes HTML', () => {
    const lines = createLineParser()('a <b>\n&c\n')
    expect(lines.map(l => l.html)).toEqual(['a &lt;b&gt;', '&amp;c'])
    expect(lines.map(l => l.plain)).toEqual(['a <b>', '&c'])
  })

  it('keeps colors across lines, without painting reset text white', () => {
    const lines = createLineParser()('\x1b[31mred\nstill red\x1b[0m\nnormal\x1b[39m\n')
    expect(lines[0].html).toMatch(/<span style="color:#[0-9A-Fa-f]{6}">red<\/span>/)
    expect(lines[1].html).toMatch(/^<span style="color:#[0-9A-Fa-f]{6}">still red/)
    expect(lines[2].html).not.toMatch(/#FFF/i)
    expect(lines[1].plain).toBe('still red')
  })

  it('parses only what was added', () => {
    const parse = createLineParser()
    const first = parse('one\ntw')
    expect(first.map(l => l.plain)).toEqual(['one', 'tw'])
    const second = parse('one\ntwo\nthree\n')
    expect(second.map(l => l.plain)).toEqual(['one', 'two', 'three'])
    // the complete lines are reused
    expect(second[0]).toBe(first[0])
  })

  it('starts over when the text changes', () => {
    const parse = createLineParser()
    parse('one\ntwo\n')
    expect(parse('other\n').map(l => l.plain)).toEqual(['other'])
    expect(parse('')).toEqual([])
  })

  it('shows progress bars like a terminal', () => {
    const lines = createLineParser()('10%|#  |\r50%|## |\r100%|###|\r\nwindows\r\n')
    expect(lines.map(l => l.plain)).toEqual(['100%|###|', 'windows'])
  })
})


describe('lineLevel', () => {
  it('finds errors', () => {
    for (const line of [
      'Traceback (most recent call last):',
      'ValueError: invalid literal',
      'subprocess.CalledProcessError: Command returned non-zero exit status 1.',
      'KeyboardInterrupt',
      '[ERROR] could not open file',
      '2026-10-05 10:00:00 ERROR something',
      'main.cpp:12:5: error: expected ;',
      'Segmentation fault (core dumped)',
      'Aborted!',
      'TERM_MEMLIMIT: job killed after reaching LSF memory usage limit.',
      'Exited with exit code 1.',
    ])
      expect([line, lineLevel(line)]).toEqual([line, 'error'])
  })

  it('finds warnings', () => {
    for (const line of ['WARNING: We are not sure', 'foo.py:1: DeprecationWarning: old', 'warning: unused variable'])
      expect([line, lineLevel(line)]).toEqual([line, 'warning'])
  })

  it('ignores normal lines', () => {
    for (const line of ['0 errors', 'Processing frame 1/100', 'error_rate=0.1', 'Successfully completed.', 'no_error: true'])
      expect([line, lineLevel(line)]).toEqual([line, null])
  })
})


it('stripAnsi and terminalLine', () => {
  expect(stripAnsi('\x1b[1;32mok\x1b[0m \x1b]8;;http://x\x07link\x1b]8;;\x07')).toBe('ok link')
  expect(terminalLine('a\rb')).toBe('b')
  expect(terminalLine('a\r')).toBe('a')
})
