import React from "react";

import { Tree, Classes, Colors, Tag, Icon, Tooltip } from "@blueprintjs/core";
import { OutputViewer } from "../OutputViewer"
import { getNodeById, forEachNode, visitDepthFirst, copyNodeData, filterNodes, updateMissingFrom, humanFileSize } from "./utils"
import { match_query } from "../../utils"


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

const applyStyle = (has_reference, color_blind_friendly) => node => {
    const { match, missing_from_reference, missing_from_new} = node.nodeData;
    const is_folder = node.childNodes !== undefined;

    let color = Colors.GREY1;
    if (is_folder) {
      // console.log(node.id, node, !match, missing_from_new, missing_from_reference)
      if (has_reference) {
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
      }
      node.icon = <Icon icon='folder-close' style={{color, ...icon_style}}/>;
      return;
    }

    let icon = 'document'
    if (node.id.match(/(hex|bmp|raw|jpg|jpeg|mp4|imgprops)$/)) {
      icon = 'media'
    } else if (node.id.match(/\.(xml|html)$/)) {
      icon = 'code'
    } else if (node.id.match(/(\.cde|set|\.yaml|\.yml)$/)) {
      icon = 'numerical'
    } else if (node.id.match(/\.(bat|sh|exe|ps1)$/)) {
      icon = 'console'
    } else if (node.id.match(/\.plotly.json$/)) {
      icon = 'area-chart'
    } else if (node.id.match(/\.(csv)$/)) {
      icon = 'th-list'
    } else if (node.id.match(/\.json$/)) {
      icon = 'database'
    }

    if (color_blind_friendly) {
      icon = 'duplicate';
      if (missing_from_reference) {
        icon = 'plus'
      } else if (missing_from_new) {
        icon = 'minus'
      } else if (!match) {
        icon = 'cross'
      }
    }

    if (has_reference) {
      if (missing_from_reference) {
        color = Colors.GREEN1;
      } else if (missing_from_new) {
        color = Colors.RED1;
      } else if (!match) {
        color = Colors.ORANGE1;
      }
    }

    node.icon = <Icon icon={icon} style={{color, ...icon_style}}/>
    let has_size = node.nodeData.st_size !== undefined && node.nodeData.st_size !== null
    let size_real = has_size ? node.nodeData.st_size.toLocaleString('fr-FR') : '?'
    let size_human = has_size ? humanFileSize(node.nodeData.st_size, true) : '?'
    node.secondaryLabel = <Tooltip><span className={Classes.TEXT_MUTED}>{size_human}</span><span>{size_real} B</span></Tooltip>
}


const hash_metrics = metrics => JSON.stringify({...metrics, compute_time: undefined})


class BitAccuracyViewer extends React.Component {
  constructor(props) {
    super(props);
    // console.log(props)
    var tree = {}
    if (!!this.props.manifests) {
      Object.entries(this.props.manifests).forEach( ([label, manifest]) => {
        if (!!manifest)
          tree[label] = to_tree(manifest)
      })
      tree.mixed = this.mergeTrees(tree.new, tree.reference, props);      
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
      {selected.map( filename => {
        const hash = {
          new: this.props.manifests?.new?.[filename]?.md5,
          reference: this.props.manifests?.reference?.[filename]?.md5,
        }
        const has_same_data = !!hash.new && hash.new === hash.reference
        return <>
          {has_same_data && <Tag style={{marginTop: "5px"}} key={`same-${filename}`} minimal icon="duplicate">same-data</Tag>}
          <OutputViewer
              key={filename}
              path={filename}
              max_lines={30}
              {...props}
          />
        </>
      })}

    </div>
  }


  mergeTrees = (tree_new, tree_ref, props) => {
    if (tree_new === null || tree_new === undefined)
      return []

    // make a deep copy
    var tree_compared = JSON.parse(JSON.stringify(tree_new))
    // find the nodes that are missing in the reference tree
    visitDepthFirst(tree_compared, updateMissingFrom(tree_ref, 'reference'))

    visitDepthFirst(tree_ref, updateMissingFrom(tree_compared, 'new'))
    visitDepthFirst(tree_ref, copyNodeData(tree_ref, tree_compared, 'missing_from_new'))
    // now need to update missing recursevely up!
    visitDepthFirst(tree_compared, updateMissingFrom(tree_compared, 'new'))

    // find match / mismatches
    visitDepthFirst(tree_compared, updateMatch(tree_ref))

    const has_filter = !!props.files_filter && props.files_filter.length > 0;
    if (!props.show_all_files && !has_filter) {
      tree_compared = filterNodes(tree_compared, node => !node.nodeData.match || node.nodeData.missing_from_new || node.nodeData.missing_from_reference )
      const has_new = props.output_new !== undefined && props.output_new !== null;
      const has_ref = props.output_ref !== undefined && props.output_ref !== null;
      tree_compared = tree_compared.filter(node => node.id !== 'logs.txt')
      if (has_new && has_ref && getNodeById(tree_compared, 'metrics.json') && hash_metrics(props.output_new.metrics) === hash_metrics(props.output_ref.metrics))
        tree_compared = tree_compared.filter(node => node.id !== 'metrics.json')
    }
    const matcher = match_query(props.files_filter)
    if (has_filter) {
      tree_compared = filterNodes(tree_compared, node => matcher(node.id) || (node.childNodes !== undefined && node.childNodes.length > 0))
      forEachNode(tree_compared, node => {node.isExpanded = true} )    	
    }

    // sort by alphebetical order
    forEachNode(tree_compared, sortChildren)
    // the root is a "chilNodes" array, not a real root...
    tree_compared = tree_compared.sort( (a, b) => a.label.localeCompare(b.label) )

    const has_ref = tree_ref !== null && tree_ref !== undefined
    forEachNode(tree_compared, applyStyle(has_ref, has_ref && props.color_blind_friendly))
    forEachNode(tree_compared, node => {if ((this.state?.opened || []).includes(node.id)) {node.isExpanded = true}} )

    if (props.expand_all !== undefined && !!props.expand_all) {
      forEachNode(tree_compared, node => {node.isExpanded = true} )    	
    }

    return tree_compared;
  }


  handleNodeClick = (node, _nodePath, e) => {
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

      // console.log(updated_new, updated_ref)
      if (updated_new || updated_ref) {
        const tree_new = updated_new ? to_tree(this.props.manifests.new) : this.state.tree.new;
        const tree_reference = updated_ref ? to_tree(this.props.manifests.reference) : this.state.tree.reference;
        const tree_mixed = this.mergeTrees(
          tree_new,
          tree_reference,
          this.props
        );
        this.setState({
          tree: {
            new: tree_new,
            reference: tree_reference,
            mixed: tree_mixed,
          }
        })        
      } else {
        let change_show_all_files = prevProps.show_all_files !== this.props.show_all_files && !!this.state.tree.new;
        let change_files_filter = prevProps.files_filter !== this.props.files_filter && !!this.state.tree.new;
        let change_expand_all = prevProps.expand_all !== this.props.expand_all && !!this.state.tree.new;
        let change_color_blind_friendly = prevProps.color_blind_friendly !== this.props.color_blind_friendly && !!this.state.tree.new;
        if (change_show_all_files || change_files_filter || change_expand_all || change_color_blind_friendly)
          this.setState({
            tree: {
              ...this.state.tree,
              mixed: this.mergeTrees(this.state.tree.new, this.state.tree.reference, this.props),
            }
          })        
      }
  }


}





export default BitAccuracyViewer;
