# software-quality: the fleet SDK's tests (`kitefin/fleet-sdk`)

## Purpose
- **Shows:** QA-Board as the place where a team follows its tests over time: how many there are, which fail, which
  are flaky or skipped, and how much code they cover, per suite and in total; each suite's tests compared with the
  reference's in the test viewer; and the experimental gate catching tests that were deleted to get a green CI.
- **Audience:** teams that track unit and integration tests, coverage and their targets in CI dashboards, and want to
  review changes to them like any other result.
- **Phase 3.**

## How tests map to QA-Board
- **A run is one test suite, in one mode.** Not one test case: a suite has 12 to 500 cases, and a project thousands,
  each with a status and a time, and no metric of its own to plot. They are the run's outputs (the JUnit XML report,
  `tests.txt`, `report.html`), and the run's metrics count them. A suite is what CI runs as one command (a test
  executable, a pytest folder, a CTest label), what a team owns, and what can run on its own machine.
- **Inputs are the suites** (`tests/<suite>/`, recognized by its `suite.yaml`); **configurations are the modes**
  (`default`, and `strict`, where deprecation warnings are errors), like build types: debug, release, sanitizers.
- **A failing test doesn't fail the run**: the run measured it. A run fails when the suite couldn't run at all (no
  JUnit report, pytest's usage or internal errors).
- **Volume:** 10 runs per commit, with about 1 kB of metrics each. 1,000 commits a month is 10,000 rows in the
  `outputs` table, which PostgreSQL doesn't notice. The test cases themselves stay in files, and the retention
  policies that delete old results delete them (see "Deleting old data" in the docs).

## What the code computes
Python. `fleet_sdk/` is a small SDK (346 statements): a telemetry codec (varints, CRC-16, frames), A* on a warehouse
grid, battery state of charge and range, mission assignment, retries with backoff and a registry of frame handlers.
`tests/` has its tests, in 5 suites. `qa/main.py` runs a suite:

1. `python -m coverage run --branch --source=fleet_sdk/<suite> -m pytest tests/<suite> --junitxml=junit.xml`, with
   `-W error::DeprecationWarning` in `strict` mode;
2. reads `junit.xml` with `qa/junit.py` (standard library; it also reads GoogleTest, CTest and Maven Surefire
   reports, see `qa/tests/`);
3. runs the tests that failed again, in one pytest process, without the tests that ran before them: those that pass
   are **flaky**, the others **failed**;
4. reads coverage.py's totals for the suite's package.

**Flags** (`build/flags.json`, read by `fleet_sdk/_flags.py`; defaults are the head of `main` at T0):

| Flag | Values | Default |
|---|---|---|
| `bug_varint_fast_path` | `true`: an unrolled varint encoder keeps 4 bits of the 5th byte instead of 7: values from 2^32 to 2^35 lose bits | `false` |
| `client_legacy_parse` | `true`: the handler registry decodes frames with the deprecated `codec.parse()`, which warns | `false` |
| `bug_missions_reserve` | `true`: missions ignore the robots' 15% battery reserve | `false` |
| `tests` | test module (`codec/test_frames`) → `false`: not written yet, or deleted (`collect_ignore` in `tests/conftest.py`) | all there |
| `skip_tests` | test ids marked `@skip` | `[]` |
| `fuzz_cases` | random round trips per codec fuzz test | `200` |
| `isolate_registry` | `false`: tests share the default handler registry, and `test_default_registry_starts_empty` fails after `test_handler_decorator_registers` (it passes alone) | `true` |

## Inputs and licenses
All ours (CC0): the SDK, the tests, and the sample reports of `qa/tests/samples/`. Nothing is downloaded but the
Python packages: pytest and coverage.py.

## Metrics (`qa/metrics.yaml`)
Each run is one suite in one mode.

| Key | Label | Unit | `smaller_is_better` | `target` |
|---|---|---|---|---|
| `tests` | Tests | | false | |
| `passed` | Passed | | false | |
| `failed` | Failed (failed again when run alone) | | true | 0, pass/fail |
| `errors` | Errors (fixtures, collection) | | true | 0, pass/fail |
| `skipped` | Skipped | | true | |
| `flaky` | Flaky (passed when run again alone) | | true | 0 |
| `pass_rate` | Pass rate | `%` | false | 100% |
| `coverage` | Line coverage of the suite's package | `%` | false | 85% |
| `branch_coverage` | Branch coverage | `%` | false | 75% |
| `lines`, `lines_missed` | Lines of the package, and those no test runs | | null, true | |
| `test_time`, `slowest_test` | The tests' own time, the slowest one | ` s` | true | |

`default_metric: tests`; `summary_metrics: [failed, flaky, skipped, tests, coverage, lines_missed]`;
`main_metrics: [tests, failed, flaky, skipped, coverage, lines_missed]`. The packages don't overlap, so the **sum** of
`tests`, `failed` or `lines_missed` over a commit's `default` runs is the SDK's (History: filter on `default`, pick
**sum**). The SDK's line coverage is `1 - sum(lines_missed) / sum(lines)`: QA-Board doesn't plot ratios of sums.

Gate rules (experimental), against `main`: no failed test or error in any run (`aggregate: max`), no suite with fewer
tests or more skipped tests than its reference run, nor more than 2% less coverage (`per_test_max_regression`). Flaky
tests are reported, not gated.

## Visualizations (`qaboard.yaml`)

```yaml
outputs:
  visualizations:
    - name: Tests
      path: junit.xml             # QA-Board's test viewer: the tests as a tree, compared with the reference's report
    - name: Lines without tests
      path: coverage.txt          # coverage.py's report: missed lines and branches per file
    - name: Test list
      path: tests.txt             # `FAIL   tests/codec/test_varint.py::test_round_trip_fuzz[17]`, sorted: diffed
      default_hidden: true
    - name: Slowest tests
      path: slowest.plotly.json   # the 15 slowest, the reference's overlaid
      side_by_side: false
      default_hidden: true
    - name: HTML report
      path: report.html           # tree of folders, files and classes, written by qa/report.py
      default_hidden: true
```

`junit.xml` marks the flaky tests like Maven Surefire does (`<flakyFailure>` instead of `<failure>`), so the report
itself says which ones they are.

## Batches (`qa/batches.yaml`)

| Batch | Runs | Time on a 4-CPU runner |
|---|---|---|
| `ci` | 5 suites x 2 modes | about 20 s |
| `quick` | 5 suites, `default` | about 10 s |

## Story (`story.yaml`)
21 commits by adaeze and kaito, and three by the Kitefin Coding Agent. The plot: **the team writes tests toward 85%
coverage per package, and QA-Board shows the volume, the failures, a flaky test and a strict-only failure; then,
asked to get CI green after a real bug, the agent deletes and skips the tests that caught it: no test fails, the
coverage doesn't move, and the gate fails because a suite lost tests.**

| When | Branch | Author | Change | Shows (ci batch, measured; sums over the `default` runs) |
|---|---|---|---|---|
| -42d | `main` | adaeze | **`sdk-tests`**: the suites in QA-Board; `fuzz_cases: 20`, 5 test modules not written yet | 131 tests, 98 lines without tests; coverage codec 60%, planning 66%, battery 84%, missions 98%, client 75% |
| -41d | `main` | adaeze | **`sdk-1-4`**: release | milestone `sdk-1.4` |
| -38d | `main` | kaito | **`frame-tests`**: `codec/test_frames` | codec 72 -> 132 tests, coverage 60% -> 87% |
| -36d | `main` | adaeze | **`astar-tests`** | planning 12 -> 26 tests, coverage 66% -> 100% |
| -31d | `main` | kaito | **`varint-fast-path`**: `bug_varint_fast_path` | codec: 17 failed in each mode, coverage 87% -> 95% (the fast path runs); gate fails |
| -31d | `main` | kaito | **`varint-fix`** | 0 failed; gate passes |
| -28d | `agent/battery-tests` | agent | **`range-tests`**: `battery/test_range`; merged -27d | battery 20 -> 42 tests, coverage 84% -> 97% |
| -24d | `agent/registry-tests` | agent | **`registry-tests`**: `client/test_registry` (with `isolate_registry: false`); merged -23d | client 15 -> 25 tests, coverage 75% -> 95%, 1 flaky in each mode; gate passes |
| -22d | `main` | adaeze | **`reserve-tests`**: `missions/test_reserve` | missions 12 -> 24 tests |
| -20d | `main` | kaito | **`legacy-parse`**, then **`legacy-parse-fix`** | `strict` only: client 9 failed |
| -17d | `main` | kaito | **`closest-robot`**: `bug_missions_reserve` | missions: 10 failed |
| -16d | `agent/fix-missions-ci` | agent | **`green-ci`**: deletes `missions/test_reserve`, skips 2 tests | 0 failed; missions 24 -> 12 tests, 2 skipped, coverage 98% -> 98%; gate fails |
| -16d | `agent/fix-missions-ci` | adaeze | **`keep-reserve`**: the bug fixed, the tests back; merged -15d | 0 failed, missions 24 tests; gate passes |
| -13d | `main` | adaeze | **`sdk-1-5`**: release | milestone `sdk-1.5` |
| -10d | `main` | kaito | **`isolate-registry`** | 0 flaky |
| -7d | `main` | kaito | **`fuzz-200`**: `fuzz_cases: 200` | codec 132 -> 492 tests (609 in all): the volume curve jumps, the coverage doesn't |
| -0d 13:30 | `main` | adaeze | latest commit | its ci batch still running at T0 |

**Checks:** the "Shows" column, plus a hook `status_changes`: at `varint-fast-path`, 10 codec tests or more are `FAIL`
in `tests.txt` where the parent's are `PASS`.

**Milestones:** `sdk-1.4` and `sdk-1.5`, by adaeze.

## Determinism and budget
- The tests are deterministic: random cases are seeded from `$QA_SEED` and the test's id. Test times are measured.
- A `ci` batch takes about 10 s with the seeder's parallel runs: seeding the story took 4 min on 4 CPUs (24 ci batches and the checks).

## As built
Measured with the replay of every commit's flags, on 4 CPUs (pytest 9.1, coverage.py 7.16, Python 3.12).

- **Coverage is not a test of the tests.** The agent's change deletes half of the missions tests and the line
  coverage stays at 98%: the remaining tests still run those lines, they no longer check the reserve. The gate's
  `tests` and `skipped` rules catch it. And the varint bug *raises* the codec's coverage, because the buggy fast path
  runs.
- **The number of tests is easy to inflate:** 200 fuzz cases per round trip multiply the codec's tests by 3.7 and
  change nothing else. The story shows it on purpose, next to coverage and lines without tests.
- **Runs take about a second**, enough for the seeder to stop the last batch while it runs (it stops it within
  100 ms of the runs starting).

## Shots it must make possible
`history/test-volume`, `commit/junit-viewer`, `commit/tests-diff` and `commit/deleted-tests`, for the use case page (specs in
`docs-media/shots/history.spec.ts` and `commit.spec.ts`).
