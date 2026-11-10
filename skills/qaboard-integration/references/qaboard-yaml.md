# qaboard.yaml: the keys that matter

Schema with every key: https://samsung.github.io/qaboard/qaboard.schema.json. Site defaults (a `qaboard-site-*`
package or `QABOARD_SITE_CONFIG`) are merged under the project's file: don't repeat `storage` or runner settings that
the site provides.

## project
| Key | Meaning |
|---|---|
| `name` | `group/repo`, the git host's path, lowercase. Subprojects in a monorepo: a `qaboard.yaml` per folder with `project.name: group/repo/sub` (https://samsung.github.io/qaboard/docs/monorepo-subprojects). |
| `url` | The repository's URL. The server reads commit messages and avatars from it when it can (https://samsung.github.io/qaboard/docs/backend-admin/git-hosts). |
| `entrypoint` | The Python file with `run()`, relative to the project's root. |
| `reference_branch` | New commits are compared with this branch's latest results. Usually `main`/`master`/`develop`. |
| `description`, `avatar_url` | Shown in the web app's project list. |

## inputs
| Key | Meaning |
|---|---|
| `database` | Where inputs are: `{linux: ..., windows: ...}` or one path. Relative to the project's root, or absolute. `{project}`, `{subproject}`, `$VARS` expand. Default `/`. |
| `globs` | How to find inputs under a folder a batch lists: `'*.jpg'`, `labels.json`. A list is fine. |
| `use_parent_folder` | `true`: the input is the folder that contains the matched file (a dataset slice, a recording). |
| `batches` | The batch files, a path or a list (`qa/batches.yaml`). |
| `types` | Several kinds of inputs with their own `globs`/`database`, selected with `qa --type` or per batch (https://samsung.github.io/qaboard/docs/inputs#advanced-handling-multiple-input-types). |

Input metadata (tags, scene, lux...) comes from a `metadata(context)` function in the entrypoint, or from an
external database: https://samsung.github.io/qaboard/docs/metadata-integration-external-databases. The web app filters and
groups runs by it.

## outputs
| Key | Meaning |
|---|---|
| `metrics` | A metrics file (`qa/metrics.yaml`): `default_metric`, `summary_metrics`, `main_metrics`, optional `available_metrics` with definitions. Not required: declared metrics in code are enough. |
| `visualizations` | A list of `{name, path, type?, default_hidden?, side_by_side?, ...}`. `path` is relative to the run's output folder; `:name` parts make a slider/select. |
| `style` | CSS for the run cards, e.g. `{width: 840px}`. |
| `controls` | Toggles the UI passes to all viewers (`{type: toggle, name: show_debug, default: false}`). |
| `action_on_existing` | What `qa batch` does for runs that already have results: `run` (default), `postprocess`, `sync`, `skip`. |

## Batch files (`qa/batches.yaml`)
```yaml
ci:                           # qa batch ci
  inputs: [a/, b/x.jpg]       # paths relative to the database; folders are searched with inputs.globs
  configs: [base, {gain: 2}]  # strings and mappings; your run() gives them meaning
  platform: linux             # optional
  database: {linux: /other}   # optional, this batch's inputs live elsewhere
  matrix: {model: [fp32, int8]}   # expands '${matrix.model}' in configs/platform: one run per combination
  lsf: {max_memory: 3072}     # optional: a runner's settings for this batch's runs
aliases:
  all: [ci, nightly]          # qa batch all
```
Reuse with YAML anchors; select inputs by metadata; several files: https://samsung.github.io/qaboard/docs/batches-advanced

## artifacts
What `qa save-artifacts` stores per commit so that runs can be started from the web app later (builds, configuration
files): `{build: {glob: 'build/*.so'}}`. https://samsung.github.io/qaboard/docs/storage/artifacts

## gate (experimental)
`reference` (branch, commit or shared milestone), `labels` (the results to check, as `qa --label` sets them; the
CI's is `default`; `batches` is its older name), `expect_batches` (the `qa batch` names that must have runs before
the gate decides: a list, or a list per label), `rules` (`metric` with `max_regression`, `per_test_max_regression`,
`min`, `max`, `aggregate`, and optionally `batch` and `label`: a name, a list or patterns, to check only those runs),
`max_failed_runs`, `require_bit_accuracy`. https://samsung.github.io/qaboard/docs/quality-gate

## bit_accuracy
Which output files `qa check-bit-accuracy` compares byte for byte with the reference's: `patterns`, `ignore`,
`plaintext`/`binary`. For deterministic pipelines. https://samsung.github.io/qaboard/docs/bit-accuracy

## runners
Where `qa batch` runs: `local: {concurrency: -1}` (all cores; use `1` when measuring latency), `lsf: {queue, max_threads, max_memory}`,
`celery`, `dask`. `default` names the one used without `--runner`. https://samsung.github.io/qaboard/docs/using-the-qa-cli#batch-runners

## storage
`{linux: /mnt/qaboard, windows: '//server/share/qaboard'}`: the shared folder where `--share` and CI runs write, which
the server reads at the same path. Templates like `{project}`, `{user}` are allowed. Local runs (no `--share`) write
to `output/` in the project. https://samsung.github.io/qaboard/docs/storage/where-is-the-data

## integrations
Buttons in the web app that link somewhere or trigger a CI job: `[{text: Model registry, icon: cube, href: https://...}]`.
https://samsung.github.io/qaboard/docs/triggering-third-party-tools
