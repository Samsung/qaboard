import React from "react";

import { Tree, Classes, Colors, Tag, Icon, Tooltip } from "@blueprintjs/core";
import { OutputViewer } from "../OutputCard"
import { getNodeById, forEachNode, visitDepthFirst, copyNodeData, filterNodes, updateMissingFrom, humanFileSize } from "./utils"



// Turns a flat file manifest into a proper tree
const to_tree = filepaths => {
  if (filepaths === undefined || filepaths === null)
    return []

  var tree = []
  Object.entries(filepaths).forEach( ([filepath, meta]) => {    
    let parts = filepath.split('/')
    var parent = tree
    let path = []
    for (var i = 0; i < parts.length; i++) {
      let part = parts[i];
      let id = parts.slice(0, i+1).join('/')
      var node_idx = parent.findIndex(node => node.id === id)
      if (node_idx < 0) {
        node_idx = parent.length;
        parent.push({
          id,
          label: part,
          path: [...path, node_idx],
          childNodes: [],
          nodeData: {...meta},
        })
      }
      // the last node is a file
      if (i === parts.length - 1) {
        parent[node_idx].childNodes = undefined
      }
      parent = parent[node_idx].childNodes;
      path = [...path, node_idx] 
    }
  })
  return tree;
}


// Updates a node's data depending on whether it matches its counterpart in the reference tree
// NOTE: We assume the node's children have already been updateMatch'ed
// NOTE: We consider nodes absent from the reference tree match
const updateMatch = tree_reference => node => {
    const is_folder = node.childNodes !== undefined;
    if (is_folder) { // aggregate the information from the children nodes
      node.nodeData.match = node.childNodes.every(child => child.nodeData.match === undefined || child.nodeData.match);
      return;
    }
    const node_reference = getNodeById(tree_reference, node.id)
    if (node_reference === undefined)
      node.nodeData.match = true;
    else
      node.nodeData.match = node.nodeData.md5 === node_reference.nodeData.md5;
}



// Sort the children of a tree node according to their label
const sortChildren = node => {
    const is_folder = node.childNodes !== undefined;
    if (!is_folder) return;
    node.childNodes = node.childNodes.sort( (a, b) => a.label.localeCompare(b.label) )
}




const icon_style = {
  marginRight: '10px',
}

const applyStyle = node => {
    const { match, missing_from_reference, missing_from_new} = node.nodeData;
    const is_folder = node.childNodes !== undefined;

    let color = Colors.GREY1;
    if (is_folder) {
      if (!match && missing_from_new && missing_from_reference) {
        color = Colors.SEPIA1;
      } else if (!match && missing_from_new) {
        color = Colors.ROSE1;
      } else if (!match && missing_from_reference) {
        color = Colors.TURQUOISE1;
      } else if (!match) {
        color = Colors.ORANGE1;
      } else if (missing_from_new) {
        color = Colors.RED1;
      } else if (missing_from_reference) {
        color = Colors.GREEN1;
      }
      node.icon = <Icon icon='folder-close' style={{color, ...icon_style}}/>;
      return;
    }

    let icon = 'duplicate';
    if (missing_from_reference) {
      color = Colors.GREEN1;
      icon = 'plus'
    } else if (missing_from_new) {
      color = Colors.RED1;
      icon = 'minus'
    } else if (!match) {
      color = Colors.ORANGE1;
      icon = 'cross'
    }
    node.icon = <Icon icon={icon} style={{color, ...icon_style}}/>
    let size_real = !!node.nodeData.st_size ? node.nodeData.st_size.toLocaleString('fr-FR') : '?'
    let size_human = !!node.nodeData.st_size ? humanFileSize(node.nodeData.st_size, true) : '?'
    node.secondaryLabel = <Tooltip><span className={Classes.TEXT_MUTED}>{size_human}</span><span>{size_real} B</span></Tooltip>
}


const hash_metrics = metrics => JSON.stringify({...metrics, compute_time: undefined})


class BitAccuracyViewer extends React.Component {
  constructor(props) {
    super(props);
    var tree = {}
    if (!!this.props.manifests) {
      Object.entries(this.props.manifests).forEach( ([label, manifest]) => {
        if (!!manifest)
          tree[label] = to_tree(manifest)
      })
      tree.mixed = this.mergeTrees(tree.new, tree.reference);      
    }

    this.state = {
      tree,
      selected: [],
      opened: [],
    }
  }


  render() {
    const { tree, selected } = this.state;

    const { type, ...props } = this.props;
    return <div>
      {!!tree.new && !!tree.reference && tree.mixed.every(node => node.nodeData.match && !node.nodeData.missing_from_new && !node.nodeData.missing_from_reference) && <Tag>Bit-accurate</Tag>}
      <Tree
       contents={tree.mixed}
       onNodeClick={this.handleNodeClick}
       onNodeCollapse={this.handleNodeCollapse}
       onNodeExpand={this.handleNodeExpand}
      />
      {selected.map( filename => 
        <OutputViewer
            key={filename}
            path={filename}
            hash={getNodeById(tree.mixed, filename) && getNodeById(tree.mixed, filename).nodeData.md5}
            max_lines={30}
            {...props}
        />
      )}

    </div>
  }


  mergeTrees = (tree_new, tree_ref) => {
    if (tree_new === null || tree_new === undefined)
      return []

    // make a deep copy
    var tree_compared = JSON.parse(JSON.stringify(tree_new))
    // find the nodes that are missing in the reference tree
    visitDepthFirst(tree_compared, updateMissingFrom(tree_ref, 'reference'))

    visitDepthFirst(tree_ref, updateMissingFrom(tree_compared, 'new'))
    visitDepthFirst(tree_ref, copyNodeData(tree_ref, tree_compared, 'missing_from_new'))

    // find match / mismatches
    visitDepthFirst(tree_compared, updateMatch(tree_ref))

    if (!this.props.show_all_files) {
      tree_compared = filterNodes(tree_compared, node => !node.nodeData.match || node.nodeData.missing_from_new || node.nodeData.missing_from_reference )
      const has_new = this.props.output_new !== undefined && this.props.output_new !== null;
      const has_ref = this.props.output_ref !== undefined && this.props.output_ref !== null;
      tree_compared = tree_compared.filter(node => node.id !== 'logs.txt')
      if (has_new && has_ref && getNodeById(tree_compared, 'metrics.json') && hash_metrics(this.props.output_new.metrics) === hash_metrics(this.props.output_ref.metrics))
        tree_compared = tree_compared.filter(node => node.id !== 'metrics.json')
    }
    if (!!this.props.files_filter && this.props.files_filter.length > 0) {
      tree_compared = filterNodes(tree_compared, node => node.id.includes(this.props.files_filter) || (node.childNodes !== undefined && node.childNodes.length > 0))
      forEachNode(tree_compared, node => {node.isExpanded = true} )    	
    }

    // sort by alphebetical order
    forEachNode(tree_compared, sortChildren)
    // the root is a "chilNodes" array, not a real root...
    tree_compared = tree_compared.sort( (a, b) => a.label.localeCompare(b.label) )

    forEachNode(tree_compared, applyStyle)
    forEachNode(tree_compared, node => {if (((this.state || {}).opened || []).includes(node.id)) {node.isExpanded = true}} )

    if (this.props.expand_all !== undefined && !!this.props.expand_all) {
      forEachNode(tree_compared, node => {node.isExpanded = true} )    	
    }

    return tree_compared;
  }


  handleNodeClick = (node, _nodePath: number[], e: React.MouseEvent<HTMLElement>) => {
    const is_folder = node.childNodes !== undefined;
    if (is_folder) return;

    let selected = this.state.selected;
    let was_selected = node.isSelected
    if (!e.shiftKey && !e.ctrlKey) {
        forEachNode(this.state.tree.mixed, n => (n.isSelected = false));
        selected = []
    }
    let isSelected = was_selected===null ? true : !was_selected;
    node.isSelected = isSelected
    if (isSelected) {
      selected = [...selected, node.id]
    } else {
      selected = selected.filter(filepath => filepath !== node.id)
    }
    this.setState({selected});
  };

  handleNodeCollapse = node => {
    node.isExpanded = false;
    // eslint-disable-next-line
    const { props , icon: _ } = node.icon
    node.icon = <Icon {...props} icon='folder-close'/>
    const opened = this.state.opened.filter(filename => filename !== node.id)
    this.setState({opened});
  };

  handleNodeExpand = node => {
    node.isExpanded = true;
    // eslint-disable-next-line
    const { props , icon: _ } = node.icon
    node.icon = <Icon {...props} icon='folder-open'/>
    const opened = [...this.state.opened, node.id]
    this.setState({opened});
  };


  componentDidUpdate(prevProps, prevState) {
      // console.log(this.props)
      // console.log(prevProps)
      const has_new_manifest = !!this.props.manifests && !!this.props.manifests.new;
      const has_ref_manifest = !!this.props.manifests && !!this.props.manifests.reference;

      const had_new_manifest = !!prevProps.manifests && !!prevProps.manifests.new;
      const had_ref_manifest = !!prevProps.manifests && !!prevProps.manifests.reference;

      let updated_new = has_new_manifest && (!had_new_manifest || prevProps.manifests.new !== this.props.manifests.new);
      let updated_ref = has_ref_manifest && (!had_ref_manifest || prevProps.manifests.reference !== this.props.manifests.reference);

      if (updated_new)
        this.setState({tree: {...this.state.tree, new: to_tree(this.props.manifests.new)}})
      if (updated_ref)
        this.setState({tree: {...this.state.tree, reference: to_tree(this.props.manifests.reference)}})

      let change_show_all_files = prevProps.show_all_files !== this.props.show_all_files && !!this.state.tree.new;
      let change_files_filter = prevProps.files_filter !== this.props.files_filter && !!this.state.tree.new;
      let change_expand_all = prevProps.expand_all !== this.props.expand_all && !!this.state.tree.new;
      if (change_show_all_files || change_files_filter || change_expand_all)
        this.setState({
          tree: {
            ...this.state.tree,
            mixed: this.mergeTrees(this.state.tree.new, this.state.tree.reference),
          }
        })
  }


}





export default BitAccuracyViewer;
