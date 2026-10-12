# serving-latency: the inference gateway (`kitefin/inference-gateway`)

## Purpose
- **Shows:** performance engineering on QA-Board. Tail latency as distributions, not one number; flame graph diffs;
  History to find the commit that regressed; a tuning sweep and its efficient frontier; the experimental gate failing
  on p99.
- **Audience:** backend and performance engineers, and anyone reviewing "it's faster" claims, including ones made by
  coding agents.
- **Phase 2.** It is also the end-to-end test of the quality gate (WS9): the story has a commit where the gate must
  fail on p99, and a fix where it must pass.

Generic inference serving: queueing, batching, workers, caching. Not network tuning: there are no TCP options here.

## What the code computes
A Rust crate, `gateway/`, builds one binary, `gateway-bench`, that runs the gateway and an open-loop load generator in
one process, connected by in-memory channels (no network). `qa/main.py` runs it, then turns its raw outputs into
metrics and visualizations (plain JSON, no plotting library).

**Gateway**
- **Ingress** (2 threads): receives requests, looks up the result cache, enqueues misses with a deadline
  (arrival + 12 ms).
- **Queue and batcher** (1 thread): a bounded queue (4,096). Policy `fifo`, `lifo`, `edf` (earliest deadline first) or
  `drop-late` (drop requests already past their deadline). Batches close at `max_batch` requests or `max_delay_us`
  after their first request.
- **Workers** (`workers` threads): run the "model" on a batch, insert results in the cache, complete the requests.
- **Model:** a 2-layer MLP, 256 → 1024 → 256 with ReLU, per token of the payload. `int8` (i32 accumulation) or
  `fp32`. Weights are generated from a fixed seed. Sized so the default configuration saturates around 7,000
  requests/s on a 4-CPU CI runner.
- **Result cache:** `none`, `shared` (one `Mutex<LruCache>`; the LRU update and the clone of the 4 KB response happen
  under the lock) or `sharded` (`cache_shards` independent LRUs, by key hash).

**Load generator** (open loop, no coordinated omission)
- The arrival schedule and the payloads are generated from the input's profile and seed before the run.
- Requests are sent at their scheduled time whether or not earlier ones completed. Latency = completion time −
  *scheduled* send time, recorded in an HDR histogram (1 µs to 10 s, 3 significant digits).
- Each run does 2 or 3 repeats (1 s warmup, then 3-4 s measured, see Batches), each with a fresh gateway and a seed
  derived from the run's.
  Reported percentiles are the median over repeats; `p99_spread` says how much they disagree.
- Also recorded: per-request time in queue, waiting for the batch, waiting for the cache lock, and computing; queue
  depth and percentiles per 100 ms; per-core CPU use from `/proc/stat` every 100 ms; batch sizes; CPU samples with
  [pprof-rs](https://github.com/tikv/pprof-rs) (Apache-2.0) at 997 Hz on all threads during the measured windows.

**Flags** (`build/flags.json`; defaults are the head of `main` at T0):

| Flag | Values | Default |
|---|---|---|
| `workers` | 1-3 (the load generator keeps a core) | `3` |
| `batching` | `none`, `dynamic` | `dynamic` |
| `max_batch` | 1-64 | `16` |
| `max_delay_us` | 0-5000 | `250` |
| `queue_policy` | `fifo`, `lifo`, `edf`, `drop-late` | `edf` |
| `allocator` | `system`, `jemalloc`, `mimalloc` (one binary per cargo feature) | `mimalloc` |
| `pin` | `none`, `workers` (workers on cores 1-3, load generator on 0) | `workers` |
| `model_dtype` | `fp32`, `int8` | `int8` |
| `cache` | `none`, `shared`, `sharded` | `sharded` |
| `cache_entries`, `cache_shards` | | `16384`, `16` |
| `batch_buffer` | `alloc`, `reuse` | `reuse` |
| `payload_copy` | `true` copies payloads into the batch buffer instead of borrowing them | absent |
| `bug_batch_overflow` | `true` makes the batcher write past a full batch (a real panic) | absent |

Tuning parameters (`--tuning-search`) override flags of the same name for that run, so sweeps don't need commits.

## Inputs
All generated, ours. `qa/make_profiles.py` writes `inputs/profiles/<profile>-<level>.yaml` (deterministic). Each file
gives the arrival process, the request rate, the payload size distribution and the key distribution:

| Profile | Arrivals | Payload tokens | Keys |
|---|---|---|---|
| `steady` | Poisson | 8 | Zipf(1.1) over 100,000 keys |
| `bursty` | On/off (Markov-modulated Poisson): 5x the rate for 200 ms, every 2 s on average | 8 | same |
| `heavy-tail` | Poisson | Pareto (α = 1.3), 1 to 256 | same |
| `ramp` | Poisson, rate from 20% to 120% of `high` in 10 steps of 0.5 s | 8 | same |

Levels: `low` 2,000, `mid` 4,000, `high` 6,000 requests/s; fixed numbers, so a commit that changes capacity shows up as
a change, not as a different test. No downloads, no licenses to track.

## Metrics (`qa/metrics.yaml`)

| Key | Label | Unit (`suffix`, `scale`) | `smaller_is_better` | `target` |
|---|---|---|---|---|
| `latency_p50` | Latency p50 | ` ms` | true | 3 |
| `latency_p90` | Latency p90 | ` ms` | true | |
| `latency_p99` | Latency p99 | ` ms` | true | 12 |
| `latency_p999` | Latency p99.9 | ` ms` | true | 25 |
| `latency_max` | Latency max | ` ms` | true | |
| `throughput` | Throughput | ` req/s` | false | |
| `goodput` | Goodput (≤ 12 ms) | ` req/s` | false | |
| `slo_miss` | Requests over 12 ms | `%`, scale 100 | true | 0.01 |
| `dropped` | Dropped | `%`, scale 100 | true | 0 |
| `p99_spread` | p99 spread over repeats | `%`, scale 100 | true | 0.10 |
| `cpu_per_req` | CPU per request | ` µs` | true | |
| `lock_wait_p99` | Cache lock wait p99 | ` ms` | true | |
| `cache_hit` | Cache hit rate | `%`, scale 100 | false | |
| `batch_mean` | Mean batch size | | false | |
| `is_failed` | Crashed | `%`, scale 100 | true | 0 |

`default_metric: latency_p99`; `summary_metrics: [latency_p99, latency_p50, throughput, cpu_per_req]`;
`main_metrics: [latency_p50, latency_p99, latency_p999, throughput, slo_miss]`. Latencies are stored in ms.

Gate rules in *qaboard.yaml* (experimental, WS9): `{metric: latency_p99, max_regression: 10%}`,
`{metric: throughput, max_regression: 5%}`, `max_failed_runs: 0`, on batch `ci`.

## Visualizations (`qaboard.yaml`)

```yaml
outputs:
  metrics: qa/metrics.yaml
  visualizations:
    - name: Latency percentiles (log tail)
      path: latency_cdf.plotly.json    # x: 1/(1-p) on a log axis labeled 50% 90% 99% 99.9% 99.99%; y: ms, log
      side_by_side: false              # overlay: the reference is drawn dashed and faded
    - name: Where the time goes
      path: breakdown.plotly.json      # stacked bars at p50/p90/p99/p99.9: queue, batch wait, lock wait, compute
                                       # side by side (the default): stacked bars can't be overlaid
    - name: Latency over time
      path: timeline.plotly.json       # p50, p99 and max per 100 ms, queue depth on a second axis
    - name: Throughput vs p99
      path: sweep.plotly.json          # ramp runs only: achieved req/s vs p99, one point per step
      side_by_side: false
    - name: CPU flame graph
      path: cpu.flame.json
    - name: CPU per core
      path: cores.plotly.json          # heatmap, cores x time, % busy
      default_hidden: true
    - name: Batch sizes
      path: batch_sizes.plotly.json    # histogram
      side_by_side: false
      default_hidden: true
    - name: Latency histogram
      path: latency_hist.plotly.json   # log-spaced bins
      side_by_side: false
      default_hidden: true
    - name: Percentiles
      path: percentiles.txt            # HdrHistogram's percentile distribution text, for text diffs
      default_hidden: true
```

- Plotly traces set `line.color` explicitly: with `side_by_side: false`, the web app then draws the reference dashed
  and faded (`webapp/src/viewers/plotly.jsx`). Runs without a file (only `ramp` has `sweep.plotly.json`) hide that
  visualization.
- **`cpu.flame.json`** is the [d3-flame-graph](https://github.com/spiermar/d3-flame-graph) JSON the viewer reads
  (`webapp/src/viewers/flame-graph.jsx`): a tree of `{"name": str, "value": int, "children": [...]}`.
  - `value` is inclusive: a node's own samples plus its children's.
  - The viewer matches new and reference nodes by their path of names, so names must be stable: demangled Rust
    symbols without the hash suffix (`gateway::cache::Shared::get`), no addresses; siblings with the same name are
    merged; thread names lose their index (`worker-2` → `worker`), and are the root's children.
  - The viewer subtracts raw values, so `value` is CPU time in µs **per 1,000 requests** (samples × 10⁶ / 997 ÷
    requests × 1,000, rounded), comparable across runs of different lengths.
  - Nodes under 0.1% of the root are folded into their parent; the file stays under 1 MB.

## Batches (`qa/batches.yaml`)

| Batch | Runs | Time on a 4-CPU runner |
|---|---|---|
| `ci` | `steady-mid`, `steady-high`, `bursty-high`, `heavy-tail-high`; 2 repeats of 1 s + 3 s | ~40 s |
| `capacity` | `ramp` | ~15 s |
| `nightly` | all 12 profile × level inputs and `ramp`, 3 repeats of 1 s + 4 s | ~3.5 min |
| `sweep-batching` | `steady-high`, `heavy-tail-high`, 1 repeat each; meant for `--tuning-search` | 2 inputs × 4 s per combination |

Runs execute one at a time (`runners.local.concurrency: 1`): parallel runs would measure each other.

## Story (`story.yaml`)
About 30 commits over 6 weeks. Commit ids in **bold** are the ones checks and shots use.

| When | Branch | Author | Change (flags) | Shows |
|---|---|---|---|---|
| -41d | `main` | adaeze | **`dyn-batching`**: `batching: dynamic` | |
| -38d | `main` | kaito | **`int8`**: `model_dtype: int8` | CPU per request −30% or more |
| -36d | `main` | kaito | `pin: workers` | small p99 gain |
| -34d | `main` | kaito | **`v2-3-0`**: `batch_buffer: reuse` | milestone `v2.3.0` |
| -31d to -28d | `perf/allocators` | kaito | `allocator: jemalloc`, then `mimalloc`; merged | heavy-tail p99 −8% or more |
| -29d to -24d | `gateway/queue-policy` | adaeze | `queue_policy: edf`; merged | bursty p99.9 −15% or more |
| -27d | `main` | kaito | **`batch-overflow`**: `bug_batch_overflow: true`; **`batch-overflow-fix`** 3 h later | `bursty-*` runs crash with a panic |
| -20d | `agent/result-cache` | agent | **`cache-shared`**: `cache: shared, cache_entries: 4096` | p50 −10% or more; p99 +30% or more (target +45%); lock frames in the flame graph; gate fails |
| -19d | `agent/result-cache` | agent | `cache_entries: 16384` | still failing: History shows it |
| -15d | `perf/sharded-cache` | kaito | **`cache-sharded`**: `cache: sharded, cache_shards: 16`; then the `tune-batching` sweep (`max_batch` × `max_delay_us`, 30 combinations) | p99 back within 5% of `batch-overflow-fix`, p50 gain kept; gate passes |
| -14d | `main` | adaeze | **`merge-sharded-cache`** | |
| -13d | `main` | adaeze | **`v2-4-0`**: release commit, no change | milestone `v2.4.0` |
| -9d | `main` | kaito | **`payload-copy`**: `payload_copy: true` ("simpler lifetimes") | `heavy-tail-high` p99 +25% or more while the median over `ci` tests moves less than 10%: a regression only History's per-test lines show |
| -3d | `main` | kaito | **`payload-borrow`**: `payload_copy: null` | `heavy-tail-high` back within 5% of `v2-4-0` |
| -0d 13:20 | `main` | kaito | **`tuned-batching`**: `max_batch: 16, max_delay_us: 250` | goodput +5% or more; `nightly` still running at T0 (60% done, 2 running) |

`defaults.flags` is the state before the story: `batching: none, model_dtype: fp32, pin: none, allocator: system,
queue_policy: fifo, cache: none, batch_buffer: alloc, workers: 3`.

Fillers (refactors, docs, CI tweaks) keep their parent's flags and run `ci`: their noise is what real History looks
like. The excerpt in [STORY.md](../STORY.md) is this story's skeleton.

**Checks:** the "Shows" column, as `checks` (thresholds there), plus two hooks in `story_checks.py`:
`flame_share` (frames matching `lock_contended|lock_slow` take at least 8% of the root in `cache-shared`'s
`steady-high` run, and less than 1% in its parent's) and `on_frontier` (in `tune-batching`, `max_batch 16,
max_delay_us 250` is on the throughput/p99 Pareto frontier).

**Milestones:** `v2.3.0` on `v2-3-0`, `v2.4.0` on `v2-4-0`, by adaeze.

**Logs worth showing:** under overload the gateway logs `WARN queue depth 3,812 > 3,072` and
`ERROR request 18233 missed its deadline by 41 ms`, so the log viewer has errors to count and jump to. CI batches list
their `qa batch ci` command with a link to `https://ci.kitefin.example/...`.

## Determinism and budget
- Schedules, payloads and keys are deterministic per input and seed; everything measured varies. Captures use the
  snapshot, and checks have margins (a 30% threshold for a 45% effect).
- `cargo build --release` once per stack image (cached); every commit uses the same binaries, its flags select the
  behavior.
- The whole story: ≤ 40 min on a 4-CPU runner (about 30 `ci` batches, `capacity` on the 6 commits the shots compare,
  `nightly` on the two releases and the last commit, one sweep), with nothing else running. It is the longest story.
- Dependencies: Rust stable; crates `hdrhistogram`, `pprof`, `core_affinity`, `tikv-jemallocator`, `mimalloc`, `lru`
  (all MIT or Apache-2.0). Python: standard library only.

## Shots it must make possible
`cli/gate`, `ci/step-summary`, `commits/feed`, `commits/branch-evolution`, `commits/filter`, `commit/latency-cdf`,
`commit/throughput-p99`, `commit/flame-diff`, `commit/core-heatmap`, `commit/text-diff`, `commit/run-menu`,
`logs/crash`, `logs/live-tail`, `logs/batch-commands`, `history/performance-over-time`, `history/find-regression`,
`history/relative`, `tuning/frontier`, `files/browser`, `files/runbar`, `files/hotkeys`, `files/keyboard`.

`logs/live-tail` needs a run that is really running while it records: the spec starts a `ramp` run of
`tuned-batching` through the stack right before recording.
