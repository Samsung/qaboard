// How many files a run lists by default in the Output Files view.
// With many runs, listing every file of every run is a long scroll: each run lists its first rows, and says what
// the others are (how many, different, added...). Users who ask for more (a filter, "Expand all folders", a folder
// they open, the run's "more files" row) see everything.

// Rows a run lists before the "N more files" row. When only one row would be hidden, we show it: the "more" row
// takes as much room.
export const PREVIEW_ROWS = 5;


// The rows of a tree users see, depth-first: folders, and the children of expanded folders
const visibleRows = (nodes, is_expanded, parent = null, rows = []) => {
  for (const node of nodes ?? []) {
    const row = { node, parent };
    rows.push(row);
    if (node.childNodes !== undefined && is_expanded(node))
      visibleRows(node.childNodes, is_expanded, row, rows);
  }
  return rows;
};

// Lower is shown first: differences that count for bit-accuracy, other differences, then identical files.
// Folders before files: a folder row tells about many files.
const rank = node => {
  const { differs, checked } = node.nodeData ?? {};
  const is_file = node.childNodes === undefined ? 1 : 0;
  if (differs && checked) return 0 + is_file;
  if (differs) return 2 + is_file;
  return 4 + is_file;
};

const collectFiles = (node, files) => {
  if (node.childNodes === undefined) files.push(node);
  else node.childNodes.forEach(child => collectFiles(child, files));
};

// The tree with at most `max_rows` rows, the files it hides, and the rows it hides (e.g. folders).
// Rows are picked by rank, ties in tree order, with their parent folders, and are shown in tree order.
export const previewTree = (nodes, { is_expanded, max_rows = PREVIEW_ROWS }) => {
  const rows = visibleRows(nodes, is_expanded);
  if (rows.length <= max_rows + 1)
    return { nodes, hidden_files: [], hidden_rows: [] };

  const kept = new Set();
  const keep = row => {
    const missing = [];
    for (let r = row; r !== null && !kept.has(r.node); r = r.parent)
      missing.push(r.node);
    if (kept.size + missing.length <= max_rows)
      missing.forEach(node => kept.add(node));
  };
  const ordered = rows.map((row, index) => ({ row, index, rank: rank(row.node) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  for (const { row } of ordered) {
    if (kept.size >= max_rows) break;
    keep(row);
  }

  const hidden_files = [];
  // the children of collapsed folders aren't rows: they stay, users see them when they open the folder
  const prune = nodes => {
    const shown = [];
    for (const node of nodes) {
      if (!kept.has(node))
        collectFiles(node, hidden_files);
      else if (node.childNodes !== undefined && is_expanded(node))
        shown.push({ ...node, childNodes: prune(node.childNodes) });
      else
        shown.push(node);
    }
    return shown;
  };
  const hidden_rows = rows.filter(row => !kept.has(row.node)).map(row => row.node);
  return { nodes: prune(nodes), hidden_files, hidden_rows };
};


// How files compare with the reference, in the order of the Help's legend
export const file_states = [
  { state: 'different', label: 'different', icon: 'cross' },
  { state: 'added', label: 'added', icon: 'plus' },
  { state: 'removed', label: 'removed', icon: 'minus' },
  { state: 'same', label: 'identical', icon: 'duplicate' },
  { state: 'not_checked', label: 'not checked', icon: 'document' },
];

const file_state = ({ checked, match, missing_from_new, missing_from_reference }, has_reference) => {
  if (!checked) return 'not_checked';
  // without a reference, there is nothing to compare with
  if (!has_reference) return undefined;
  if (missing_from_reference) return 'added';
  if (missing_from_new) return 'removed';
  if (!match) return 'different';
  return 'same';
};

// e.g. [{ state: 'different', count: 12, ... }, { state: 'added', count: 3, ... }]
export const countStates = (files, has_reference) => {
  const counts = {};
  for (const file of files) {
    const state = file_state(file.nodeData ?? {}, has_reference);
    counts[state] = (counts[state] ?? 0) + 1;
  }
  return file_states.filter(s => counts[s.state]).map(s => ({ ...s, count: counts[s.state] }));
};

export const countFiles = nodes => {
  const files = [];
  (nodes ?? []).forEach(node => collectFiles(node, files));
  return files;
};
