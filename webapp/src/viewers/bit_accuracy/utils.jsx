import { Classes, Colors, Button, Icon, PopoverNext, Switch, InputGroup } from "@blueprintjs/core";

import { useIsDark } from "../../theme";


//----- Trees ----------------------------------------------------------------- 
// Those utilities are a mini-library to make it easy to work with trees.
// Our trees are in the format expected by
//   https://blueprintjs.com/docs/#core/components/tree

/*
// Returns a node from a tree, given its path
// Unused because it's confusing when dealing with multiple trees: order among children doesn't matter.
const getNodeByPath = (tree, path) => {
  if (tree === undefined || tree === null)
    return undefined;
  if (path === undefined || path === null)
    return undefined;
  let node = tree;
  for (var i = 0; i < path.length - 1; i++) {
    node = node[path[i]] && node[path[i]].childNodes
    if (node === undefined) return undefined;
  }
  return node[path[path.length - 1]]
}
*/


// Returns a node from a tree, given its id
// we assume the id is a filepath, and the tree nodes have their filenames as labels
const getNodeById = (tree, id) => {
  if (tree === undefined || tree === null)
    return undefined;
  if (id === undefined || id === null)
    return undefined;
  let nodes = tree;
  const parts = id.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    nodes = nodes.find(child => child.label === parts[i])?.childNodes;
    if (nodes === undefined) return undefined;
  }
  return nodes.find(child => child.label === parts[parts.length - 1])
}


// Walk depth depth, starting by the root
const forEachNode = (nodes, callback) => {
  if (nodes === undefined || nodes === null)
    return;
  nodes.forEach(node => {
    callback(node);
    forEachNode(node.childNodes, callback);
  })
 }


// Visit the tree starting from the leaft, depth first
const visitDepthFirst = (nodes, callback) => {
  if (nodes === undefined || nodes === null)
    return;
  nodes.forEach(node => {
    visitDepthFirst(node.childNodes, callback);
    callback(node);
  })
 }


// Returns a function that updates a node's data depending on whether is present the reference `tree`
// NOTE: We assume the node's children have already been updateMissingFrom'ed
const updateMissingFrom = (tree, label) => node => {
    const missing = `missing_from_${label}`;
    const is_folder = node.childNodes !== undefined;
    if (is_folder) { // aggregate the information from the children nodes
      node.nodeData[missing] = node.childNodes.some(child => child.nodeData[missing]);
      return;
    }
    const missing_reference_tree = (tree === undefined || tree === null);
    node.nodeData[missing] = missing_reference_tree || (getNodeById(tree, node.id) === undefined) || node.nodeData[missing]
}


// Copy data from a tree to an other.
// What's tricky is that nodes don't always exist in the destination tree...
const copyNodeData = (tree_from, tree_to, key) => node => {
    const missing_from_tree = tree_from === undefined || tree_from === null;
    const missing_to_tree = tree_to === undefined || tree_to === null;
    if (missing_from_tree || missing_to_tree)
      return

    let node_from_parent = tree_from;
    let node_to_parent = tree_to;
    let node_to_path = []
    let node_from;
    // need to make sure the destination node exists, and create it if necessary
    for (let i = 0; i < node.path.length; i++) {
      node_from = node_from_parent[node.path[i]];
      let node_to = node_to_parent.find(child => child.label === node_from.label);
      if (node_to === undefined) {
        node_to = {
          id: node_from.id,
          label: node_from.label,
          path: [...node_to_path, node_to_parent.length],
          childNodes: (i < node.path.length - 1) ? [] : undefined,
          nodeData: {
            ...node_from.nodeData, // will actually already copy the key
          },
        };
        node_to_parent.push(node_to)
      }
      node_to_path = node_to.path
      node_from_parent = node_from.childNodes ?? []
      node_to_parent = node_to.childNodes ?? []
    }
    node.nodeData[key] = node_from.nodeData[key]
}


// Apply on a tree root to remove the elements nodes that don't match a filter
const filterNodes = (nodes, filter) => {
  if (nodes === undefined || nodes === null)
    return;
  const filtered_nodes = []
  nodes.forEach(node => {
    node.childNodes = filterNodes(node.childNodes, filter);
    if (filter(node))
      filtered_nodes.push(node);
  })
  return filtered_nodes
 }





//----- Misc Components ------------------------------------------------------- 
// from stackoverflow...
const humanFileSize = (bytes, si) => {
  if (bytes === undefined || bytes === null)
    return ''

  const thresh = si ? 1000 : 1024;
  if(Math.abs(bytes) < thresh) {
      return bytes + ' B';
  }
  const units = si
      ? ['kB','MB','GB','TB','PB','EB','ZB','YB']
      : ['KiB','MiB','GiB','TiB','PiB','EiB','ZiB','YiB'];
  let u = -1;
  do {
      bytes /= thresh;
      ++u;
  } while(Math.abs(bytes) >= thresh && u < units.length - 1);
  return bytes.toFixed(1)+' '+units[u];
}

const humanElapsedTime = (seconds_str) => {
  if (seconds_str === undefined || seconds_str === null) {
    return ''
  }

  // rounding would say 90s are "2min30s"
  const seconds = String(Math.floor(Number(seconds_str) % 60));
  const minutes = String(Math.floor(Number(seconds_str) / 60) % 60);
  const hours = String(Math.floor(Number(seconds_str) / 3600));
  let elapsed_time = '';
  if (hours   !== '0') elapsed_time += hours + 'h'
  if (minutes !== '0') elapsed_time += minutes + 'min'
  if (seconds !== '0') elapsed_time += seconds + 's'
  if (!elapsed_time) elapsed_time += Number(seconds_str).toFixed(2) + 's'
  return elapsed_time;
}


// How files and folders compare to the reference, with colors readable on light and dark backgrounds
const state_colors = is_dark => ({
  same: is_dark ? Colors.GRAY4 : Colors.GRAY1,
  different: is_dark ? Colors.ORANGE4 : Colors.ORANGE3,
  added: is_dark ? Colors.GREEN4 : Colors.GREEN3,
  removed: is_dark ? Colors.RED4 : Colors.RED3,
  removed_and_different: is_dark ? Colors.ROSE4 : Colors.ROSE3,
  added_and_different: is_dark ? Colors.TURQUOISE4 : Colors.TURQUOISE3,
  mixed: is_dark ? Colors.SEPIA4 : Colors.SEPIA3,
  not_checked: is_dark ? Colors.GRAY2 : Colors.GRAY4,
})

const file_types = [
  {state: 'same', label: 'Identical to the reference', icon: 'duplicate'},
  {state: 'different', label: 'Different', icon: 'cross'},
  {state: 'added', label: 'Missing in the reference', icon: 'plus'},
  {state: 'removed', label: 'Present only in the reference', icon: 'minus'},
  {state: 'not_checked', label: 'Not checked for bit-accuracy (bit_accuracy.patterns in qaboard.yaml)', icon: 'document'},
]
const folder_types = [
  {state: 'same', label: 'All files match', icon: 'folder-close'},
  {state: 'different', label: 'Some files are different', icon: 'folder-close'},
  {state: 'added', label: 'Some files are missing in the reference', icon: 'folder-close'},
  {state: 'removed', label: 'Some files are only in the reference', icon: 'folder-close'},
  {state: 'removed_and_different', label: 'Some files are only in the reference and some are different', icon: 'folder-close'},
  {state: 'added_and_different', label: 'Some files are missing in the reference and some are different', icon: 'folder-close'},
  {state: 'mixed', label: 'Some files are missing, some only in the reference, some different', icon: 'folder-close'},
]
const bullet_style = {'listStyleType': 'none'};
const icon_style = {'marginRight': '10px'};
const BitAccuracyHelp = () => {
  const colors = state_colors(useIsDark());
  return <div style={{ padding: '5px 15px', maxWidth: '600px' }}>
    <h3>Showing diffs</h3>
    <p>Click on a file to show its diff versus the reference. Press <kbd>control</kbd> or <kbd>shift</kbd> to select multiple files</p>
    <h3>Bit-accuracy</h3>
    <p>Like <code>qa check-bit-accuracy</code>, only the files matching <code>bit_accuracy.patterns</code> in qaboard.yaml are checked (by default all files, except logs, <code>run.json</code> and <code>metrics.json</code>).</p>
    <h3>File icons</h3>
    <ul>{file_types.map( ({state, label, icon}) =>
      <li key={label} style={bullet_style}><Icon icon={icon} style={{...icon_style, color: colors[state]}}></Icon> {label}</li>)}
    </ul>
    <h3>Folder icons</h3>
    <ul>{folder_types.map( ({state, label, icon}) =>
      <li key={label} style={bullet_style}><Icon icon={icon} style={{...icon_style, color: colors[state]}}></Icon> {label}</li>)}
    </ul>
  </div>
}
// It's tall: when it fits neither below nor above, it stays below where scrolling shows it all, instead of
// being cut off by the top of the page
const bit_accuracy_help = <PopoverNext content={<BitAccuracyHelp/>} placement="bottom-end" middleware={{ flip: { fallbackStrategy: "initialPlacement" } }}>
  <Button variant="minimal" icon="help" text="Help"/>
</PopoverNext>;





// The options of the output files views. Users change them once in a while: they're in the commit page's
// View options (or a popover elsewhere), while the filter, used all the time, stays above the files.
const file_options = [
  { name: 'show_all_files', label: 'Show all files', short: 'all files', help: 'By default, only the checked files that are different, added or removed show.' },
  { name: 'hide_runs_without_files', label: 'Hide runs without files', short: 'runs without files hidden' },
  { name: 'expand_all', label: 'Expand all folders', short: 'folders expanded' },
  { name: 'color_blind_friendly', label: 'Color-blind friendly', short: 'color-blind friendly' },
];

// The options turned on, e.g. "all files, folders expanded"
const file_options_summary = options => file_options.filter(o => !!options[o.name]).map(o => o.short);

const FileOptionSwitches = ({ options, toggle }) => file_options.map(o => <Switch
  key={o.name}
  label={o.help
    ? <>{o.label}<div className={Classes.TEXT_MUTED} style={{ fontSize: 12, lineHeight: '16px', margin: '2px 0 4px' }}>{o.help}</div></>
    : o.label}
  checked={!!options[o.name]}
  onChange={toggle(o.name)}
/>);

const files_toolbar = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px 8px', marginBottom: '12px' };

// The files filter, and the files options: a button that opens them, in the View options with `onShowOptions`
const BitAccuracyForm = ({ show_all_files, hide_runs_without_files, expand_all, color_blind_friendly, files_filter, toggle, update, onShowOptions }) => {
  const options = { show_all_files, hide_runs_without_files, expand_all, color_blind_friendly };
  const on = file_options_summary(options);
  const options_button = <Button
    icon="settings"
    variant="minimal"
    onClick={onShowOptions}
    title={onShowOptions ? "Change them in the View options (press o)" : undefined}
  >
    {on.length > 0 ? <>File options: <strong>{on.join(', ')}</strong></> : 'File options'}
  </Button>;
  return <div style={files_toolbar}>
    <InputGroup
      id="files-filter"
      value={files_filter}
      placeholder="Filter files by path"
      aria-label="Filter files by path"
      onChange={update('files_filter')}
      type="text"
      leftIcon="filter"
      style={{ width: 320 }}
      rightElement={files_filter ? <Button variant="minimal" icon="cross" aria-label="Clear the filter" onClick={() => update('files_filter')('')}/> : undefined}
    />
    <span className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>
      <code>match:name</code> identical files, <code>diff:name</code> different ones
    </span>
    {onShowOptions
      ? options_button
      : <PopoverNext placement="bottom-start" content={<div style={{ padding: '12px 16px', maxWidth: 320 }}><FileOptionSwitches options={options} toggle={toggle}/></div>}>
        {options_button}
      </PopoverNext>}
    <span style={{ marginLeft: 'auto' }}>{bit_accuracy_help}</span>
  </div>
}



// The options of the bit-accuracy viewers are in the URL, but not when they have their default value
const bit_accuracy_url_defaults = { show_all_files: false, hide_runs_without_files: false, expand_all: false, color_blind_friendly: false, files_filter: '' };

export { state_colors, bit_accuracy_url_defaults, file_options, file_options_summary, FileOptionSwitches, getNodeById, forEachNode, visitDepthFirst, copyNodeData, filterNodes, humanFileSize, updateMissingFrom, BitAccuracyForm, bit_accuracy_help, humanElapsedTime }
