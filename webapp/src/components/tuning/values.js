// What people type as the values to try, read in one place: the table's tags, the range filler and pasted text.
// It knows nothing about the parameters yet. Later, projects describe theirs ({type, min, max, default, description,
// group}) and the same function checks the values against that description.

const number_pattern = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
export const is_number_text = text => number_pattern.test(String(text).trim());

// Registers are often pasted as [1 2 3], matrices with a row per line
const register_list = trimmed => {
  if (!/^\[[^[\]{}",]*\]$/.test(trimmed)) return undefined;
  const rows = trimmed.slice(1, -1).split(/\r?\n/).map(row => row.trim().split(/\s+/).filter(Boolean)).filter(row => row.length > 0);
  if (rows.length === 0 || !rows.flat().every(is_number_text)) return undefined;
  return rows.length === 1 ? rows[0].map(Number) : rows.map(row => row.map(Number));
};

/**
 * Reads one value as typed: numbers, true/false and null stay what they are, "1" in quotes is text, a list like
 * [[0, 1], [1, 0]] is one value (a matrix). Returns {value, error}: with an error, `value` is what we keep anyway
 * (the text), like the JSON editor always did, and `error` says what looks wrong.
 * `description` ({type, min, max, default, description, group}) is not used yet.
 */
export const parse_value = (text, _description = undefined) => {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return { value: '', error: 'Empty value' };
  if (is_number_text(trimmed)) return { value: Number(trimmed), error: null };
  if (trimmed === 'true') return { value: true, error: null };
  if (trimmed === 'false') return { value: false, error: null };
  if (trimmed === 'null') return { value: null, error: null };
  if (/^[[{"]/.test(trimmed)) {
    try {
      return { value: JSON.parse(trimmed), error: null };
    } catch {
      const list = register_list(trimmed);
      if (list !== undefined) return { value: list, error: null };
      return {
        value: trimmed,
        error: trimmed.startsWith('"') ? 'Unclosed quote: it is kept as text' : 'Not a valid list: check the brackets and commas. It is kept as text',
      };
    }
  }
  return { value: trimmed, error: null };
};

/** JSON on one line, spaced like people write it: [[0, 1], {"a": 1}] */
export const compact_json = value => {
  if (Array.isArray(value)) return `[${value.map(compact_json).join(', ')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).map(([key, v]) => `${JSON.stringify(key)}: ${compact_json(v)}`).join(', ')}}`;
  return JSON.stringify(value) ?? 'null';
};

/** "1, 2, [3, 4], a b" => ["1", "2", "[3, 4]", "a b"]: commas, semicolons and new lines separate values, except inside lists and quotes */
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

/** How a value shows in a tag, so that typing it back gives the same value: text as it is, unless it reads as something else ("1") */
export const format_value = value => {
  if (typeof value !== 'string') return compact_json(value);
  const parts = split_values(value);
  return parse_value(value).value !== value || parts.length !== 1 || parts[0] !== value ? JSON.stringify(value) : value;
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
