"""
CPU samples (folded stacks) -> the d3-flame-graph JSON QA-Board's flame graph viewer reads: a tree of
{"name": str, "value": int, "children": [...]}, the thread kinds as the root's children.

- `value` is inclusive (the node's own CPU time plus its children's), in µs of CPU per 1,000 requests, so runs of
  different lengths and loads compare: the viewer subtracts the reference's values from the new ones, node by node.
- Nodes are matched between runs by their path of names: names are stable (no addresses, no hashes, no thread index).
- Nodes under 0.1% of the root are folded into their parent: the file stays small.
"""
import json

MIN_SHARE = 0.001


def read_folded(path):
    stacks = {}
    for line in path.read_text().splitlines():
        stack, _, count = line.rpartition(' ')
        if stack and count.isdigit():
            stacks[stack] = stacks.get(stack, 0) + int(count)
    return stacks


def tree(stacks, scale, root_name='gateway-bench'):
    """scale: what one sample is worth (µs per 1,000 requests)"""
    root = {'name': root_name, 'samples': 0, 'children': {}}
    for stack, count in stacks.items():
        node = root
        node['samples'] += count
        for frame in stack.split(';'):
            node = node['children'].setdefault(frame, {'name': frame, 'samples': 0, 'children': {}})
            node['samples'] += count
    minimum = root['samples'] * MIN_SHARE

    def build(node):
        children = [build(c) for c in sorted(node['children'].values(), key=lambda c: -c['samples']) if c['samples'] >= minimum]
        out = {'name': node['name'], 'value': round(node['samples'] * scale)}
        if children:
            out['children'] = children
        return out
    return build(root)


def write(folded_path, out_path, cpu_s, requests):
    """Returns the share of the root each thread kind takes, and the total value"""
    stacks = read_folded(folded_path)
    samples = sum(stacks.values())
    if not samples or not requests:
        out_path.write_text(json.dumps({'name': 'gateway-bench', 'value': 0}))
        return {}
    scale = cpu_s * 1e6 / samples / requests * 1000
    t = tree(stacks, scale)
    out_path.write_text(json.dumps(t, separators=(',', ':')))
    return t


def share(stacks, pattern):
    """The share of samples whose stack has a frame matching the regex"""
    import re
    regex = re.compile(pattern)
    total = sum(stacks.values())
    matching = sum(c for s, c in stacks.items() if any(regex.search(f) for f in s.split(';')))
    return matching / total if total else 0.0
