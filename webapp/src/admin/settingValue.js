// Admins type settings' values as text: "true", "90", "off", "a, b"... We read them with the type of the
// setting (its value or its default), and fall back to JSON, then to text.

const kind = value => value === null || value === undefined ? null : Array.isArray(value) ? 'array' : typeof value;

export const formatSettingValue = value => {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const json = text => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

const booleans = { true: true, yes: true, on: true, '1': true, false: false, no: false, off: false, '0': false };

// => {value} or {error: "a sentence"}. `like`: a value of the same type, e.g. the setting's default.
export function parseSettingValue(text, like) {
  const trimmed = (text ?? '').trim();
  const type = kind(like);
  if (type === 'boolean') {
    const value = booleans[trimmed.toLowerCase()];
    return value === undefined ? { error: 'Type true or false.' } : { value };
  }
  if (type === 'number') {
    if (trimmed === '') return { error: 'Type a number.' };
    const value = Number(trimmed);
    return Number.isFinite(value) ? { value } : { error: 'Type a number.' };
  }
  if (type === 'array') {
    if (trimmed === '') return { value: [] };
    const parsed = trimmed.startsWith('[') ? json(trimmed) : { ok: false };
    if (parsed.ok) return Array.isArray(parsed.value) ? { value: parsed.value } : { error: 'Type a list, e.g. a, b.' };
    return { value: trimmed.split(',').map(item => item.trim()).filter(Boolean) };
  }
  if (type === 'string') {
    // quotes are optional
    const parsed = trimmed.startsWith('"') ? json(trimmed) : { ok: false };
    return { value: parsed.ok && typeof parsed.value === 'string' ? parsed.value : trimmed };
  }
  // Settings without a default (e.g. a maximum that's off): numbers, booleans, lists... else text
  if (trimmed === '') return { error: 'Type a value, or reset the setting to its default.' };
  const parsed = json(trimmed);
  return { value: parsed.ok ? parsed.value : trimmed };
}
