# RFC: the gate per label and per batch, and one comment that several jobs share

Status: implemented, November 2026 (`qaboard/gate.py`, `tests[].batch` in `backend/backend/compare.py`, the Quality
gate page). Extends `website/docs/quality-gate.mdx` (experimental) and `docs/rfcs/project-admin.md` (project rules).
What the gate compares doesn't change: a commit's results against the reference's, as today. Decided while building
it: a rule's `label` isn't shown in the tables (the section is the label's); `expect_batches` is one check per label
("batches with runs"); a mapping's keys are labels or patterns; `pull_request_target` events comment on their pull
request, closed ones get no comment; GitHub's 403 answers that are rate limits are retried like 429s. Not verified against live GitHub or GitLab
(mocked in the tests); the backend integration test was written but not run here.

## Why
Projects organize their tests in two ways, and the gate has to speak both:

- **By batch.** `qa batch ci`, `qa batch perf`, `qa batch nightly`: the name after `qa batch` is what matters. All the
  runs land in the same results (the CI's), and a rule often only makes sense for one of them: a latency rule for
  `perf`, not for the unit tests.
- **By label.** `qa --label nightly batch all`: the label names the results, and a commit has several.

Today a rule looks at every run of the results it checks, `gate.batches` lists *labels* under a name that reads like
the other thing, and the comment on the pull request is rewritten by each `qa gate`: with two jobs, the last one
erases the first. And nothing says when results are complete: a gate that runs after `qa batch ci` and before
`qa batch perf` decides on a subset.

## Words
- **Label**: what `qa --label` sets. The CI's results have the label `default`, shown as **CI**.
- **Batch**: the name given to `qa batch <name>`. Each run remembers it (`data.batch`).

## Configuration
```yaml
gate:
  reference: main
  labels: [default, nightly]       # which results to check. Was `batches`, still accepted.
  expect_batches: [ci, perf]       # can't decide until `qa batch ci` and `qa batch perf` both have runs
  rules:
    - {metric: psnr, max_regression: 1%}                          # every run
    - {metric: latency_p99, max_regression: 10%, batch: perf}     # only the runs of `qa batch perf`
    - {metric: coverage, min: 80, batch: [unit, integration]}     # several, or patterns like "perf-*"
    - {metric: accuracy, min: 0.9, label: nightly}                # only when checking the label "nightly"
```

- `labels` replaces `batches` at the top of the section. `batches` keeps working, with the same meaning; giving
  both is an error. `qa gate --label` is added next to `--batch`/`-b`, which stay.
- A rule's `batch` and `label` take a name, a list, or shell patterns (`fnmatch`). Without them a rule applies to
  every run of every label checked, as today.
- `expect_batches`: for each label checked, the batches that must have at least one run. It can also be a mapping
  per label: `expect_batches: {default: [ci, perf], nightly: [all]}`.
- Project rules (set in the web app) take the same `batch` and `label`, and the project's settings can have
  `expect_batches`: the union with the commit's applies.

## Behavior
- **A rule scoped to batches** uses only the runs whose batch matches, and their reference runs: its median, mean,
  min or max is computed over those tests, and `per_test_max_regression` looks at them only.
- **No matching run**: the check is `unknown`, "no runs from `qa batch perf` yet", and the gate is undecidable. So
  is a missing `expect_batches` entry. With `--wait`, the gate waits for them like it waits for running runs.
- **A rule for another label** than the one being checked is left out, silently.
- `max_failed_runs` and `require_bit_accuracy` stay about all the runs of the label.
- The server gives each test's batch in `GET /api/v1/commit/<sha>/compare` (`tests[].batch`). With an older server a
  scoped rule is `unknown`, with a message to upgrade it.
- In the tables a scoped check says so: `latency_p99, median [perf]`.

## The comment on pull requests
One comment per pull request and gate (a subproject has its own), shared by every `qa gate` of the commit:

- It has **a section per label**. A `qa gate` run replaces the sections of the labels it checked and keeps the
  others, when they're about the same commit. Sections about an earlier commit are removed: the first `qa gate` of a
  new commit starts the comment again.
- The title is the verdict over the sections it has: fail if one fails, else undecidable if one is, else pass.
  With several sections, a line lists each label's verdict.
- Sections are found by hidden markers that carry their label, verdict and commit. The rules that changed, and the
  note on which commit the comment is about, are outside the sections, written by the latest run.
- Two jobs that finish at the same moment can overwrite each other's section (read, then write). The gate reads the
  comment again right before writing; we accept the rest, the commit status has each job's own verdict.
- Requests to GitHub and GitLab are retried once on 429 and 5xx answers.
- `qa --dryrun gate --post-comment github` prints the comment it would post, and on which pull request, without
  posting: to try the setup from a CI job.

Failing to comment never changes the exit code.

## Not doing
- Statuses per batch, or a comment per batch.
- Deciding the end by time or by counting commands: `expect_batches` says what complete means.
- Scoping `max_failed_runs` per batch. A rule on a metric your runs return (e.g. `failed`) does it.
