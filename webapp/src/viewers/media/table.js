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
