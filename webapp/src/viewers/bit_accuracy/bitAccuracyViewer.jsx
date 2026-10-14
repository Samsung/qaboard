import { useMemo, useState } from "react";

import { Tree, Classes, Colors, Tag, Icon, Popover, Menu, MenuItem, Tooltip } from "@blueprintjs/core";
import { OutputViewer } from "../OutputViewer"
import { preloadMonaco } from "../../components/MonacoEditor"
import { getNodeById, forEachNode, visitDepthFirst, copyNodeData, filterNodes, updateMissingFrom, humanFileSize } from "./utils"
import { bitAccuracyChecker, markChecked, bitAccuracySummary } from "./checked"
import { match_query, is_same_data } from "../../utils"


// Turns a flat file manifest into a proper tree
const to_tree = filepaths => {
  if (filepaths === undefined || filepaths === null)
    return []

  const tree = []
  const nodes = new Map() // id => node, so that we find parents quickly
  for (const [filepath, meta] of Object.entries(filepaths)) {
    const parts = filepath.split('/')
    let parent = tree
    let path = []
    for (let i = 0; i < parts.length; i++) {
      const id = parts.slice(0, i+1).join('/')
      let node = nodes.get(id)
      if (node === undefined) {
        node = {
          id,
          label: parts[i],
          path: [...path, parent.length],
          childNodes: [],
          nodeData: {...meta},
        }
        parent.push(node)
        nodes.set(id, node)
      }
      // the last node is a file
      if (i === parts.length - 1)
        node.childNodes = undefined
      parent = node.childNodes
      path = node.path
    }
  }
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
      node.nodeData.match = is_same_data(node.id, node.nodeData, node_reference.nodeData)
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

const applyStyle = (has_reference, color_blind_friendly, output_new, output_ref) => node => {
    const { match, missing_from_reference, missing_from_new, checked } = node.nodeData;
    const is_folder = node.childNodes !== undefined;
    // files that bit_accuracy.patterns don't check (and folders with only those) are greyed
    if (!checked)
      node.className = Classes.TEXT_MUTED;

    let color = Colors.GREY1;
    if (is_folder) {
      // console.log(node.id, node, !match, missing_from_new, missing_from_reference)
      if (has_reference && checked) {
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
    if (node.id.match(/(hex|png|bmp|raw|jpg|jpeg|mp4|imgprops)$/)) {
      icon = 'media'
    } else if (node.id.match(/\.(xml|html)$/)) {
      icon = 'code'
    } else if (node.id.match(/(\.cde|set|\.yaml|\.yml)$/)) {
      icon = 'numerical'
    } else if (node.id.match(/\.(bat|sh|exe|ps1)$/)) {
      icon = 'console'
    } else if (node.id.match(/\.plotly.json$/)) {
      icon = 'timeline-line-chart'
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

    if (!checked) {
      color = Colors.GRAY4;
    } else if (has_reference) {
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
    
    // Create download menu for files - only show available files
    const downloadMenu = (
      <Menu>
        {output_new && !missing_from_new && (
          <MenuItem
            icon="download"
            text="Download (New)"
            onClick={() => {
              const downloadUrl = `${output_new.output_dir_url}/${node.id}`;
              window.open(downloadUrl, '_blank');
            }}
          />
        )}
        {output_ref && !missing_from_reference && (
          <MenuItem
            icon="download"
            text="Download (Reference)"
            onClick={() => {
              const downloadUrl = `${output_ref.output_dir_url}/${node.id}`;
              window.open(downloadUrl, '_blank');
            }}
          />
        )}
        {has_size && (
          <>
            <MenuItem disabled text={`Size: ${size_human} (${size_real} B)`} />
          </>
        )}
      </Menu>
    );

    // Check if any download options are available
    const hasDownloadOptions = (output_new && !missing_from_new) || (output_ref && !missing_from_reference);
    
    const sizeLabel = (
      <span 
        className={Classes.TEXT_MUTED} 
        style={{ 
          cursor: hasDownloadOptions ? 'pointer' : 'default',
          display: 'flex',
          alignItems: 'center',
          gap: '4px'
        }}
      >
        {size_human}
        {hasDownloadOptions && (
          <Icon 
            icon="download" 
            size={10}
            style={{ 
              opacity: 0.6
            }}
          />
        )}
      </span>
    );

    const size = hasDownloadOptions ? (
      <Popover
        content={downloadMenu}
        placement="right"
        interactionKind="hover"
        hoverCloseDelay={200}
      >
        {sizeLabel}
      </Popover>
    ) : sizeLabel;
    node.secondaryLabel = checked ? size : <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <Tooltip content="Not checked for bit-accuracy: see bit_accuracy.patterns in qaboard.yaml">
        <Tag minimal>not checked</Tag>
      </Tooltip>
      {size}
    </span>;
}



// Compares the files of the new and reference outputs.
// NOTE: it modifies the trees, callers give us trees they just built from the manifests
const mergeTrees = (tree_new, tree_ref, { files_filter, show_all_files, output_new, output_ref, color_blind_friendly, bit_accuracy }) => {
  if (tree_new === null || tree_new === undefined)
    return { mixed: [] }

  let tree_compared = tree_new
  // find the nodes that are missing in the reference tree
  visitDepthFirst(tree_compared, updateMissingFrom(tree_ref, 'reference'))

  visitDepthFirst(tree_ref, updateMissingFrom(tree_compared, 'new'))
  visitDepthFirst(tree_ref, copyNodeData(tree_ref, tree_compared, 'missing_from_new'))
  // now need to update missing recursevely up!
  visitDepthFirst(tree_compared, updateMissingFrom(tree_compared, 'new'))

  // find match / mismatches
  visitDepthFirst(tree_compared, updateMatch(tree_ref))
  // only the files matching bit_accuracy.patterns count, like `qa check-bit-accuracy`
  markChecked(tree_compared, bitAccuracyChecker(bit_accuracy))
  const summary = bitAccuracySummary(tree_compared)

  const has_filter = !!files_filter && files_filter.length > 0;
  if (!show_all_files && !has_filter) {
    tree_compared = filterNodes(tree_compared, node => node.nodeData.differs)
    tree_compared = tree_compared.filter(node => node.id !== 'logs.txt')
  }
  if (has_filter) {
    const matcher = match_query(files_filter)
    tree_compared = filterNodes(tree_compared, node => {
      let state = node.nodeData.match ? 'match' : 'diff'
      return matcher(`${state}:${node.id}`) || (node.childNodes !== undefined && node.childNodes.length > 0)
    })
  }

  // sort by alphebetical order
  forEachNode(tree_compared, sortChildren)
  // the root is a "chilNodes" array, not a real root...
  tree_compared = tree_compared.sort( (a, b) => a.label.localeCompare(b.label) )

  const has_ref = tree_ref !== null && tree_ref !== undefined
  forEachNode(tree_compared, applyStyle(has_ref, has_ref && color_blind_friendly, output_new, output_ref))
  return { mixed: tree_compared, summary };
}


// What users selected and expanded, applied to a copy of the tree
const decorate = (nodes, { is_expanded, selected }) => nodes?.map(node => {
  const is_folder = node.childNodes !== undefined;
  const isExpanded = is_folder && is_expanded(node);
  return {
    ...node,
    isExpanded,
    isSelected: selected.includes(node.id),
    icon: is_folder ? <Icon {...node.icon.props} icon={isExpanded ? 'folder-open' : 'folder-close'}/> : node.icon,
    childNodes: decorate(node.childNodes, { is_expanded, selected }),
  };
})


const BitAccuracyViewer = props_ => {
  const { type: _type, ...props } = props_;
  const { manifests, files_filter, show_all_files, hide_runs_without_files, expand_all, color_blind_friendly, output_new, output_ref, config } = props_;
  const bit_accuracy = config?.bit_accuracy;
  const [selected, setSelected] = useState([]);
  // folders users expanded (true) or collapsed (false)
  const [expanded, setExpanded] = useState({});

  const { mixed: tree, summary } = useMemo(() => {
    if (!manifests) return { mixed: [] };
    return mergeTrees(
      manifests.new ? to_tree(manifests.new) : undefined,
      manifests.reference ? to_tree(manifests.reference) : undefined,
      { files_filter, show_all_files, output_new, output_ref, color_blind_friendly, bit_accuracy },
    );
  }, [manifests, files_filter, show_all_files, output_new, output_ref, color_blind_friendly, bit_accuracy]);
  const { bit_accurate } = summary ?? {};

  const has_filter = !!files_filter && files_filter.length > 0;
  const contents = useMemo(() => decorate(tree, {
    is_expanded: node => expanded[node.id] ?? (!!expand_all || has_filter),
    selected,
  }), [tree, expanded, expand_all, has_filter, selected]);

  const handleNodeClick = (node, _nodePath, e) => {
    const is_folder = node.childNodes !== undefined;
    if (is_folder) return;
    const was_selected = selected.includes(node.id);
    const kept = (e.shiftKey || e.ctrlKey) ? selected : [];
    setSelected(was_selected ? kept.filter(id => id !== node.id) : [...kept, node.id]);
  };
  const handleNodeCollapse = node => setExpanded(expanded => ({ ...expanded, [node.id]: false }));
  const handleNodeExpand = node => setExpanded(expanded => ({ ...expanded, [node.id]: true }));

  const has_files = tree.length !== 0
  return <div className={(!has_files && hide_runs_without_files) ? "viewer-no-files" : undefined}>
    {bit_accurate && <Tag style={{marginBottom: '5px'}}>Bit-accurate</Tag>}
    {!has_files && !bit_accurate && <em className={Classes.TEXT_MUTED}>all files filtered</em>}
    <Tree
     contents={contents}
     onNodeClick={handleNodeClick}
     // most files show in a text editor: load it before the click
     onNodeMouseEnter={node => { if (node.childNodes === undefined) preloadMonaco() }}
     onNodeCollapse={handleNodeCollapse}
     onNodeExpand={handleNodeExpand}
    />
    {selected.map( filename => {
      const has_same_data = is_same_data(filename, manifests?.new?.[filename], manifests?.reference?.[filename])

      // For new side: fallback if file doesn't exist
      let filename_new = filename
      if (filename.match(/\.tiff?$/i)) {
        // TIFF clicked but doesn't exist in new - try PNG fallback
        if (!manifests?.new?.[filename]) {
          const pngPath = filename.replace(/\.tiff?$/i, '.png')
          if (manifests?.new?.[pngPath]) {
            filename_new = pngPath
          }
        }
      }

      // For ref side: fallback if file doesn't exist
      let filename_ref = filename
      if (filename.endsWith('.png')) {
        // PNG clicked but doesn't exist in ref - try TIFF then BMP
        if (!manifests?.reference?.[filename]) {
          const tiffPath = filename.replace(/\.png$/i, '.tiff')
          if (manifests?.reference?.[tiffPath]) {
            filename_ref = tiffPath
          } else {
            const bmpPath = filename.replace(/.png$/, '.bmp')
            if (manifests?.reference?.[bmpPath]) {
              filename_ref = bmpPath
            }
          }
        }
      } else if (filename.match(/\.tiff?$/i)) {
        // TIFF clicked but doesn't exist in ref - try PNG fallback
        if (!manifests?.reference?.[filename]) {
          const pngPath = filename.replace(/\.tiff?$/i, '.png')
          if (manifests?.reference?.[pngPath]) {
            filename_ref = pngPath
          }
        }
      }

      return <div key={filename}>
        {has_same_data && <Tag style={{marginTop: "5px"}} key={`same-${filename}`} minimal icon="duplicate">same-data</Tag>}
        <OutputViewer
            key={filename}
            path={filename_new}
            path_ref={filename_ref}
            max_lines={30}
            {...props}
        />
      </div>
    })}

  </div>
}


export default BitAccuracyViewer;
