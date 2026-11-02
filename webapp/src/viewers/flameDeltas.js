// Differential flame graphs: the trees are {name, value, children} with inclusive values (a node's own samples plus
// its children's), and nodes are matched between the new and the reference profile by their path of names.

// Walks the tree depth first, starting with the root, giving each node its path of names as id
export const forEachInTree = (tree, callback, id) => {
  if (tree === undefined || tree === null)
    return;
  const current_id = `${id ?? ''}/${tree.name}`
  callback(tree, current_id)
  if (tree.children === undefined || tree.children === null) {
    return;
  }
  tree.children.forEach(t => {
    forEachInTree(t, callback, current_id);
  })
}

// A node's value without its children's
export const selfValue = node => {
  if (!node)
    return 0
  const children = (node.children ?? []).reduce((sum, child) => sum + (child.value || 0), 0)
  return (node.value || 0) - children
}

// How much more time the node takes by itself than the reference node (missing: 0). d3-flame-graph's computeDelta
// adds up the children's deltas to each node's, so its inclusive delta comes out right.
export const selfDelta = (node, reference) => selfValue(node) - selfValue(reference)
