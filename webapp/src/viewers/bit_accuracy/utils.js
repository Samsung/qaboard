import React from "react";
import { Colors, Tag, Icon, Tooltip, Callout, FormGroup, Switch, InputGroup } from "@blueprintjs/core";


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
  let node = tree;
  let parts = id.split('/');
  for (var i = 0; i < parts.length - 1; i++) {
    // ideally we would have the following, but it's slow...
    // X-eslint-disable-next-line
    // node = node.find(child => child.label === parts[i] )
    let part = parts[i];
    let found = false;
    for (var j = 0; j < node.length; j++) {
      if (node[j].label === part) {
        node = node[j];
        found = true;
        break;
      }
    }
    if (!found) node = undefined;
    node = node && node.childNodes;
    if (node === undefined) return undefined;
  }
  return node.find(child => child.label === parts[parts.length - 1]  )

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
    let missing = `missing_from_${label}`;
    const is_folder = node.childNodes !== undefined;
    if (is_folder) { // aggregate the information from the children nodes
      node.nodeData[missing] = node.childNodes.some(child => child.nodeData[missing]);
      return;
    }
    let missing_reference_tree = (tree === undefined || tree === null);
    node.nodeData[missing] = missing_reference_tree || (getNodeById(tree, node.id) === undefined) || node.nodeData[missing]
}


// Copy data from a tree to an other.
// What's tricky is that nodes don't always exist in the destination tree...
const copyNodeData = (tree_from, tree_to, key) => node => {
    const missing_from_tree = tree_from === undefined || tree_from === null;
    const missing_to_tree = tree_to === undefined || tree_to === null;
    if (missing_from_tree || missing_to_tree)
      return

    const path = node.path;
    let node_from_parent = tree_from;
    let node_to_parent = tree_to;
    let node_to_path = []
    // need to make sure the destination node exists, and create it if necessary
    for (var i = 0; i < path.length; i++) {
      var node_from = node_from_parent[path[i]];

      // eslint-disable-next-line
      // this is much better but slow....
      // var node_to = node_to_parent.find(child => child.label === node_from.label);
      let found = false;
      for (var j = 0; j < node_to_parent.length; j++) {
        if (node_to_parent[j].label===node_from.label) {
          var node_to = node_to_parent[j];
          found = true;
          break;
        }
      }
      if (!found) node_to = undefined;

      if (node_to === undefined) {
        node_to_parent.push({
          id: node_from.id,
          label: node_from.label,
          path: [...node_to_path, node_to_parent.length-1],
          childNodes: (i < path.length - 1) ? [] : undefined,
          nodeData: {
            ...node_from.nodeData, // will actually already copy the key
          },
        })
        node_to = node_to_parent[node_to_parent.length - 1];        
      } else {
        node_to_path = node_to.path
      }
      node_from_parent = node_from.childNodes
      node_to_parent = node_to.childNodes
    }
    node.nodeData[key] = node_from.nodeData[key]
}


// Apply on a tree root to remove the elements nodes that don't match a filter
const filterNodes = (nodes, filter) => {
  if (nodes === undefined || nodes === null)
    return;
  let filtered_nodes = []
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
    var thresh = si ? 1000 : 1024;
    if(Math.abs(bytes) < thresh) {
        return bytes + ' B';
    }
    var units = si
        ? ['kB','MB','GB','TB','PB','EB','ZB','YB']
        : ['KiB','MiB','GiB','TiB','PiB','EiB','ZiB','YiB'];
    var u = -1;
    do {
        bytes /= thresh;
        ++u;
    } while(Math.abs(bytes) >= thresh && u < units.length - 1);
    return bytes.toFixed(1)+' '+units[u];
}



const file_types = [
  {color: Colors.GREY1, label: 'Bit-accurate', icon: 'duplicate'},
  {color: Colors.ORANGE1, label: 'Different', icon: 'cross'},
  {color: Colors.GREEN1, label: 'Missing in the reference', icon: 'plus'},
  {color: Colors.RED1, label: 'Present only in the reference', icon: 'minus'},
]
const folder_types = [
  {color: Colors.GREY1, label: 'All files match', icon: 'folder-close'},
  {color: Colors.ORANGE1, label: 'Some files are different', icon: 'folder-close'},
  {color: Colors.GREEN1, label: 'Some files are missing in the reference', icon: 'folder-close'},
  {color: Colors.RED1, label: 'Some files are only in the reference', icon: 'folder-close'},
  {color: Colors.ROSE1, label: 'Some files are only in the reference and some are different', icon: 'folder-close'},
  {color: Colors.TURQUOISE1, label: 'Some files are missing in the reference and some are different', icon: 'folder-close'},
  {color: Colors.SEPIA1, label: 'It is a mess', icon: 'folder-close'},
]
const bullet_style = {'listStyleType': 'none'};
const icon_style = {'marginRight': '10px'};
let help = <>
  <h3>Showing diffs</h3>
  <p>Click on a file to show its diff versus the reference. Press <kbd>control</kbd> or <kbd>shift</kbd> to select multiple files</p>
  <h3>File icons</h3>
  <ul>{file_types.map( ({color, label, icon}) =>
    <li key={label} style={bullet_style}><Icon icon={icon} style={{...icon_style, color}}></Icon> {label}</li>)}
  </ul>
  <h3>Folder icons</h3>
  <ul>{folder_types.map( ({color, label, icon}) =>
    <li key={label} style={bullet_style}><Icon icon={icon} style={{...icon_style, color}}></Icon> {label}</li>)}
  </ul>
</>
const bit_accuracy_help = <Tooltip><Tag icon='help' minimal round large>Help</Tag>{help}</Tooltip>;





class BitAccuracyForm extends React.Component {
  render() {
    const { show_all_files, expand_all, color_blind_friendly, files_filter, toggle, update } = this.props;
    return <Callout style={{marginBottom: '20px', display: 'flex', justifyContent: 'space-between'}}>
      <FormGroup
        inline
        labelFor="show-all-files"
        helperText="By default the only files shown are those that are different/added/removed."
        style={{flex: '50 1 auto'}}
      >
        <Switch
          label="Show all files"
          checked={show_all_files}
          onChange={toggle('show_all_files')}
          style={{ width: "300px" }}
        />
      </FormGroup>
      <FormGroup
        inline
        labelFor="expand-all"
        style={{flex: '50 1 auto'}}
      >
        <Switch
          label="Expand all folders"
          checked={expand_all}
          onChange={toggle('expand_all')}
          style={{ width: "300px" }}
        />
        <Switch
          label="Color-blind-Friendly"
          checked={color_blind_friendly}
          onChange={toggle('color_blind_friendly')}
          style={{ width: "300px" }}
        />
      </FormGroup>
      <FormGroup
        inline
        labelFor="files-filter"
        helperText="Only show files matching"
        style={{flex: '50 1 auto'}}
      >
        <InputGroup
          value={files_filter}
          placeholder="filter by path"
          onChange={update('files_filter')}
          type="search"
          leftIcon="filter"
          style={{ width: "150px" }}
        />
      </FormGroup>
      <span style={{flex: '1 1 auto'}}>{bit_accuracy_help}</span>
    </Callout>

  }
}





export { getNodeById, forEachNode, visitDepthFirst, copyNodeData, filterNodes, humanFileSize, updateMissingFrom, BitAccuracyForm, bit_accuracy_help }
