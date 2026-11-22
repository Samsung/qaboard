// Tables logged at a step: their .table.json is {"columns": [...], "data": [[...], ...]} (qaboard/media.py). Cells
// are numbers, texts, null, or media: {"kind": "image", "path": "media/...", "width", "height"}. Pure JS.

export const is_media_cell = cell => cell !== null && typeof cell === 'object' && typeof cell.kind === 'string' && typeof cell.path === 'string';

// { columns, rows }, or throws on what isn't a table
export const parseTable = data => {
  const table = typeof data === 'string' ? JSON.parse(data) : data;
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.data))
    throw new Error('not a table: expected {"columns": [...], "data": [[...], ...]}');
  return { columns: table.columns.map(String), rows: table.data.filter(Array.isArray) };
};

// Numbers in a column are right-aligned: those where all the values are numbers (or empty)
export const numericColumns = ({ columns, rows }) => columns.map((_, c) => {
  let numbers = 0;
  for (const row of rows) {
    const cell = row[c];
    if (cell === null || cell === undefined) continue;
    if (typeof cell !== 'number') return false;
    numbers++;
  }
  return numbers > 0;
});

export const cellText = cell => {
  if (cell === null || cell === undefined) return '';
  if (is_media_cell(cell)) return cell.caption ?? cell.path;
  if (typeof cell === 'object') return JSON.stringify(cell);
  return String(cell);
};

// Numbers before texts, empty cells last whatever the order
const compareCells = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return cellText(a).localeCompare(cellText(b), undefined, { numeric: true });
};
const is_empty = cell => cell === null || cell === undefined || cell === '';

// The indices of the rows shown: those with the filter in one of their cells (case-insensitive), sorted by a column
// ({ column, order: 1 | -1 }, or null for the table's order)
export const tableRows = ({ rows }, { filter = '', sort = null } = {}) => {
  const needle = filter.trim().toLowerCase();
  let shown = rows.map((_, i) => i);
  if (needle)
    shown = shown.filter(i => rows[i].some(cell => cellText(cell).toLowerCase().includes(needle)));
  if (sort) {
    const { column, order } = sort;
    shown.sort((i, j) => {
      const a = rows[i][column], b = rows[j][column];
      if (is_empty(a) || is_empty(b)) return is_empty(a) - is_empty(b);
      return order * compareCells(a, b) || i - j;
    });
  }
  return shown;
};

// The column rows are joined by to compare two tables: one named id, name or key, else the first text column, else the first
export const keyColumn = ({ columns, rows }) => {
  const named = columns.findIndex(column => /^(id|name|key)$/i.test(column.trim()));
  if (named >= 0) return named;
  const text = columns.findIndex((_, c) => rows.length > 0 && rows.every(row => typeof row[c] === 'string'));
  return Math.max(0, text);
};

const sameCell = (a, b) => {
  if (is_media_cell(a) && is_media_cell(b)) return a.path.split('/').pop() === b.path.split('/').pop();
  if (typeof a === 'number' && typeof b === 'number') return a === b || Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b));
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
};

// The new table against the reference's, rows joined by a column (its index in the new table; the reference's column
// of the same name): [{ status: 'same' | 'changed' | 'added' | 'removed', row, ref_row, changed: Set(column indices) }],
// the new table's rows in order, then the rows only in the reference. Columns are matched by name.
export const diffTables = (table, ref, column) => {
  const ref_columns = table.columns.map(name => ref.columns.indexOf(name));
  const ref_key = ref_columns[column];
  const by_key = new Map();
  if (ref_key >= 0)
    ref.rows.forEach((row, i) => {
      const key = cellText(row[ref_key]);
      if (!by_key.has(key)) by_key.set(key, i);
    });
  const used = new Set();
  const rows = table.rows.map(row => {
    const key = cellText(row[column]);
    const i = by_key.get(key);
    if (i === undefined || used.has(i)) return { status: 'added', row, ref_row: null, changed: new Set() };
    used.add(i);
    const ref_row = ref.rows[i];
    const changed = new Set(table.columns.map((_, c) => c).filter(c => ref_columns[c] < 0 || !sameCell(row[c], ref_row[ref_columns[c]])));
    return { status: changed.size ? 'changed' : 'same', row, ref_row, changed };
  });
  ref.rows.forEach((ref_row, i) => {
    if (used.has(i)) return;
    rows.push({ status: 'removed', row: table.columns.map((_, c) => ref_columns[c] >= 0 ? ref_row[ref_columns[c]] : null), ref_row, changed: new Set() });
  });
  return rows;
};

// A numeric column's distribution, for a sparkline in its header: `bins` counts from min to max
export const columnHistogram = (rows, column, bins = 12) => {
  const values = rows.map(row => row[column]).filter(Number.isFinite);
  if (values.length < 2) return null;
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  const counts = Array.from({ length: bins }, () => 0);
  for (const v of values) counts[max > min ? Math.min(bins - 1, Math.floor((v - min) / (max - min) * bins)) : 0]++;
  return { min, max, counts };
};
