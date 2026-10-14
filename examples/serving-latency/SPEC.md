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
- **Queue and batcher** (1 thread): a bounded queue (4,096). Policy `fifo`, `lifo`, `edf` (earliest deadline first
  among the requests that can still make it; those already late go after them) or `drop-late` (drop requests already
  past their deadline). Batches close at `max_batch` requests or `max_delay_us`
  after their first request.
- **Workers** (`workers` threads): run the "model" on a batch, then answer each request: store its outputs in the
  cache and render its response.
- **Model:** a 2-layer MLP, 256 → H → 256 with ReLU, per token of the payload. `int8` (AVX2 `vpmaddwd`, i32
  accumulation) or `fp32` (FMA). Weights are generated from a fixed seed.
- **Responses:** JSON bodies with each token's strongest K outputs (indices and scores, about 5 KB for 8 tokens).
  Rendering them (float formatting) is about a quarter of a request's CPU.
- **Sized per machine:** the load levels are fixed numbers of requests/s, so how loaded the gateway is depends on the
  machine's speed, and the story's effects depend on how loaded it is. `gateway-bench --calibrate` (run once by
  `qa/build.py`, kept in `gateway/target/calibration.json`) measures the model and the rendering on one core and picks
  H and K so that, in the running gateway, an 8-token request costs about 250 µs of model and 110 µs of rendering: the
  gateway without cache saturates around 7,000 requests/s on any 4-CPU machine.
- **Result cache:** `none`, `shared` or `sharded`. It stores the model's outputs per key (16-bit fixed point, 4 KB for
  8 tokens), and every response goes through it: a hit at the ingress (`Cache::lookup`), the model's fresh outputs in
  a worker (`Cache::hold` for the batch, then `Cache::respond` for each request).
  - `shared` (the coding agent's design) is one `Mutex<LruCache>`. A worker locks it to look its batch up again
    (another worker may have answered a key since the ingress missed it: a key is never computed twice), and the guard
    lives until the batch is answered: the model runs, and every response is rendered, while it holds the lock. The
    ingress renders its hits under the lock too. However many workers there are, the gateway does one batch at a time.
  - `sharded` has `cache_shards` independent LRUs, by key hash, and holds nothing across a batch: the model runs
    without a lock, outputs are copied in or out of a shard under its lock, and rendered without one.

**Load generator** (open loop, no coordinated omission)
- The arrival schedule and the payloads are generated from the input's profile and seed before the run.
- Requests are sent at their scheduled time whether or not earlier ones completed. Latency = completion time −
  *scheduled* send time, recorded in an HDR histogram (1 µs to 60 s, 3 significant digits).
- Each run does 2 or 3 repeats (1 s warmup, then 3-4 s measured, see Batches), each with a fresh gateway and a seed
  derived from the run's.
  Reported percentiles are the median over repeats; `p99_spread` says how much they disagree.
- CPU per request: the CPU time of the gateway's threads in the measured window ÷ the requests answered in it (not
  the requests scheduled in it: past its capacity, the gateway answers those after the window).
- Also recorded: per-request time in queue, waiting for the batch, waiting for the cache lock, and computing; queue
  depth and percentiles per 100 ms; per-core CPU use from `/proc/stat` every 100 ms; batch sizes; how much of the time
  the shared cache's lock was held (`lock_busy`, in the log); CPU samples with
  [pprof-rs](https://github.com/tikv/pprof-rs) (Apache-2.0) at 997 Hz on all threads during the measured windows.

**Flags** (`build/flags.json`; defaults are the head of `main` at T0):

| Flag | Values | Default |
|---|---|---|
| `workers` | 1-3 (the load generator keeps a core) | `3` |
| `batching` | `none`, `dynamic` | `dynamic` |
| `max_batch` | 1-64 | `16` |
| `max_delay_us` | 0-5000 | `250` |
| `queue_policy` | `fifo`, `lifo`, `edf`, `drop-late` | `edf` |
| `allocator` | `system`, `jemalloc`, `mimalloc` (one binary for the 3, picked at startup: `$GATEWAY_ALLOCATOR`) | `mimalloc` |
| `pin` | `none`, `workers` (workers on cores 1-3, load generator on 0) | `workers` |
| `model_dtype` | `fp32`, `int8` | `int8` |
| `cache` | `none`, `shared`, `sharded` | `sharded` |
| `cache_entries`, `cache_shards` | | `16384`, `16` |
| `batch_buffer` | `alloc`, `reuse` | `reuse` |
| `payload_copy` | `true` copies payloads into the batch buffer instead of borrowing them: one slot per request, as long as the batch's longest payload, and the model runs on the padding too | absent |
| `bug_batch_overflow` | `true`: with a backlog (over 1,024 queued requests), the batcher writes past a full batch (a real panic) | absent |

Tuning parameters (`--tuning-search`) override flags of the same name for that run, so sweeps don't need commits.

## Inputs
All generated, ours. `qa/make_profiles.py` writes `inputs/profiles/<profile>-<level>.yaml` (deterministic). Each file
gives the arrival process, the request rate, the payload size distribution and the key distribution:

| Profile | Arrivals | Payload tokens | Keys |
|---|---|---|---|
| `steady` | Poisson | 8 | Zipf(0.9) over 100,000 keys |
| `bursty` | On/off (Markov-modulated Poisson): 5x the rate for 200 ms, every 2 s on average | 8 | same |
| `heavy-tail` | Poisson | Pareto (α = 1.3), 1 to 256 | same |
| `ramp` | Poisson, rate from 20% to 120% of `high` in 10 steps of 0.5 s | 8 | same |

9 profile × level inputs (`steady-low`... `heavy-tail-high`) and `ramp`.

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
    symbols without the hash suffix (`<gateway::cache::Shared>::respond`), no addresses; siblings with the same name
    are merged; thread names lose their index (`worker-2` → `worker`), and are the root's children.
  - The viewer subtracts raw values, so `value` is CPU time in µs **per 1,000 requests**, comparable across runs of
    different lengths: samples × (the process's CPU time in the measured windows ÷ samples) ÷ requests answered in
    them × 1,000. The profiler asks for 997 Hz, but the kernel's timer delivers fewer samples per CPU second:
    weighting each sample by the measured CPU time keeps the values right.
  - Sampling starts with the repeat (starting it costs a stall), and only the samples taken in the measured window
    count (counts at its end minus counts at its start).
  - Nodes under 0.1% of the root are folded into their parent; the file stays under 1 MB.

## Batches (`qa/batches.yaml`)

| Batch | Runs | Time on a 4-CPU runner |
|---|---|---|
| `ci` | `steady-low`, `steady-mid`, `steady-high`, `bursty-high`, `heavy-tail-high`; 2 repeats of 1 s + 3 s | ~45 s |
| `capacity` | `ramp` | ~15 s |
| `nightly` | all 9 profile × level inputs and `ramp`, 3 repeats of 1 s + 4 s | ~3 min |
| `sweep-batching` | `steady-high`, `heavy-tail-high`, 3 repeats of 1 s + 2 s; meant for `--tuning-search` | 2 inputs × 10 s per combination |

Runs execute one at a time (`runners.local.concurrency: 1`): parallel runs would measure each other.

## Story (`story.yaml`)
About 30 commits over 6 weeks. Commit ids in **bold** are the ones checks and shots use.

| When | Branch | Author | Change (flags) | Shows |
|---|---|---|---|---|
| -41d | `main` | adaeze | **`dyn-batching`**: `batching: dynamic` | |
| -38d | `main` | kaito | **`int8`**: `model_dtype: int8` | CPU per request −30% or more |
| -36d | `main` | kaito | `pin: workers` | |
| -34d | `main` | kaito | **`v2-3-0`**: `batch_buffer: reuse` | milestone `v2.3.0` |
| -31d to -28d | `perf/allocators` | kaito | `allocator: jemalloc`, then `mimalloc`; merged | (within noise: no check) |
| -29d to -24d | `gateway/queue-policy` | adaeze | `queue_policy: edf`; merged | (no check) |
| -27d | `main` | kaito | **`batch-overflow`**: `bug_batch_overflow: true`; **`batch-overflow-fix`** 3 h later | `bursty-*` runs crash with a panic |
| -20d | `agent/result-cache` | agent | **`cache-shared`** (from `batch-overflow-fix`): `cache: shared, cache_entries: 4096` | CPU per request −20% or more; `steady-high` p99 +30% or more (its lock saturates); the cache's frames (rendering under the lock) take 8% or more of the CPU profile; gate fails |
| -17d | `agent/result-cache` | agent | **`cache-entries`**: `cache_entries: 16384` | still failing: `steady-high` p99 +30% or more against `batch-overflow-fix` |
| -15d | `perf/sharded-cache` | kaito | **`cache-sharded`**: `cache: sharded, cache_shards: 16`; then the `tune-batching` sweep (`max_batch` 1, 16, 64 × `max_delay_us` 0, 250, 1,000, 4,000) | `steady-high` p99 back within 5% of `batch-overflow-fix`; `steady-mid` p50 −25% or more; gate passes; (16, 250 µs) on the sweep's frontier |
| -14d | `main` | adaeze | **`merge-sharded-cache`** | |
| -13d | `main` | adaeze | **`v2-4-0`**: release commit, no change | milestone `v2.4.0` |
| -9d | `main` | kaito | **`payload-copy`**: `payload_copy: true` ("simpler lifetimes") | `heavy-tail-high` p99 +25% or more and its CPU per request +15% or more; the steady tests' CPU per request within 10% |
| -3d | `main` | kaito | **`payload-borrow`**: `payload_copy: null` | `heavy-tail-high` p99 back within 40% of `v2-4-0` (a 3 ms p99 is noisy) |
| -0d 13:20 | `main` | adaeze | **`tuned-batching`**: `max_batch: 16, max_delay_us: 250` | `nightly` still running at T0 (60% done, 2 running) |

`defaults.flags` is the state before the story: `batching: none, model_dtype: fp32, pin: none, allocator: system,
queue_policy: fifo, cache: none, batch_buffer: alloc, workers: 3`.

Fillers (refactors, docs, CI tweaks) keep their parent's flags and run `ci`: their noise is what real History looks
like. The excerpt in [STORY.md](../STORY.md) is this story's skeleton.

**Checks:** the "Shows" column, as `checks` (thresholds there), plus two hooks in `story_checks.py`:
`flame_share` (frames matching `cache::Shared>::respond|lock_contended` take at least 8% of the CPU samples in
`cache-shared`'s `steady-high` runs, and less than 1% in its parent's) and `on_frontier` (in `tune-batching`,
`max_batch 16, max_delay_us 250` is on the CPU-per-request/p99 frontier, within the noise: no configuration beats it by
more than 5% on CPU and 50% on p99 at once). Gate checks name their reference (`vs`).

**Milestones:** `v2.3.0` on `v2-3-0`, `v2.4.0` on `v2-4-0`, by adaeze.

**Logs worth showing:** under overload the gateway logs `WARN queue depth 3,812 > 3,072` and
`ERROR request 18233 missed its deadline by 41 ms`, so the log viewer has errors to count and jump to. CI batches list
their `qa batch ci` command with a link to `https://ci.kitefin.example/...`.

## Determinism and budget
- Schedules, payloads and keys are deterministic per input and seed; everything measured varies. Captures use the
  snapshot, and checks have margins (a 30% threshold for a 45% effect).
- `cargo build --release` once per workspace (`qa/build.py`: the seeder runs it before the story, about 2 min); every
  commit uses the same binary, its flags select the behavior.
- The whole story: ≤ 40 min on a 4-CPU runner (about 30 `ci` batches, `capacity` on the 6 commits the shots compare,
  `nightly` on the two releases and the last commit, one sweep), with nothing else running. It is the longest story.
- Dependencies: Rust stable; crates `hdrhistogram`, `pprof`, `core_affinity`, `tikv-jemallocator`, `mimalloc`, `lru`
  (all MIT or Apache-2.0), see LICENSES.md. Python: the standard library, and PyYAML (with qaboard).

## Shots it must make possible
`cli/gate`, `ci/step-summary`, `commits/feed`, `commits/branch-evolution`, `commits/filter`, `commit/latency-cdf`,
`commit/throughput-p99`, `commit/flame-diff`, `commit/core-heatmap`, `commit/text-diff`, `commit/run-menu`,
`logs/crash`, `logs/live-tail`, `logs/batch-commands`, `history/performance-over-time`, `history/find-regression`,
`history/relative`, `tuning/frontier`, `files/browser`, `files/runbar`, `files/hotkeys`, `files/keyboard`.

`logs/live-tail` needs a run that is really running while it records, with errors: start a `bursty-high` run of
`tuned-batching` through the stack right before recording (its bursts overload the gateway: deadline misses and queue
warnings). A `ramp` of `tuned-batching` barely misses deadlines: with the cache, the gateway has headroom at 7,200
requests/s.

## As built: differences from the first draft
- **Sized per machine** (`gateway-bench --calibrate`): the story's effects depend on how loaded the gateway is, and with
  fixed request rates that depends on the machine's speed. Without it, a runner 20% faster or slower than expected tells
  another story (no regression, or a collapse). It gave H 1,472 to 1,984 and K 40 to 86 on the (busy) machine this
  was built on: on a quiet runner it's stable.
- **Responses are rendered, and the shared cache's lock is held while the model runs.** A shared `Mutex<LruCache>`
  whose critical section is a lookup and the clone of 4 KB is idle 98% of the time at 6,000 requests/s and hurts
  nothing. With the rendering of every response under it (90 to 110 µs each), it is about half busy at 6,000
  requests/s: on a quiet CI runner it never saturated, the cache's CPU savings won, and p99 got 20% *better*. The
  convoy measured on the busy machine this was first built on came from lock holders being preempted, not from the
  design. So the agent's worker keeps the lock for its whole batch: it looks the keys up again (two workers never
  compute the same key), and the guard lives until the batch is answered. The gateway does one batch at a time.
  Per request, the lock is held for half a model run (hits skip it) and a rendering, about 230 µs: at 6,000
  requests/s it would have to be held 1.2 to 1.4 s per second (still 1.2 with 30% less work per request than
  calibrated, as on a machine faster than its calibration says), 0.9 to 1 s at 4,000, 0.5 s at 2,000. The lock's work
  and the gateway's capacity are made of the same model runs and renderings, so how busy the lock is against the
  workers without cache (about twice as busy) doesn't depend on the machine's speed. Past 1, the queue for the lock
  grows for as long as the load lasts: at `steady-high`, p50 is about a second and p99 2 to 3 s by the end of a 4 s
  repeat, against 3 and 12 ms without the cache.
  The flame graph shows `<gateway::cache::Shared>::respond` → `gateway::response::render` (red) where rendering used
  to run outside it, `lock_contended` (std's futex mutex), and less of the model (blue): a CPU profile doesn't show
  what runs while a lock is held, the code does. Requests wait off-CPU, at the ingress: "Where the time goes" shows it
  as queue time, and the log says how much of the time the lock was held (`cache lock held 96% of the time`).
- **The shared cache saves a third of the CPU per request and halves the gateway's capacity**: its lock saturates
  around 4,000 to 4,500 requests/s, the gateway without it above 7,000 (in `ramp`, p99 takes off from about 3,500).
  At 2,000 requests/s it's on par with no cache; at 6,000 every percentile is a hundred times slower or more. The
  agent's commit message claims the CPU saving, which is true. Sharding keeps the saving and makes p50 faster (−50% or
  more at `steady-mid`): hits skip the batch.
- **Keys: Zipf(0.9)** instead of 1.1: with 1.1, 78% of requests hit a 4,096-entry cache and the story is about the
  cache only. 0.9 gives ~50% hits (4,096 entries) to ~57% (16,384) in a 4 s run.
- **`edf`** with all deadlines at arrival + 12 ms would be FIFO: it serves first the requests that can still make it,
  and the late ones after. Its gain on bursts (more requests on time, a longer worst case) wasn't measured reliably on
  the shared machine this was built on: no check.
- **Allocators**: within noise of each other here (±5% CPU on `heavy-tail-high`): messages say so, no check.
- **`payload_copy`** pads each request to the batch's longest payload: the cost of a memcpy is nothing next to the
  model, the padding is the classic cost of dense batches with ragged inputs. Only `heavy-tail` has ragged payloads.
- **`ci` has 5 tests** (`steady-low` added): the gate and the commit list use the median over the batch's runs. With 4
  tests the median is the mean of the middle two, and `heavy-tail-high` is one of them: its regression at
  `payload-copy` would move the median by half its own change. With 5, the median is one test's value, and a single
  test's regression moves it at most to its neighbor's. Whether the gate passes at `payload-copy` isn't asserted: it
  depends on how close `heavy-tail-high`'s and `steady-high`'s p99 are on the runner. A `per_test_max_regression` rule
  catches it.
- **Throughput is the offered load** in an open-loop test unless the gateway can't keep up, so the tuning sweep's
  frontier is CPU per request against p99 (what batching trades), not throughput against p99.
- **The tuning sweep has 12 combinations, each the median of 3 repeats**, instead of 30 of one repeat. With the
  sharded cache at 6,000 requests/s, workers are about a third busy: between neighbors (max delay 250 or 500 µs, max
  batch 4 or 16), batching changes CPU per request by 2 to 4% and p99 by less than one 2 s measurement's noise. They
  swapped places from seed to seed: in one CI seed, (4, 500 µs) and (4, 1,000 µs) beat (16, 250 µs) by 4% on CPU and
  26 to 41% on p99. Now neighbors differ clearly: max batch 1 (batching off: max delay doesn't matter, so its 4 runs
  show the noise), 16 and 64; max delay 0, 250, 1,000 and 4,000 µs. Waiting longer saves a few percent of CPU and costs
  p99; not waiting costs CPU. The check tolerates what separates identical configurations: 5% on CPU, 50% on p99.
  Max batch 4 is left out: capping batches helps p99 when requests pile up, which depends on how busy the machine is.
  Three sweeps on the busy machine this was built on (p99 about 10 times noisier than on CI): the check passed in all
  three; with max batch 4 in the grid, (4, 250 µs) beat (16, 250 µs) in one.
- **Dropped claims**: `pin: workers` (small p99 gain), `edf` (bursty p99.9 −15%), allocators (heavy-tail p99 −8%),
  `tuned-batching` (goodput +5%): not measurable reliably, or not true, in this gateway. `tuned-batching` is by adaeze
  (13:20 UTC is outside kaito's hours), `cache_entries: 16384` on -17d (-19d is a Saturday).
- **Inputs**: 9 profile × level inputs and `ramp` (the draft said 12).

**What couldn't be validated where this was built** (a 4-CPU machine shared with other jobs): magnitudes at
`steady-high` and `bursty-high`, where other processes' load made the gateway collapse in some runs. The directions
and mechanisms were (CPU per request, lock waits, the crash, the padding's cost, the ramp, the sweep), at `steady-mid`
and `heavy-tail-high`. The checks' thresholds are set for a quiet 4-CPU runner. The first seed in CI passed 13 of 17
checks: the shared cache's lock didn't saturate there (above). With the model under it, direct `gateway-bench` runs
on the busy machine measured how busy the lock would be: 1.35 to 1.45 at `steady-high` with the calibrated sizes,
1.2 with 30% less work per request.
