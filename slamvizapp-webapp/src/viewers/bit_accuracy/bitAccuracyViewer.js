import React from "react";
import { get, all, CancelToken } from "axios";

import { Tree, Classes, Colors, Tag, Icon, Tooltip } from "@blueprintjs/core";
import { OutputViewer } from "../OutputCard"
import { getNodeById, forEachNode, visitDepthFirst, copyNodeData, filterNodes, updateMissingFrom, humanFileSize } from "./utils"



// Turns a flat file manifest into a proper tree
const to_tree = filepaths => {
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
      node.nodeData.match = node.childNodes.every(child => child.nodeData.match);
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
    let size_real = node.nodeData.st_size.toLocaleString('fr-FR')
    let size_human = humanFileSize(node.nodeData.st_size, true)
    node.secondaryLabel = <Tooltip><span className={Classes.TEXT_MUTED}>{size_human}</span><span>{size_real} B</span></Tooltip>
}


const compareTrees = (tree_new, tree_ref, options) => {
  // make a deep copy
  var tree_compared = JSON.parse(JSON.stringify(tree_new))
  // find the nodes that are missing in the reference tree
  visitDepthFirst(tree_compared, updateMissingFrom(tree_ref, 'reference'))
  // find match / mismatches
  visitDepthFirst(tree_compared, updateMatch(tree_ref))

  visitDepthFirst(tree_ref, updateMissingFrom(tree_compared, 'new'))
  visitDepthFirst(tree_ref, copyNodeData(tree_ref, tree_compared, 'missing_from_new'))

  if (!options.show_all_files)
    tree_compared = filterNodes(tree_compared, node => !node.nodeData.match )

  // sort by alphebetical order
  forEachNode(tree_compared, sortChildren)
  // the root is a "chilNodes" array, not a real root...
  tree_compared = tree_compared.sort( (a, b) => a.label.localeCompare(b.label) )

  forEachNode(tree_compared, applyStyle)
  
  return tree_compared;
}




class BitAccuracyViewer extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      is_loaded: false,
      error: null,
      cancel_source: CancelToken.source(),
      manifests: {},
      tree: {},
      selected: [],
    }
  }


  render() {
    const { manifests, tree, layouts, is_loaded, error, selected } = this.state;
    if (!is_loaded) return <span></span>;
    if (!!error) return <span>{JSON.stringify(error)}</span>

    const { output_new, output_ref, type, ...props } = this.props;
    console.log('selected', selected)
    // console.log(tree.mixed)
    return <div>
      {tree.mixed.length===0 && <Tag>Bit-accurate</Tag>}
      <Tree
       contents={tree.mixed}
       onNodeClick={this.handleNodeClick}
       onNodeCollapse={this.handleNodeCollapse}
       onNodeExpand={this.handleNodeExpand}
      />
      {selected.map( filename => 
        <OutputViewer
            path={filename}
            always_show_diff max_lines={50}
            output_new={output_new}
            output_ref={(this.props.controls.show_reference === undefined || this.props.controls.show_reference) ? output_ref : undefined}
            {...props}
        />
      )}

    </div>
  }



  handleNodeClick = (node, _nodePath: number[], e: React.MouseEvent<HTMLElement>) => {
    const is_folder = node.childNodes !== undefined;
    if (is_folder) return;
    if (!e.shiftKey && !e.ctrlKey) {
        forEachNode(this.state.nodes, n => (n.isSelected = false));
        this.setState({selected: [node.id]});
    }
    let isSelected = node.isSelected === null ? true : !node.isSelected;
    node.isSelected = isSelected
    if (isSelected) {
      this.setState({selected: [...this.state.selected, node.id]});      
    } else {
      this.setState({selected: this.state.selected.filter(filepath => filepath !== node.id) });      
    }
  };

  handleNodeCollapse = node => {
    node.isExpanded = false;
    const { props , icon} = node.icon
    node.icon = <Icon {...props} icon='folder-close'/>
    this.setState(this.state);
  };

  handleNodeExpand = node => {
    node.isExpanded = true;
    const { props , icon} = node.icon
    node.icon = <Icon {...props} icon='folder-open'/>
    this.setState(this.state);
  };




  componentDidMount() {
    this.fetchData(this.props);
  }

  componentWillUnmount() {
    if (!!this.state.cancel_source)
      this.state.cancel_source.cancel();
  }

  componentDidUpdate(prevProps, prevState) {
      const has_new = this.props.output_new !== undefined && this.props.output_new !== null;
      const has_ref = this.props.output_ref !== undefined && this.props.output_ref !== null;
      let updated_new = has_new && (prevProps.output_new === null || prevProps.output_new === undefined || prevProps.output_new.id !== this.props.output_new.id);
      let updated_ref = has_ref && (prevProps.output_ref === null || prevProps.output_ref === undefined || prevProps.output_ref.id !== this.props.output_ref.id);
      if (updated_new) {
        this.fetchData(this.props, 'new');
      }
      if (updated_ref) {
        this.fetchData(this.props, 'reference');
      }
      if (prevProps.show_all_files !== this.props.show_all_files)
        this.setState({
          tree: {
            ...this.state.tree,
            mixed: compareTrees(this.state.tree.new, this.state.tree.reference, {show_all_files: this.props.show_all_files}),
          }
        })
  }


  fetchData(props, label) {
    const { output_new, output_ref } = props;
    if (!output_new.output_dir_url) return;

    let results = [];
    const should_get_all = label === undefined || label === null;
    if (should_get_all || label === 'new') {
      results.push(['new', `${output_new.output_dir_url}/manifest.outputs.json`])
    }
    if (should_get_all || label === 'reference') {
      if (!!output_ref && !!output_ref.output_dir_url)
        results.push(['reference', `${output_ref.output_dir_url}/manifest.outputs.json`])
    }

    const load_data = label => response => {
      this.setState((previous_state, props) => ({
        manifests: {
          ...previous_state.manifests,
          [label]: response.data,
        },
        tree: {
          ...previous_state.tree,
          [label]: to_tree(response.data),
        },
      }))
    }

    all(results.map( ([label, url]) => {
      return () =>  get(url, {cancelToken: this.state.cancel_source.token})
                    .then(load_data(label))
                    .catch(response => {
                      // we don't really care about errors for reference / groundtruth outputs
                      if (label==='new' && !!response)
                        this.setState({error: response.data})
                    });
    }).map(f=>f()) )
    // now we loaded and parsed all the data
    .then( () => this.setState({
      is_loaded: true,
      tree: {
        ...this.state.tree,
        mixed: compareTrees(this.state.tree.new, this.state.tree.reference, {show_all_files: this.props.show_all_files})}
      })
    )
  }

}





export default BitAccuracyViewer;
