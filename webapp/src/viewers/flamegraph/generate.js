// Generated profiles for the flame graph playground (/flame-graph-viewer.html) and the performance tests: folded
// stacks of an inference gateway, the new one differing from the reference in known ways:
// - the workers respond under a shared cache's lock: `<gateway::cache::Shared>::respond` is new, 9% of the profile,
//   with `lock_contended` (5%), and replaces `<gateway::cache::Sharded>::get` (5% of the reference),
// - the model runs less (cache hits skip it): `gateway::model::forward` is 31% of the profile instead of 45%,
// - `json::escape` takes twice the share: 12.5% instead of 6%,
// - `legacy::checksum` is gone (only in the reference),
// - the new profile has 20% more samples: compare shares, not absolute values.
// `stacks` sets how many distinct stacks there are (the leaves get numbered helpers to get there).

// A small deterministic random generator (mulberry32), so that both profiles share their shape
const random = seed => () => {
  seed |= 0;
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const WORKER = 'worker;gateway::gateway::worker';
const BRANCHES = [
  // [stack, share in the reference, share in the new profile]
  [`${WORKER};gateway::batcher::next_batch;gateway::model::forward;gateway::model::dense_int8;gateway::model::dot_i8`, 0.30, 0.20],
  [`${WORKER};gateway::batcher::next_batch;gateway::model::forward;gateway::model::softmax`, 0.15, 0.10],
  [`${WORKER};<gateway::cache::Sharded>::get;gateway::cache::hash`, 0.05, 0.0],
  [`${WORKER};<gateway::cache::Shared>::respond;std::sync::Mutex::lock;lock_contended`, 0.0, 0.05],
  [`${WORKER};<gateway::cache::Shared>::respond;gateway::response::render;json::serialize;json::escape`, 0.0, 0.04],
  [`${WORKER};gateway::response::render;json::serialize;json::escape`, 0.06, 0.08],
  [`${WORKER};gateway::response::render;json::serialize;json::write_number`, 0.08, 0.08],
  [`${WORKER};gateway::response::render;legacy::checksum`, 0.04, 0.0],
  ['ingress;gateway::gateway::ingress;gateway::json::parse;gateway::json::parse_object;gateway::json::parse_string', 0.12, 0.14],
  ['ingress;gateway::gateway::ingress;gateway::batcher::enqueue;alloc::raw_vec::grow', 0.05, 0.07],
  ['batcher;gateway::batcher::run;gateway::batcher::edf::pop;core::slice::sort', 0.07, 0.09],
  ['batcher;gateway::batcher::run;std::thread::park;syscall', 0.08, 0.11],
];

export const generateFolded = ({ reference = false, stacks = 2000, samples, seed = 7 } = {}) => {
  const total = samples ?? (reference ? 50_000 : 60_000) * Math.max(1, stacks / 2000);
  const rand = random(seed);
  const shares = BRANCHES.map(([, ref, now]) => (reference ? ref : now));
  const sum = shares.reduce((a, b) => a + b, 0);
  const lines = [];
  const per_branch = Math.max(1, Math.round(stacks / BRANCHES.length));
  BRANCHES.forEach(([stack, ref, now]) => {
    const share = (reference ? ref : now) / sum;
    if (!share) return;
    // the branch's function itself takes 60% of its time
    const branch_total = Math.round(total * share);
    lines.push(`${stack} ${Math.round(branch_total * 0.6)}`);
    // the rest: 4 levels of numbered helpers under it, named after it (the same in both profiles), a distinct stack
    // each, to make large profiles
    const leaf = stack.slice(stack.lastIndexOf(';') + 1).replace(/^.*::/, '');
    let left = branch_total - Math.round(branch_total * 0.6);
    for (let i = 1; i < per_branch && left > 0; i++) {
      const helpers = [3, 2, 1, 0].map(d => `${leaf}_helper_${d}_${Math.floor(i / 23 ** d) % 23}`);
      const weight = i === per_branch - 1 ? left : Math.min(left, Math.max(1, Math.round((branch_total * 0.4 / per_branch) * (0.5 + rand()))));
      left -= weight;
      lines.push(`${stack};${helpers.join(';')} ${weight}`);
    }
  });
  return `# unit: samples\n${lines.join('\n')}\n`;
};
