// The names of exported files: a template like "{input}__{settings}__{file}__{side}" filled with each run's fields,
// and each file's path in its run's folder.
// A port of qaboard/export_names.py: the server renders the same names when it exports. Both are tested against
// tests/fixtures/export-names.json: change one, change the other.
// - A field's slashes (e.g. the input's folders) become `separator`, or stay folders if it's "/".
//   The template's own slashes are always folders: "{side}/{input}" gives a folder per side.
// - An empty field takes the separator next to it along: "{input}__{settings}__{file}" gives "a__out" without settings.
// - The file's extension always ends the name: templates don't write it.
// - Spaces become "_". With `windows` (the default), names are ones Windows can open: characters it doesn't allow
//   become "-", names don't end with dots or spaces, and reserved names (CON, NUL, COM1...) get a "_" first. The server
//   also checks paths' lengths, and compares names regardless of case.

export const FIELDS = ['side', 'input', 'input_name', 'settings', 'file', 'platform', 'commit', 'batch', 'run'];
export const SEPARATORS = ['/', '_', '__', '-', '.', '+'];
export const MAX_NAME_BYTES = 200;

export class ExportNameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExportNameError';
  }
}

const field_pattern = /\{([^{}]*)\}/g;
// eslint-disable-next-line no-control-regex
const forbidden_windows = /[<>:"|?*\x00-\x1f]/g;
// eslint-disable-next-line no-control-regex
const forbidden = /[\x00-\x1f]/g;
const reserved_windows = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\.|$)/i;
const spaces = /\s+/g;
const extension_pattern = /^\.[A-Za-z0-9]{1,8}$/;
// compressed files keep both extensions: "out.tar.gz"
const compressed = ['.gz', '.bz2', '.xz', '.zst', '.zip', '.7z'];

// [{kind: "literal" | "field", text}]
export const parse_template = template => {
  const parts = [];
  let position = 0;
  for (const match of template.matchAll(field_pattern)) {
    if (match.index > position) parts.push({ kind: 'literal', text: template.slice(position, match.index) });
    const name = match[1].trim();
    if (!FIELDS.includes(name))
      throw new ExportNameError(`Unknown field {${name}}: use ${FIELDS.map(f => `{${f}}`).join(', ')}`);
    parts.push({ kind: 'field', text: name });
    position = match.index + match[0].length;
  }
  if (position < template.length) parts.push({ kind: 'literal', text: template.slice(position) });
  if (parts.some(p => p.kind === 'literal' && (p.text.includes('{') || p.text.includes('}'))))
    throw new ExportNameError('Braces go around field names, like {input}');
  if (!parts.some(p => p.kind === 'field'))
    throw new ExportNameError('The template needs fields, like {input} and {file}');
  return parts;
};

// ["debug/out", ".png"] for "debug/out.png". Only short extensions: "scene.v2.1" or ".bashrc" have none.
export const split_extension = path => {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  if (dot <= slash + 1) return [path, ''];
  const extension = path.slice(dot);
  if (!extension_pattern.test(extension)) return [path, ''];
  if (compressed.includes(extension.toLowerCase())) {
    const [stem, inner] = split_extension(path.slice(0, dot));
    if (inner && !compressed.includes(inner.toLowerCase())) return [stem, inner + extension];
  }
  return [path.slice(0, dot), extension];
};

// {input}: the input's path without its extension, {input_name}: only its name
export const input_fields = test_input_path => {
  const path = String(test_input_path ?? '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  const [stem] = split_extension(path);
  return { input: stem, input_name: stem.split('/').pop() };
};

const clean = (text, keep_slashes, separator = '_', windows = true) => {
  text = String(text).replaceAll('\\', '/').replace(/\s*\/\s*/g, '/');
  if (!keep_slashes) text = text.replace(/^\/+|\/+$/g, '').replaceAll('/', separator);
  return text.replace(windows ? forbidden_windows : forbidden, '-').replace(spaces, '_');
};

const utf8_length = text => new TextEncoder().encode(text).length;

// The relative path of a file, e.g. "img01__gain=4__out__new.png". Throws ExportNameError
export const render = (template, fields, separator = '_', extension = '', windows = true) => {
  if (!SEPARATORS.includes(separator)) throw new ExportNameError(`Unknown separator "${separator}"`);
  const parts = parse_template(template);
  const texts = parts.map(({ kind, text }) => {
    if (kind === 'literal') return clean(text, true, '_', windows);
    const value = fields[text];
    return value === undefined || value === null || value === '' ? '' : clean(value, separator === '/', separator, windows);
  });
  // an empty field takes the separator before it along, else the one after it (not folders)
  const dropped = new Set();
  parts.forEach(({ kind }, index) => {
    if (kind !== 'field' || texts[index]) return;
    for (const neighbor of [index - 1, index + 1]) {
      if (neighbor >= 0 && neighbor < parts.length && parts[neighbor].kind === 'literal' && !dropped.has(neighbor) && !texts[neighbor].includes('/')) {
        dropped.add(neighbor);
        break;
      }
    }
  });
  const path = texts.filter((_, index) => !dropped.has(index)).join('');
  const segments = [];
  for (let segment of path.split('/')) {
    if (segment === '.' || segment === '..') throw new ExportNameError(`"${segment}" can't be a file or folder name`);
    // Windows ignores trailing dots and spaces
    if (windows) segment = segment.replace(/[. ]+$/, '');
    if (segment) segments.push(segment);
  }
  if (segments.length === 0) throw new ExportNameError('The name is empty: add fields like {input} and {file}');
  segments[segments.length - 1] += clean(extension, false, '_', windows);
  if (windows) segments.forEach((segment, index) => { if (reserved_windows.test(segment)) segments[index] = `_${segment}`; });
  for (const segment of segments) {
    const bytes = utf8_length(segment);
    if (bytes > MAX_NAME_BYTES) throw new ExportNameError(`Name too long (${bytes} bytes, at most ${MAX_NAME_BYTES}): ${segment.slice(0, 60)}…`);
  }
  return segments.join('/');
};

// The name of a file of a run: `file` is its path in the run's folder
export const file_name = (template, fields, file, separator = '_', windows = true) => {
  const [stem, extension] = split_extension(String(file).replaceAll('\\', '/'));
  return render(template, { ...fields, file: stem }, separator, extension, windows);
};
