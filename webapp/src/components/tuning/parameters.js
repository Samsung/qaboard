// "Choose the values" of Run Tests / Tuning: the table over the text that says which values to try.
// The text stays the source of truth, as JSON: {"param": [values]} for every combination of the values, or a list of
// such sets when values go together. The table edits what it can show; functions stay text.

const is_object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const wrap = value => Array.isArray(value) ? value : [value];

const run_function = text => {
  try {
    return Function(text)();
  } catch {
    return undefined;
  }
};

/**
 * Reads the text as sets of parameters, for the table: {sets: [[{name, values}]]}.
 * When the table can't show it: {sets: null, reason: 'function' | 'invalid'}.
 */
export const parse_sets = text => {
  if (!text || !text.trim()) return { sets: [[]] };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const result = run_function(text);
    return { sets: null, reason: is_object(result) || Array.isArray(result) ? 'function' : 'invalid' };
  }
  const sets = Array.isArray(parsed) ? parsed : [parsed];
  if (!sets.every(is_object)) return { sets: null, reason: 'invalid' };
  if (sets.length === 0) return { sets: [[]] };
  return { sets: sets.map(set => Object.entries(set).map(([name, values]) => ({ name, values: wrap(values) }))) };
};

// The rows that say something: a name and values to try
const complete = rows => rows.filter(row => row.name.trim() && row.values.length > 0);

// JSON on one line, spaced like people write it: [[0, 1], {"a": 1}]
export const compact_json = value => {
  if (Array.isArray(value)) return `[${value.map(compact_json).join(', ')}]`;
  if (is_object(value)) return `{${Object.entries(value).map(([key, v]) => `${JSON.stringify(key)}: ${compact_json(v)}`).join(', ')}}`;
  return JSON.stringify(value) ?? 'null';
};

const format_row = row => `${JSON.stringify(row.name.trim())}: ${compact_json(row.values)}`;
const format_set = (rows, indent) => rows.length === 0
  ? '{}'
  : `{\n${rows.map(row => `${indent}  ${format_row(row)}`).join(',\n')}\n${indent}}`;

/** The text for the table's sets: one line per parameter. Rows without a name or values are left out. */
export const serialize_sets = sets => {
  const filled = sets.map(complete).filter(rows => rows.length > 0);
  if (filled.length === 0) return '';
  if (filled.length === 1) return format_set(filled[0], '');
  return `[\n${filled.map(rows => `  ${format_set(rows, '  ')}`).join(',\n')}\n]`;
};

/** The text for parameters: {name: values} or a list of them */
export const format_parameters = parameters => {
  if (parameters === null || parameters === undefined) return '';
  const sets = (Array.isArray(parameters) ? parameters : [parameters]).filter(is_object);
  return serialize_sets(sets.map(set => Object.entries(set).map(([name, values]) => ({ name, values: wrap(values) }))));
};

/** How many combinations a set's rows give: 1 without parameters */
export const set_combinations = rows => complete(rows).reduce((total, row) => total * row.values.length, 1);

const number_pattern = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

/** What users type for a value: numbers, true/false, and JSON for lists (a matrix: [[0, 1], [1, 0]]) stay what they are */
export const parse_value = text => {
  const trimmed = text.trim();
  if (number_pattern.test(trimmed)) return Number(trimmed);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^[[{"]/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // registers are often pasted as [1 2 3]
      if (/^\[[^[\]{}",]*\]$/.test(trimmed)) {
        const items = trimmed.slice(1, -1).trim().split(/\s+/).filter(Boolean);
        if (items.length > 0 && items.every(item => number_pattern.test(item))) return items.map(Number);
      }
      return trimmed;
    }
  }
  return trimmed;
};

/** How a value shows in the table: text as it is, unless it would read as something else ("1", "true") */
export const format_value = value => {
  if (typeof value !== 'string') return compact_json(value);
  const parts = split_values(value);
  return parse_value(value) !== value || parts.length !== 1 || parts[0] !== value ? JSON.stringify(value) : value;
};

/** "1, 2, [3, 4], a b" => ["1", "2", "[3, 4]", "a b"]: commas and new lines separate values, except inside lists and quotes */
export const split_values = text => {
  const parts = [];
  let current = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      current += char;
      if (char === '\\') current += text[++i] ?? '';
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    if (char === '[' || char === '{') depth++;
    if (char === ']' || char === '}') depth = Math.max(0, depth - 1);
    if (depth === 0 && (char === ',' || char === '\n' || char === '\r' || char === ';')) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map(part => part.trim()).filter(Boolean);
};

// 0.1 + 0.2 => 0.3
const tidy = number => Number(number.toPrecision(10));

/**
 * Evenly spaced values, ends included: {from, to, count, scale: 'linear' | 'log', integer}.
 * Returns {values} or {error}. A log scale spaces them evenly across orders of magnitude.
 */
export const range_values = ({ from, to, count, scale = 'linear', integer = false }) => {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { error: 'Give the first and last values.' };
  if (!Number.isInteger(count) || count < 2) return { error: 'At least 2 values.' };
  if (count > 1000) return { error: 'At most 1000 values.' };
  if (from === to) return { error: 'The first and last values are the same.' };
  if (scale === 'log' && (from <= 0 || to <= 0)) return { error: 'A log scale needs values above 0.' };
  const values = Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1);
    const value = scale === 'log' ? Math.exp(Math.log(from) + t * (Math.log(to) - Math.log(from))) : from + t * (to - from);
    return integer ? Math.round(value) : tidy(value);
  });
  // rounding can repeat values
  return { values: [...new Set(values)] };
};


// ---- Registers pasted from CDE ------------------------------------------------------------------------------------

const parseMatrixToJSON = (matrixStr) => {
  // Remove outer brackets and split by lines/rows
  const content = matrixStr.substring(1, matrixStr.length - 1).trim();
  const rows = content.split(/\s*\n\s*/).map(row => row.trim()).filter(row => row.length > 0);
  const row_values = row => row.split(/\s+/).map(val => {
    const num = parseFloat(val);
    return isNaN(num) ? `"${val}"` : num;
  });
  // a single row is a matrix with one row, for consistency
  return `[${rows.map(row => `[${row_values(row).join(', ')}]`).join(', ')}]`;
};

const is_not_entry = line => !line.trim() || line.trim().startsWith('//') || line.trim().startsWith('#') || !line.includes('=');

/**
 * Converts registers in the CDE format to QA-Board's: the sim|, hal| and def| prefixes go, `=X` becomes `: [X]`.
 *   block.hal|b="text"                       => "block.b": ["text"],
 *   block.def|a=5                            => "block.a": [5]
 *   CMixer_Gains_0.hal|channels_gain=[1 2
 *                                     0 0 ]  => "CMixer_Gains_0.channels_gain": [[[1, 2], [0, 0]]]
 */
export const transformCDERegisters = (text) => {
  const lines = text.split('\n');
  const transformedLines = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('//') || line.trim().startsWith('#') || !line.includes('=')) {
      transformedLines.push(line);
      i++;
      continue;
    }
    const transformedLine = line.replace(/\.(sim|hal|def)\|/g, '.');
    const equalIndex = transformedLine.indexOf('=');
    const key = transformedLine.substring(0, equalIndex).trim();
    const value = transformedLine.substring(equalIndex + 1).trim();

    if (value.startsWith('[')) {
      // the matrix may go on over several lines
      const matrixLines = [value];
      let j = i + 1;
      let closed = value.endsWith(']');
      while (!closed && j < lines.length) {
        const nextLine = lines[j].trim();
        matrixLines.push(nextLine);
        closed = nextLine.endsWith(']');
        j++;
      }
      if (closed) {
        const comma = lines.slice(j).every(is_not_entry) ? '' : ',';
        transformedLines.push(`"${key}": [${parseMatrixToJSON(matrixLines.join('\n').trim())}]${comma}`);
        i = j;
        continue;
      }
    }

    let formattedValue;
    if (value.startsWith('"') && value.endsWith('"')) formattedValue = `[${value}]`;
    else if (!isNaN(value) && !isNaN(parseFloat(value))) formattedValue = `[${value}]`;
    else formattedValue = `["${value}"]`;
    const comma = lines.slice(i + 1).every(is_not_entry) ? '' : ',';
    transformedLines.push(`"${key}": ${formattedValue}${comma}`);
    i++;
  }
  return transformedLines.join('\n');
};

/** The parameters in text pasted from CDE or copied from a tuning: [{name, values}], or null if it's something else */
export const pasted_parameters = text => {
  if (!text || !text.includes('\n') && !text.includes('=') && !text.includes(':')) return null;
  const candidates = [text, `{${text}}`, `{${transformCDERegisters(text)}}`];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (is_object(parsed) && Object.keys(parsed).length > 0)
        return Object.entries(parsed).map(([name, values]) => ({ name, values: wrap(values) }));
    } catch {
      // not this format
    }
  }
  return null;
};
