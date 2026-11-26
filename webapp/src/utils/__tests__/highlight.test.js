import { describe, expect, it } from 'vitest';

import { highlight } from '../highlight';
import { python_snippet as collection_python, yaml_snippet } from '../../inputs/api';
import { python_snippet, shell_snippet } from '../../plugins/ScriptPlugin';

const of = (tokens, type) => tokens.filter(t => t.type === type).map(t => t.text);
const joined = tokens => tokens.map(t => t.text).join('');

describe('highlight', () => {
  it('keeps the text', () => {
    for (const [code, language] of [
      [collection_python('night/hard-cases@1'), 'python'],
      [python_snippet('https://qa/p/commit/abc?batch=x', ['qaboard']), 'python'],
      [yaml_snippet('night/hard-cases@1', 'night/hard-cases'), 'yaml'],
      [shell_snippet('https://qa/p/commit/abc'), 'shell'],
      ['plain', 'cobol'],
      ['', 'python'],
    ]) expect(joined(highlight(code, language))).toBe(code);
  });

  it('Python: keywords, strings, comments, calls', () => {
    const tokens = highlight(collection_python('night/hard-cases@1'), 'python');
    expect(of(tokens, 'keyword')).toEqual(['from', 'import', 'for', 'in']);
    expect(of(tokens, 'string')).toEqual(['"night/hard-cases@1"']);
    expect(of(tokens, 'comment')).toEqual(['# item.database / item.path']);
    expect(of(tokens, 'function')).toEqual(['get', 'print', 'len', 'print']);
    expect(of(highlight('x = f"{a}" if b else None  # 1', 'python'), 'string')).toEqual(['f"{a}"']);
    expect(of(highlight('value_1 = 2.5', 'python'), 'number')).toEqual(['2.5']);
  });

  it('YAML: keys, list items, flow lists', () => {
    const tokens = highlight(yaml_snippet('night/hard-cases@1', 'night/hard-cases'), 'yaml');
    expect(of(tokens, 'key')).toEqual(['hard-cases', 'configurations', 'collections']);
    expect(of(tokens, 'punctuation')).toEqual(['[', ']', '    -']);
    expect(of(tokens, 'number')).toEqual([]);
    expect(of(highlight('a: 1 # why\nb: "x: y"\n- c: true', 'yaml'), 'key')).toEqual(['a', 'b', 'c']);
    expect(of(highlight('a: 1 # why\nb: "x: y"\n- c: true', 'yaml'), 'comment')).toEqual(['# why']);
  });

  it('shell: commands, flags, strings, variables', () => {
    const tokens = highlight('echo "$QABOARD_TOKEN" | qa auth login --with-token\nexport A=$B', 'shell');
    expect(of(tokens, 'function')).toEqual(['echo', 'qa', 'export']);
    expect(of(tokens, 'flag')).toEqual(['--with-token']);
    expect(of(tokens, 'string')).toEqual(['"$QABOARD_TOKEN"']);
    expect(of(tokens, 'variable')).toEqual(['$B']);
  });
});
