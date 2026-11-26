// Syntax highlighting of the short snippets the app shows to copy (Python, YAML, shell): a few regular expressions per
// language, not a parser. Monaco does it for the editors, but is too heavy to load for a snippet.
// highlight(code, language) => [{type, text}], whose texts joined are `code`. `type` null: plain text.

const python_keywords = [
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield',
];

// Each rule: [type, regular expression], tried in order where the previous token ended. Sticky ("y"), and "m" so that
// ^ matches at the start of each line.
const rule = (type, source) => [type, new RegExp(source, 'ym')];

const languages = {
  python: [
    rule('comment', '#.*'),
    rule('string', '[rbfuRBFU]{0,2}("""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\')'),
    rule('decorator', '@[\\w.]+'),
    rule('keyword', `\\b(?:${python_keywords.join('|')})\\b`),
    rule('constant', '\\b(?:None|True|False|self)\\b'),
    rule('number', '\\b\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?\\b'),
    rule('function', '\\b[A-Za-z_]\\w*(?=\\()'),
  ],
  yaml: [
    rule('comment', '(?:^|(?<=\\s))#.*'),
    // a key, maybe after a list's dash: "  - name:"
    rule('key', '(?<=^[ \\t]*(?:-[ \\t]+)?)(?!-\\s)[^\\s#:\'"\\[\\]{},][^\\n:#]*?(?=:(?:\\s|$))'),
    rule('string', '"(?:\\\\.|[^"\\\\\\n])*"|\'(?:[^\'\\n]|\'\')*\''),
    rule('constant', '\\b(?:true|false|null|yes|no|on|off)\\b(?![\\w.-])'),
    rule('number', '(?<![\\w.@/-])-?\\d+(?:\\.\\d+)?(?![\\w.@/-])'),
    rule('punctuation', '^[ \\t]*-(?=\\s)|[\\[\\]{},]'),
  ],
  shell: [
    rule('comment', '(?:^|(?<=\\s))#.*'),
    rule('string', '"(?:\\\\.|[^"\\\\])*"|\'[^\']*\''),
    rule('variable', '\\$\\{?\\w+\\}?'),
    // the command: the first word of a line, or after a pipe, && or ;
    rule('function', '(?<=(?:^|[|;&]|&&)[ \\t]*)(?!-)[\\w./-]+'),
    rule('flag', '(?<=\\s)--?[\\w-]+'),
    rule('punctuation', '\\||&&|;|>'),
  ],
};
languages.py = languages.python;
languages.yml = languages.yaml;
languages.bash = languages.sh = languages.shell;

export const highlight = (code, language) => {
  const rules = languages[language];
  const text = String(code ?? '');
  if (!rules) return [{ type: null, text }];
  const tokens = [];
  let plain = '';
  let i = 0;
  while (i < text.length) {
    let matched = null;
    for (const [type, regex] of rules) {
      regex.lastIndex = i;
      const match = regex.exec(text);
      if (match && match[0].length > 0) {
        matched = { type, text: match[0] };
        break;
      }
    }
    if (matched) {
      if (plain) tokens.push({ type: null, text: plain });
      plain = '';
      tokens.push(matched);
      i += matched.text.length;
    } else {
      // a whole word at once: rules with \b don't match inside it
      const word = /^\w+/.exec(text.slice(i, i + 64));
      const step = word ? word[0].length : 1;
      plain += text.slice(i, i + step);
      i += step;
    }
  }
  if (plain) tokens.push({ type: null, text: plain });
  return tokens;
};
