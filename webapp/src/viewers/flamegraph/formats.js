// The profile files the flame graph viewer reads, detected from their content, with the file name as a hint:
// - folded stacks, `frame;frame;frame value` per line: stackcollapse-*.pl, inferno, py-spy --format raw,
//   async-profiler's collapsed output, qaboard.flamegraphs.save_flame_graph... A `# unit: bytes` line gives the unit.
// - speedscope JSON (py-spy --format speedscope, rbspy, many converters): sampled and evented profiles.
// - Chrome/V8 .cpuprofile (node --cpu-prof, Chrome DevTools).
// - a tree in d3-flame-graph's format, {name, value, children}, with inclusive values: QA-Board's *.flame.json.
// What browsers can't reasonably read, `perf script`'s text and pprof's protobuf, gets a message that says how to
// convert it with `qaboard.flamegraphs` (qaboard/flamegraphs.py).
// The files the web app opens with this viewer without a `type` in qaboard.yaml: is_flame_graph in ../OutputViewer.jsx.
import { childNamed, mergeTrees, newNode, parseUnit, sumValues } from './profile';

export class ProfileFormatError extends Error {}

const basename = path => {
  const clean = `${path || ''}`.replace(/[?#].*$/, '');
  return clean.slice(clean.lastIndexOf('/') + 1);
};

// A frame's name from a function and its file: "parse (gateway.py)". Lines are left out: they change from commit to
// commit, and frames are matched by name with the reference's.
const frameName = (name, file) => {
  const base = basename(file);
  return base ? `${name} (${base})` : name;
};


// ---------------------------------------------------------------------------- folded stacks
export const parseFolded = text => {
  const root = newNode('all');
  let unit;
  let start = 0;
  const length = text.length;
  // consecutive lines often share their first frames (files are sorted): we walk from the common prefix's node
  let previous_frames = [];
  let previous_nodes = [root];
  while (start < length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = length;
    let line = text.slice(start, end);
    start = end + 1;
    if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1); // \r\n
    if (line.charCodeAt(0) === 35) { // #
      const match = /^#\s*unit:\s*(.+?)\s*$/.exec(line);
      if (match && unit === undefined) unit = match[1];
      continue;
    }
    line = line.trimEnd();
    const space = Math.max(line.lastIndexOf(' '), line.lastIndexOf('\t'));
    if (space <= 0) continue;
    const value = Number(line.slice(space + 1));
    if (!Number.isFinite(value) || value === 0) continue;
    const frames = line.slice(0, space).trimEnd().split(';');
    let common = 0;
    while (common < frames.length && common < previous_frames.length && frames[common] === previous_frames[common]) common++;
    const nodes = previous_nodes.slice(0, common + 1);
    let node = nodes[common];
    for (let i = common; i < frames.length; i++) {
      node = childNamed(node, frames[i]);
      nodes.push(node);
    }
    node.self += value;
    previous_frames = frames;
    previous_nodes = nodes;
  }
  sumValues(root);
  return { format: 'folded', unit: unit ?? 'samples', profiles: [{ name: 'all', tree: root }] };
};


// ---------------------------------------------------------------------------- speedscope
// https://github.com/jlfwong/speedscope/wiki/Importing-from-custom-sources, file-format-schema.json
const parseSpeedscope = data => {
  const frames = (data.shared?.frames ?? []).map(f => frameName(f.name ?? '(anonymous)', f.file));
  const profiles = (data.profiles ?? []).map((profile, i) => {
    const root = newNode('all');
    if (profile.type === 'evented') {
      const stack = [root];
      let last = profile.startValue ?? profile.events?.[0]?.at ?? 0;
      for (const event of profile.events ?? []) {
        const elapsed = event.at - last;
        if (elapsed > 0 && stack.length > 1) stack[stack.length - 1].self += elapsed;
        last = event.at;
        if (event.type === 'O') {
          stack.push(childNamed(stack[stack.length - 1], frames[event.frame] ?? `frame ${event.frame}`));
        } else if (event.type === 'C' && stack.length > 1) {
          stack.pop();
        }
      }
    } else {
      // sampled: each sample is a stack of frame indexes, from the root
      const weights = profile.weights;
      (profile.samples ?? []).forEach((sample, j) => {
        let node = root;
        for (const index of sample) node = childNamed(node, frames[index] ?? `frame ${index}`);
        node.self += weights ? weights[j] ?? 0 : 1;
      });
    }
    // empty stacks are idle time, not a function's: they're not drawn
    root.self = 0;
    sumValues(root);
    return { name: profile.name || `Profile ${i + 1}`, unit: parseUnit(profile.unit ?? 'none').unit, tree: root };
  });
  if (!profiles.length) throw new ProfileFormatError('This speedscope file has no profiles.');
  return { format: 'speedscope', unit: profiles[0].unit, profiles, active: data.activeProfileIndex ?? undefined };
};


// ---------------------------------------------------------------------------- Chrome .cpuprofile
// {nodes: [{id, callFrame: {functionName, url, lineNumber}, children: [ids]}], startTime, endTime, samples: [ids],
//  timeDeltas: [µs]}. Each sample lasts until the next one, like in Chrome DevTools.
const parseCpuprofile = data => {
  const nodes = data.nodes ?? [];
  const by_id = new Map(nodes.map(n => [n.id, n]));
  const parent = new Map();
  for (const node of nodes) {
    for (const child of node.children ?? []) parent.set(child, node.id);
    if (node.parent !== undefined) parent.set(node.id, node.parent);
  }
  const root = newNode('all');
  const tree_nodes = new Map();
  const treeNode = id => {
    // iterative: up to the root, then down
    const path = [];
    let current = id;
    while (current !== undefined && !tree_nodes.has(current)) {
      path.push(current);
      current = parent.get(current);
    }
    let node = current === undefined ? root : tree_nodes.get(current);
    for (let i = path.length - 1; i >= 0; i--) {
      const { callFrame = {} } = by_id.get(path[i]) ?? {};
      const is_root = parent.get(path[i]) === undefined && callFrame.functionName === '(root)';
      if (!is_root) node = childNamed(node, frameName(callFrame.functionName || '(anonymous)', callFrame.url));
      tree_nodes.set(path[i], node);
    }
    return node;
  };
  const samples = data.samples ?? [];
  const deltas = data.timeDeltas ?? [];
  if (samples.length && deltas.length) {
    let time = data.startTime ?? 0;
    const times = samples.map((_, i) => (time += deltas[i] ?? 0));
    samples.forEach((id, i) => {
      const next = i + 1 < times.length ? times[i + 1] : (data.endTime ?? times[i]);
      treeNode(id).self += Math.max(0, next - times[i]);
    });
  } else {
    // older profiles: hit counts, spread over the profile's duration
    const hits = nodes.reduce((sum, n) => sum + (n.hitCount ?? 0), 0);
    const per_hit = hits && data.endTime > data.startTime ? (data.endTime - data.startTime) / hits : 1;
    for (const node of nodes) if (node.hitCount) treeNode(node.id).self += node.hitCount * per_hit;
  }
  sumValues(root);
  return { format: 'cpuprofile', unit: 'microseconds', profiles: [{ name: 'all', tree: root }] };
};


// ---------------------------------------------------------------------------- d3-flame-graph's JSON
// Inclusive values; siblings with the same name are merged, so that they match the reference's.
const parseTree = data => {
  const root = newNode(data.name ?? data.n ?? 'all');
  const stack = [[data, root]];
  while (stack.length) {
    const [source, node] = stack.pop();
    const children = source.children ?? source.c ?? [];
    const value = source.value ?? source.v ?? 0;
    const children_value = children.reduce((sum, c) => sum + (c.value ?? c.v ?? 0), 0);
    node.self += Math.max(0, value - children_value);
    for (const child of children) stack.push([child, childNamed(node, `${child.name ?? child.n ?? ''}`)]);
  }
  sumValues(root);
  return { format: 'json', unit: 'samples', profiles: [{ name: root.name, tree: root }] };
};


// ---------------------------------------------------------------------------- detection
const PERF_SCRIPT = /^\S.*?\s+\d+(\/\d+)?\s.*:\s*(\d+\s+)?\S+:\s*$[\r\n]+^\s+[0-9a-f]+\s+\S/m;

// path: a hint, the content decides
export const detectFormat = (text, path = '') => {
  const start = text.slice(0, 4096).trimStart();
  // folded stacks can start with a bracket: "[unknown];main 3", "[kernel.kallsyms];do_syscall_64 1"
  const folded_bracket = /^\[[^\s",[\]{}]+\](;|\s+[\d.e+]+\s*$)/.test(start.split('\n', 1)[0]);
  if ((start.startsWith('{') || start.startsWith('[')) && !folded_bracket) {
    if (/speedscope/.test(start.slice(0, 400)) || /"shared"\s*:/.test(start)) return 'speedscope';
    if (/"callFrame"\s*:/.test(start) || /\.cpuprofile$/i.test(path)) return 'cpuprofile';
    return 'json';
  }
  // pprof's protobuf: binary, and its first field is usually its sample types (0x0a)
  let binary = false;
  for (let i = 0; i < Math.min(512, text.length) && !binary; i++) {
    const code = text.charCodeAt(i);
    binary = code < 9 || code === 0xFFFD;
  }
  if (binary && (text.charCodeAt(0) === 0x0a || /\.(pb|pprof)(\.gz)?$/i.test(path))) return 'pprof';
  if (binary) return 'binary';
  if (PERF_SCRIPT.test(text.slice(0, 65536))) return 'perf-script';
  return 'folded';
};

const HELPER = 'qaboard.flamegraphs.save_flame_graph';

// {format, unit, note, profiles: [{name, unit, tree}], active}: speedscope files can have several profiles (threads)
// Larger files would take seconds and gigabytes to show: 300,000 stacks are about 45 MB, read in half a second.
export const MAX_PROFILE_LENGTH = 200e6;

export const parseProfile = (text, path = '', { unit: unit_option } = {}) => {
  if (text.length > MAX_PROFILE_LENGTH)
    throw new ProfileFormatError(`The profile is too large to show (${Math.round(text.length / 1e6)} MB, the viewer reads up to ${MAX_PROFILE_LENGTH / 1e6} MB): save fewer stacks, e.g. without the thread ids, or merge the smallest ones.`);
  const format = detectFormat(text, path);
  let profile;
  if (format === 'perf-script')
    throw new ProfileFormatError(`This is the text of \`perf script\`: in your run, save it as folded stacks with ${HELPER}(output_dir / "cpu.folded", "perf.script.txt").`);
  if (format === 'pprof')
    throw new ProfileFormatError(`This is a pprof profile: in your run, save it as folded stacks with ${HELPER}(output_dir / "cpu.folded", "cpu.pb.gz").`);
  if (format === 'binary')
    throw new ProfileFormatError('This is a binary file, not a profile the viewer reads: folded stacks, speedscope, .cpuprofile or {name, value, children}.');
  if (format === 'folded') {
    profile = parseFolded(text);
  } else {
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new ProfileFormatError(`Not a profile: ${error.message}`);
    }
    if (format === 'speedscope') profile = parseSpeedscope(data);
    else if (format === 'cpuprofile' || Array.isArray(data?.nodes)) profile = parseCpuprofile(data);
    else if (data && typeof data === 'object' && !Array.isArray(data)) profile = parseTree(data);
    else throw new ProfileFormatError('Not a profile: expected folded stacks, speedscope, .cpuprofile or {name, value, children}.');
  }
  const { unit, note } = parseUnit(unit_option ?? profile.unit);
  return { ...profile, unit, note };
};

// The tree to show: one of the profiles, or all of them merged (default). Speedscope files from py-spy have one
// profile per thread, named after their ids: those change between runs, so we don't keep them in the stacks.
export const selectTree = (profile, which = 'all') => {
  if (!profile) return undefined;
  const { profiles } = profile;
  if (profiles.length === 1) return profiles[0].tree;
  if (which !== 'all' && profiles[which]) return profiles[which].tree;
  const same_unit = profiles.filter(p => p.unit === profiles[0].unit);
  return mergeTrees(same_unit.map(p => p.tree));
};

// gzip-compressed files (*.folded.gz) are decompressed, unless the server already did (Content-Encoding)
export const decodeProfileBytes = async buffer => {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
};
