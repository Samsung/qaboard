import React from "react";
import { Colors, Tag, Icon, Tooltip } from "@blueprintjs/core";


//----- Trees ----------------------------------------------------------------- 
// Those utilities are a mini-library to make it easy to work with trees.
// Our trees are in the format expected by
//   https://blueprintjs.com/docs/#core/components/tree

// Returns a node from a tree, given its path
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
    node = node.find(child => child.label === parts[i] )
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
    let missing_reference_tree = tree === undefined || tree === null;
    node.nodeData[missing] = missing_reference_tree || (getNodeById(tree, node.id) === undefined)
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
      var node_to = node_to_parent.find(child => child.label === node_from.label);
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
    node.nodeData[key] = node_from.nodeData
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







export { bit_accuracy_help, getNodeById, forEachNode, visitDepthFirst, copyNodeData, filterNodes, humanFileSize, updateMissingFrom }
