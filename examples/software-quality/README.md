# Fleet SDK tests: a QA-Board example

The (fictional) SDK that robots and fleet tools use to talk to the fleet backend, with its test suites, wrapped with
QA-Board: `qa/main.py` runs one suite under pytest and coverage.py, reads the JUnit XML report, runs the failed tests
again alone to find the flaky ones, and returns the counts (tests, failed, skipped, flaky) and the coverage of the
package the suite tests. Each run saves the JUnit XML report, which QA-Board's test viewer compares with the
reference's, the lines no test runs, the list of tests as text, an HTML report and the slowest tests. [`SPEC.md`](SPEC.md) describes
everything it computes; `story.yaml` is the six weeks of history the QA-Board docs show: tests written toward a
coverage target, a flaky test, a failure in strict mode only, and a coding agent that deletes tests to get a green CI,
caught by the quality gate.

## Run it

```bash
pip install qaboard -r requirements.txt     # pytest, coverage
cd examples/software-quality

qa batch ci                                  # 5 suites, in default and strict mode: 10 runs, about 20 s
qa run --input codec                         # one suite
qa batch quick                               # the 5 suites, default mode only
python qa/main.py codec strict               # a quick look without QA-Board: the metrics as JSON
python -m unittest discover qa/tests         # the JUnit reader's tests: pytest, GoogleTest, CTest, Surefire
```

Without `--share` or a CI, results are saved in `output/`. To see them in QA-Board, start a server
([quickstart](https://samsung.github.io/qaboard/docs/get-started/quickstart)), and use `qa --share` or run in CI.

## How it's wired

| File | What it does |
|---|---|
| `qaboard.yaml` | Project name, inputs (each suite is a folder of `tests/` with a `suite.yaml`), visualizations, the quality gate |
| `qa/main.py` | `run(context)`: runs the suite with pytest and coverage.py, reruns the failures, returns the metrics |
| `qa/junit.py` | Reads JUnit XML reports into test cases, counts and a tree. Standard library only: copy it |
| `qa/report.py` | `tests.txt`, `report.html`, `slowest.plotly.json` |
| `qa/metrics.yaml`, `qa/batches.yaml` | Metrics (labels, targets) and batches (`ci`, `quick`) |
| `fleet_sdk/` | The SDK: codec, planning, battery, missions, client |
| `tests/<suite>/` | Its tests, and `suite.yaml`: the package whose coverage they measure, a label, tags |
| `tests/conftest.py` | Which tests exist at a story commit, seeded random cases |

**Your own test runner:** keep `qa/junit.py` and `qa/report.py`, and change `pytest_command()` and `rerun()` in
`qa/main.py`. GoogleTest writes the same report with `--gtest_output=xml:junit.xml` and reruns tests with
`--gtest_filter`; CTest with `--output-junit junit.xml` and `--rerun-failed`; Maven Surefire and Gradle report flaky
tests themselves (`flakyFailure`), which `qa/junit.py` reads.

**Flags** describe what a commit of the story changes: a bug in the SDK, a test module that isn't written yet, tests
that are skipped. `fleet_sdk/_flags.py` reads them from `build/flags.json`, over its defaults:

```bash
echo '{"bug_missions_reserve": true}' > build/flags.json
qa run --input missions                      # 10 tests fail
```

## Inputs

Everything is ours, under CC0, see [`LICENSES.md`](LICENSES.md).
