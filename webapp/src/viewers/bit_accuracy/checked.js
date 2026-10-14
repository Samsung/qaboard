// Which output files count for bit-accuracy, like `qa check-bit-accuracy`
// (`is_bit_accurate` and `cmpmanifests` in qaboard/bit_accuracy.py, `manifests_mismatch` in backend/backend/compare.py):
// - a file is checked if its path matches one of qaboard.yaml's `bit_accuracy.patterns` (default: all files),
//   anywhere in the run's folder: `out.png` checks `out.png` and `some/folder/out.png`
// - unless its path starts with one of `bit_accuracy.ignore`, or with one of the files that change at each run.

// files that change from run to run, always ignored
export const IGNORED_FILES = ['manifest.inputs.json', 'run.json', 'log.txt', 'log.lsf.txt', 'metrics.json', '.nfs000*'];

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// Python's fnmatch: `*` matches anything (including "/"), `?` any character, `[seq]` / `[!seq]` a character (not) in seq
export const fnmatchRegExp = pattern => {
  let re = '';
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const c = pattern[i++];
    if (c === '*') {
      re += '.*';
      while (pattern[i] === '*') i++;
    } else if (c === '?') {
      re += '.';
    } else if (c === '[') {
      let j = i;
      if (pattern[j] === '!') j++;
      if (pattern[j] === ']') j++;
      while (j < n && pattern[j] !== ']') j++;
      if (j >= n) {
        re += '\\[';
      } else {
        let set = pattern.slice(i, j);
        i = j + 1;
        const negate = set[0] === '!';
        if (negate) set = set.slice(1);
        re += `[${negate ? '^' : ''}${set.replace(/[\\\]^[]/g, '\\$&')}]`;
      }
    } else {
      re += escapeRegExp(c);
    }
  }
  try {
    return new RegExp(`^${re}$`, 's');
  } catch {
    // e.g. reversed ranges like [z-a]: Python never matches them either
    return { test: path => path === pattern };
  }
};

const asList = value => (value === undefined || value === null) ? [] : (Array.isArray(value) ? value : [value]);

// Returns a function telling whether a file (its path in the run's folder) is checked for bit-accuracy.
export const bitAccuracyChecker = bit_accuracy => {
  const configured = asList(bit_accuracy?.patterns);
  const patterns = configured.length > 0 ? configured : ['*'];
  const ignore = [...asList(bit_accuracy?.ignore), ...IGNORED_FILES];
  const included = patterns.map(p => fnmatchRegExp(`*${p}`));
  const excluded = ignore.map(i => fnmatchRegExp(`${i}*`));
  return path => included.some(r => r.test(path)) && !excluded.some(r => r.test(path));
};


// Our trees are in the format expected by https://blueprintjs.com/docs/#core/components/tree
// Each file node's nodeData has: match, missing_from_new, missing_from_reference (from the comparison with the reference).
// This sets on each node:
// - checked: whether bit_accuracy.patterns check the file, for folders whether they have checked files
// - differs: whether the file differs from the reference's (or is only in one run), for folders whether one of their files does
// and makes folders' match/missing_from_new/missing_from_reference summarize only their checked files.
const is_different = ({ match, missing_from_new, missing_from_reference }) => !match || !!missing_from_new || !!missing_from_reference;

export const markChecked = (nodes, isChecked) => {
  (nodes ?? []).forEach(node => {
    const is_folder = node.childNodes !== undefined;
    if (!is_folder) {
      node.nodeData.checked = isChecked(node.id);
      node.nodeData.differs = is_different(node.nodeData);
      return;
    }
    markChecked(node.childNodes, isChecked);
    const checked = node.childNodes.filter(child => child.nodeData.checked);
    node.nodeData.checked = checked.length > 0;
    node.nodeData.differs = node.childNodes.some(child => child.nodeData.differs);
    node.nodeData.match = checked.every(child => child.nodeData.match);
    node.nodeData.missing_from_new = checked.some(child => child.nodeData.missing_from_new);
    node.nodeData.missing_from_reference = checked.some(child => child.nodeData.missing_from_reference);
  });
  return nodes;
};

// Summarizes a tree after markChecked:
// - checked: how many files are checked
// - bit_accurate: there are checked files, and all of them are in both runs with the same content.
export const bitAccuracySummary = nodes => {
  let checked = 0;
  let checked_differences = 0;
  const visit = nodes => (nodes ?? []).forEach(node => {
    if (node.childNodes !== undefined) {
      visit(node.childNodes);
    } else if (node.nodeData.checked) {
      checked += 1;
      checked_differences += node.nodeData.differs;
    }
  });
  visit(nodes);
  return {
    checked,
    bit_accurate: checked > 0 && checked_differences === 0,
  };
};
