# `story.yaml`: a project's history

Each example has a `story.yaml` that describes about 6 weeks of its history before the seed date T0: commits, the
batches run on them, failures, milestones, tuning experiments, and the batch still running at T0. `docs-media/seed.py`
replays it into a running stack with the real `qa` CLI and fake CI environment variables, computing every result.
Then it checks the story's assertions, so a story whose plot doesn't show up fails loudly instead of producing
misleading screenshots.

Schema: [`story.schema.json`](story.schema.json) (JSON Schema 2020-12, for the YAML content). The seeder's own test story
(`docs-media/tests/fixture/`) may use another `project` and `id`. People, branch names
and milestone names follow [the demo world](README.md).

## Example

```yaml title="examples/serving-latency/story.yaml (excerpt)"
version: 1
project: serving-latency
id: kitefin/inference-gateway
seed: 4242

defaults:
  runs:
    - batch: ci

commits:
  - id: dyn-batching
    branch: main
    at: -41d 09:12
    author: adaeze
    message: |
      gateway: dynamic batching with max batch and max delay

      Requests wait up to max_delay_us for a batch to fill, so workers run fewer, bigger matmuls.
    flags: {batching: dynamic, max_batch: 8, max_delay_us: 500}

  - id: v2-3-0
    branch: main
    at: -34d 14:40
    author: kaito
    message: "batcher: reuse the batch buffer (-8% CPU at 6k rps)"
    flags: {batch_buffer: reuse}
    runs:
      - batch: ci
      - batch: nightly

  - id: batch-overflow
    branch: main
    at: -27d 01:30
    author: kaito
    message: "batcher: fill batches up to max_batch before flushing"
    flags: {bug_batch_overflow: true}
    failures:
      - batch: ci
        inputs: "bursty-*"
        kind: bug
        log: "panicked at .*index out of bounds"

  - id: batch-overflow-fix
    branch: main
    at: -27d 04:05
    author: kaito
    message: "batcher: fix off-by-one when the batch is full"
    flags: {bug_batch_overflow: null}

  - id: cache-shared
    branch: agent/result-cache
    parents: [batch-overflow-fix]
    at: -20d 03:05
    author: agent
    message: |
      Add a shared result cache for repeated requests

      Requested by Kaito. Repeated payloads skip the model.
    flags: {cache: shared, cache_entries: 4096}

  - id: cache-sharded
    branch: perf/sharded-cache
    parents: [cache-shared]
    at: -15d 02:10
    author: kaito
    message: "cache: shard by key hash, 16 shards (p99 -31% at 6k rps)"
    flags: {cache: sharded, cache_shards: 16}
    runs:
      - batch: ci
      - batch: sweep-batching
        via: tuning
        label: tune-batching
        user: kaito
        after: 3h
        tuning:
          max_batch: [1, 4, 8, 16, 32]
          max_delay_us: [0, 100, 250, 500, 1000, 2000]

  - id: merge-sharded-cache
    branch: main
    parents: [batch-overflow-fix, cache-sharded]
    at: -14d 10:02
    author: adaeze
    message: Merge branch 'perf/sharded-cache'

  - id: tuned-batching
    branch: main
    at: -0d 13:20
    author: kaito
    message: "batcher: default to max_batch 16, max_delay 250us (on the frontier)"
    flags: {max_batch: 16, max_delay_us: 250}
    runs:
      - batch: ci
      - batch: nightly
        after: 2h25m
        progress: {finished: 0.6, running: 2}

milestones:
  - commit: v2-3-0
    label: v2.3.0
    notes: Dynamic batching
    by: adaeze

checks:
  - name: the shared cache makes p50 faster
    commit: cache-shared
    vs: parent
    metric: latency_p50
    expect: {change_pct: {lt: -10}}
  - name: the shared cache makes p99 much worse
    commit: cache-shared
    vs: parent
    metric: latency_p99
    inputs: "steady-high*"
    expect: {change_pct: {gt: 30}}
  - name: lock contention is visible in the flame graph
    commit: cache-shared
    hook: flame_share
    args: {path: cpu.flame.json, match: "lock_contended|lock_slow", min_share: 0.08}
  - name: the gate fails on the shared cache
    commit: cache-shared
    expect: {gate: fail}
  - name: the gate passes after sharding
    commit: cache-sharded
    expect: {gate: pass}
  - name: sharding fixes p99
    commit: cache-sharded
    vs: v2-3-0
    metric: latency_p99
    expect: {change_pct: {lt: 5}}
  - name: tuning puts the chosen config on the frontier
    commit: cache-sharded
    label: tune-batching
    hook: on_frontier
    args: {x: throughput, y: latency_p99, params: {max_batch: 16, max_delay_us: 250}}
```

## Top level

| Key | Required | Meaning |
|---|---|---|
| `version` | yes | `1` |
| `project` | yes | The example's folder name: `serving-latency` |
| `id` | yes | The QA-Board project id, equal to `project.name` in *qaboard.yaml* |
| `seed` | yes | Base seed. The seeder gives it to the code as `$QA_SEED`: runs derive their random seeds from it and their input (not the commit: commits that don't change the code give the same results) |
| `defaults.flags` | no | Flags at the first commit, merged over the code's own defaults |
| `defaults.runs` | no | Runs for every commit that doesn't list `runs`. Default: `[{batch: ci}]` |
| `commits` | yes | In chronological order; parents come before their children |
| `milestones` | no | Shared milestones, or release branches listed in *qaboard.yaml* |
| `checks` | no, but expected | Assertions run after computing everything |

## Commits

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Unique kebab-case id, used by `parents`, `checks` and the shot specs |
| `branch` | yes | The branch QA-Board records for the commit |
| `parents` | for a branch's first commit and merges | Commit ids. Default: the previous commit listed on the same branch |
| `at` | yes | When it was committed, as an [offset from T0](#time-offsets) |
| `author` | yes | A handle from [the demo world](README.md#people) |
| `message` | yes | Subject, then a blank line and a body if any. In the author's voice |
| `flags` | no | What this commit changes in the code (below) |
| `patches` | no | File path (relative to the example) → JSON Merge Patch (RFC 7386), applied to that YAML file from this commit on: *qaboard.yaml*, *qa/metrics.yaml*, *qa/batches.yaml*. E.g. add a visualization, a metric, or a configuration to a batch |
| `runs` | no | The batches run on this commit. Default: `defaults.runs`. `[]` for none |
| `failures` | no | Runs that must fail, and how |

- **Hash:** a commit's sha is `sha1("<project id>:<commit id>")` in hex, e.g. `sha1("kitefin/inference-gateway:cache-shared")`.
  Shot specs get it with `demo.sha(project, id)`.
- **Merges** have two parents, `[<the branch merged into>, <the merged branch's head>]`, and the branch of the first.

### Flags: what a commit changes
A story changes the code's behavior through flags, never through the runs' configurations: configurations show up as
tags on runs and change how new and reference runs are matched, which would make every comparison noisy.

- The seeder writes the commit's **effective flags** to `build/flags.json` before running `qa`, and saves it with
  `qa save-artifacts`. The project's code reads it (see the example's `SPEC.md` for its flags).
- Effective flags = the first parent's, with this commit's `flags` merged over them (JSON Merge Patch: `null` removes a
  key, so the code's default applies again). A root commit starts from `defaults.flags`.
- A merge commit takes, for each top-level key, the merged branch's value if that branch changed it since the merge
  base, else the first parent's. A key both sides changed differently is an error, unless the merge commit's `flags`
  sets it.
- Flags describe code, so a "bug" is a flag too (`bug_batch_overflow: true`): the code really takes the buggy path.

### Runs

| Key | Default | Meaning |
|---|---|---|
| `batch` | (required) | A batch from *qa/batches.yaml* |
| `via` | `ci` | `ci`: the CI batch, label `default`, user `ci`, with `CI=1 GITHUB_SHA GITHUB_REF`. `local`: `qa --share` from a workspace (shown as a local run: QA-Board records the label as `@<user>\| <label>`). `webapp`: started like **Run Tests** in the web app (shows in **Started from QA-Board**). `tuning`: a grid or sampled sweep with `--tuning-search`. `optimize`: `qa optimize`. `webapp`, `tuning` and `optimize` get the environment QA-Board's backend gives the `qa batch` it starts, and show in **Started from QA-Board** |
| `label` | `default` for `ci`, required otherwise | The batch label (`tune-batching`, `kaito-cache-probe`) |
| `platform` | `linux` | `qa --platform` |
| `user` | `ci` for `via: ci`, else the commit's author | Who started it |
| `after` | `6m` for `ci`, `1h` otherwise | Start time after the commit, as a [duration](#time-offsets) |
| `tuning` | | `via: tuning`: parameter name → list of values (all combinations) |
| `sample` | | `via: tuning`: run this many random combinations instead of all (picked with the story's seed) |
| `optimize` | | `via: optimize`: path of the search-space file, relative to the example |
| `progress` | finished | `{finished: <0..1>, running: <n>}`: the batch is still running at T0; the rest is pending. The seeder stops `qa batch` once `n` runs started: they must take more than a second |

The seeder runs each batch at its own simulated time, in story order. Performance batches never run in parallel with
anything else.

### Failures

```yaml
failures:
  - batch: ci            # which runs: batch, optional `inputs` glob, `configs` glob and `platform`
    inputs: "bursty-*"
    kind: bug            # bug | oom | timeout | lsf-memlimit
    log: "panicked at .*index out of bounds"   # regex the run's log must match
```

- `inputs` globs (here and in checks) match input paths like *.gitignore* patterns: without a `/`, against the file
  name (`bursty-*` matches `profiles/bursty-high.yaml`).
- `configs` globs match the run's configurations rendered as JSON, like in checks (`*"int8"*`): when a batch runs
  each input in several configurations, and only some of them fail. `bug` failures only.
- `bug`: the code crashes on its own, on a path enabled by `flags`. The entry is an expectation the seeder checks.
- `oom`, `timeout`: the seeder enforces a memory cap or a time limit on the run, which really dies. The limits come from
  the batch's definition in *qa/batches.yaml*: `lsf: {max_memory: <MB>}` (default 2048) and `local: {timeout: <seconds>}`
  (default 60). A watchdog kills the run (SIGKILL) when its processes' resident memory or its run time goes over.
- `lsf-memlimit`: like `oom`, plus a `log.lsf.txt` written from a template with the run's measured peak memory and the
  "requested" limit, so the web app shows LSF's report and its hints. The only templated log.
- Runs not listed must succeed: an unexpected failure stops the seeder.

### Milestones

| Key | Meaning |
|---|---|
| `commit` | The commit id |
| `label`, `notes` | As shown in the app: `v2.3.0`, "Dynamic batching" |
| `by` | The persona who creates it; it becomes a shared milestone they own |
| `batch`, `filter` | Saved with the milestone. Default: `default`, no filter |
| `kind` | `shared` (default), `personal` (listed only for its owner), or `config`: add `branch` to *qaboard.yaml*'s `project.milestones` instead |
| `group` | Its group in the milestones menus, e.g. `releases` or `tuning/denoiser` |
| `branch` | For `kind: config` |

## Time offsets

| Form | Meaning | Example |
|---|---|---|
| `-<N>d HH:MM` | N days before T0's date, at HH:MM UTC | `-12d 14:05` |
| `-<N>h`, `-<N>m`, `-<N>h<M>m` | That long before T0 | `-90m`, `-2h30m` |
| `<N>h`, `<N>m`, `<N>h<M>m` | A duration, for `after` | `6m`, `2h25m` |

- Everything happens before T0. T0 is a Thursday 16:00 UTC, so `-0d 13:20` is 2h40m before T0, and days `-4` and
  `-5` are the weekend (warned).
- A commit is after its parents; a batch runs after its commit.
- Keep finished results at least 10 minutes before T0: relative times must not flip during a capture.

## Checks

Each check names a commit, and either compares a metric or calls a hook. All checks run after all the runs; the
seeder prints every failing check with the actual numbers and exits with an error, and no snapshot is saved.

| Key | Default | Meaning |
|---|---|---|
| `name` | (required) | What the story claims, printed when it fails |
| `commit` | (required) | The commit to check |
| `label`, `platform`, `inputs`, `configs` | `default`, `linux`, all, all | Which runs. `configs` is a glob over the run's configurations rendered as JSON (`*"int8"*`) |
| `vs` | | The reference commit: `parent` (first parent), a commit id (the same commit compares two batches or configurations), or `milestone:<label>` |
| `vs_label`, `vs_configs` | `label`, `configs` | The reference's runs, when they differ from the new side's: a tuning batch vs CI, `int8` vs `fp32`. Runs are matched like the web app does: same input, then the closest configuration, same platform |
| `metric`, `agg` | `agg: median` | The metric, aggregated over the runs with `median`, `mean`, `min`, `max` or `p90` |
| `expect` | | One or more of: `value` (the new aggregate), `delta` (new − ref, in the metric's unit), `change_pct` ((new − ref) / \|ref\| × 100), each with `gt`, `gte`, `lt`, `lte` or `between: [a, b]`; `failed` (a count, same comparators); `log` (a regex every failed run's log matches); `gate: pass\|fail\|undecidable` (`qa gate`'s verdict with the example's `gate:` rules, against `vs` or else its default reference) |
| `hook`, `args` | | A function in the example's `story_checks.py`: `hook(ctx, **args) -> tuple[bool, str]`. `ctx` gives the runs, their metrics and their output files (below) |

What hooks get as `ctx`:

```python
ctx.check, ctx.commit             # the check (dict), and its commit's id
ctx.sha(commit_id), ctx.parent(commit_id), ctx.flags(commit_id)   # sha, first parent's id, effective flags
ctx.runs(commit=None, label=None, platform=None, inputs=None, configs=None) -> list[Run]
                                  # a batch's runs, by default the commit and filters of the check
ctx.qa(*args, commit=None) -> subprocess.CompletedProcess        # the real `qa` CLI, as the CI on that commit
                                  # (default: the check's), e.g. ctx.qa('check-bit-accuracy', '--batch', 'ci',
                                  # '--reference', ctx.sha('isp-4-1')). .returncode, .stdout (stdout and
                                  # stderr, without colors)
ctx.t0, ctx.workspace, ctx.results  # T0, where the example runs, the results storage
Run: .input (path in the database), .platform, .configurations, .extra_parameters (tuning), .metrics, .failed,
     .pending, .output_dir, .file(name) -> Path, .log() -> str (log.txt and log.lsf.txt), .key (identifies the run)
```

Checks say what the reader must see. "p99 regresses more than 30%" is a good check for a story told with a 45%
regression: it passes despite noise, and fails if the effect disappears.
