# Plan: software performance, and a ledger of quality for agents

Status: working plan, November 2026. It records what we decided to build after comparing QA-Board with the
continuous benchmarking tools named in [Compared with other tools](../website/docs/alternatives.mdx) (CodSpeed,
Bencher, asv), and after asking what coding agents miss when they work semi-autonomously. The roadmap
(`website/docs/roadmap.mdx`) stays the public page: move items there when they're ready to be announced.

The deep learning side has its own plan: `docs/rfcs/python-sdk-runs.md` (runs created from Python, metrics with
steps, curves from several runs).

## What the benchmarking tools have that QA-Board lacks
1. **Verdicts that know about noise.** Bencher sets thresholds per metric from a window of past values (t-test,
   z-score, IQR); rustc-perf derives each benchmark's threshold from its own history; CodSpeed counts instructions
   in a simulated CPU. QA-Board's gate uses fixed percentages.
2. **Regressions found for you.** asv has a page of regressions with step detection, Perfherder raises alerts,
   MongoDB and Nyrkiö use E-divisive change points, Chromium bisects. QA-Board's History is a chart to scan.
3. **Adapters for benchmark harnesses.** Bencher reads the output of about 15 of them (pytest-benchmark, Criterion,
   Google Benchmark, go bench, JMH, hyperfine). QA-Board asks for a `run()`. The JUnit viewer shows the pattern:
   read a standard file, compare it with the reference's, extract metrics.
4. **The machine's identity.** asv ties results to a machine profile, Bencher has testbeds. QA-Board's platform is
   linux, windows or lsf, and nothing says when a reference ran elsewhere.
5. **Comments on pull requests.** CodSpeed and Bencher put the table on the PR. QA-Board posts a commit status.
6. **Bisect.** asv finds the commit by binary search. QA-Board can start batches on any commit: most of a bisect.

Where QA-Board is ahead: flame graph diffs, distributions as plots against the reference, per-core views, tuning
frontiers, anything end-to-end. We don't chase instruction counting: an example that returns `perf stat`'s
instructions as a metric covers it.

## Principles we settled
- **QA-Board's place in the chain.** Projects measure, QA-Board compares, shows and records. People still write
  `run()`. If a project repeats a measurement, it does so inside `run()` with the tool it trusts (hyperfine, its
  harness) and returns the statistics it wants as metrics. We don't run things N times and aggregate on top.
- **A rerun is not a sample.** People rerun after they changed code, fixed a machine or a dependency. We keep a
  trace of attempts, we don't compute statistics over them (`docs/rfcs/rerun-directories.md`).
- **Dispersion comes from the run's outputs**, not from us: a run can say "5 repeats, this spread" in what it returns.
  How we store it must fit the SDK's metrics with steps: design the two together, and don't give metrics more
  meaning than they have today until then.
- **Keep it simple and keep options open**, even when it rules out the smartest analysis.
- **The ledger**: for every change, the evidence (runs, and whether they come from a verified CI job), the verdict
  (the gate), the decision (a person's approval). QA-Board has the first, half of the second, not the third.
- **QA-Board is not a code review tool.** The pull request stays in GitHub or GitLab; QA-Board is the evidence and
  the record it links to.

## Performance track, by value over effort
| # | Item | Status |
|---|---|---|
| 1 | **Noise-aware gate and Metrics Diff.** First a static floor per metric (`noise: 2%` in its definition), used by the gate and to gray out changes within it. Then a floor from the metric's history on the reference branch (robust spread: MAD or IQR, same input, configuration and platform). A test on samples only once runs can carry them. | Not started. Waits for the design of what runs return (see principles). The static floor can go first. |
| 2 | **Benchmark files: viewers and metrics.** pytest-benchmark and Google Benchmark JSON first, then Criterion and hyperfine: a table against the reference, each benchmark a metric. An "import a benchmark suite" shape in the integration skill. Still inside `run()`; the HTTP API will later make "upload one file" easy. | Done: `qaboard/benchmarks.py` (`benchmark_metrics`, `read_benchmarks`, `write_benchmarks` and a `*.benchmarks.json` format) and the benchmark viewer (`webapp/src/viewers/benchmarks/`), for pytest-benchmark, Google Benchmark, hyperfine, Criterion (messages and `target/criterion`), JMH and `go test -bench`. "Within noise" uses the files' own spread; item 1's floors can refine it. |
| 3 | **The gate's table as a pull request comment**, updated in place, saying when runs passed after being done again. | Done: `qa gate --post-comment github\|gitlab`. Experimental, like the gate. |
| 4 | **Regression alerts.** After each CI batch of the reference branch, flag metrics that stepped against their trailing window, mark them in History, list them per project, notify (Slack, Teams, email). | Not started. Needs the project admin page to configure it. |
| 5 | **Testbed fingerprint.** `qa` records the CPU model, cores, memory and kernel; History and the gate compare within one; the Metrics Diff warns when the reference ran elsewhere. | Not started. |
| 6 | **Bisect**, from History or `qa bisect`: good and bad commits, QA-Board runs the batch on the midpoints. | Not started. |

Also asked for:
- **A project admin page**, with a new Admin menu that groups it with **Access**: configure the gate and the alerts
  from the web app. Design: `docs/rfcs/project-admin.md`. Step 1 is done: the Admin menu, **Quality gate** with
  project rules that `qa gate` checks and no commit can change, and failing commits that loosen their rules.
  Next: the gate's verdict recorded on the server, then **Alerts** (emails, a chat webhook).
- **Flame graphs without the busywork.** Today projects convert profiles to our JSON by hand. Accept the usual
  formats (perf script, collapsed stacks, speedscope, pprof, py-spy), and make the diff and the search need no setup.
  Done: the viewer reads folded stacks, speedscope and `.cpuprofile` files as profilers write them;
  `qaboard.flamegraphs` converts `perf script` and pprof; diffs compare shares by default; search, top functions
  table, playground `/flame-graph-viewer.html`. Not yet: Chrome's trace-event JSON (DevTools' Performance panel),
  syncing zoom between the "After & Before" graphs.
- **Good docs** for all of it: a user guide page per task, the integration pages, the use case.

## Agents track
| # | Item | Status |
|---|---|---|
| A | **Attempts are kept.** A rerun no longer erases what came before: its directory, status, metrics and log. | Done: `docs/rfcs/rerun-directories.md`. |
| B | **Provenance on every run.** Who or what started it (an agent's name and task), a dirty tree, verified CI or not, as a badge and a filter. The CI token exchange already says which job on which repository and ref. | Not started. |
| C | **Flag changes to the gate's rules.** Loosening a threshold to pass is the obvious failure: say so on the commit page and in the PR comment. | Done in `qa gate`'s output and comment (`rules_changes`). Not on the commit page yet. |
| D | **Record the decision.** "Approve as the new reference": who, when, with the verdict and the Metrics Diff they saw. | Not started. |
| E | **A review inbox.** Batches awaiting a decision, ranked by what moved beyond noise, new failures, outputs that changed. | Not started. Needs D and item 1. |
| F | **An evidence pack**, for a read-only MCP server and the PR comment alike: compare, explain a regression with the worst tests and image crops, history, a Markdown summary. | Not started. Item 3 is its first renderer. |
| G | **Agents as reviewers.** Notes on a commit's outputs, labeled, for people to spot-check. | Later, after B and D. |

Order: A, then C with item 3, then B, D, E, F.

## Done so far
1. Reruns in their own directory, with the log, status and metrics of earlier attempts (`docs/rfcs/rerun-directories.md`).
2. The gate's table as a comment on pull requests, with reruns and rule changes (item 3 and C).
3. The project's Admin pages, step 1: **Quality gate** with project rules (`docs/rfcs/project-admin.md`), rules per
   batch and label, `expect_batches`, and one comment shared by several jobs (`docs/rfcs/gate-scopes-and-comments.md`).
4. Benchmark files (item 2) and flame graphs from profilers' files.

## Next steps, in order
Each step is small enough for one pull request, and useful without the ones after it.

### 1. The gate's verdict, kept by the server
The ledger's second column. Today the verdict is an exit code, a commit status and a comment: QA-Board doesn't have it.
- `qa gate` reports its result (`POST /api/v1/commit/<sha>/gate`, with the permission to send results); the server
  keeps it with the batch: verdict, checks, reference, rule changes, reruns, when, and who sent it.
- The commit page and the list of commits show it: pass, fail, undecidable, with the table on click.
- First slice: the endpoint, the tag on the commit page, the API to read it. No new table: the batch's data.
- Unlocks: alerts (2), the rule changes on the commit page (C), the review inbox (E).

### 2. Alerts: **Admin → Alerts**
Designed in `docs/rfcs/project-admin.md` (step 2).
- Who: email addresses, and one chat webhook (Slack, Teams, Mattermost), stored encrypted in a `secrets` column of
  `project_settings`, registered for key rotation, shown masked. A **Send a test alert** button.
- About what, first: *the gate failed*, on the reference branch or on any branch. One alert per commit and label,
  not one per `qa gate` call.
- Then: *the gate recovered*, and *a batch of the reference branch has failed runs*.
- Needs step 1. Reuses `backend/notifications/mail.py` and the webhook code of sign-in access requests.

### 3. Noise, the simple way
Item 1 of the performance track, cut so that QA-Board still computes nothing across runs.
- **A noise floor per metric**, in its definition: `noise: 2%` in the metrics file, or `Metric(value, noise=0.02)`
  from code. The Metrics Diff grays changes within it; the gate's regression rules pass them, and say "within noise".
- **From the harness, for free**: `benchmark_metrics()` sets each metric's `noise` from the spread its file reports.
  Benchmark suites then get the same "within noise" in the Metrics Diff, History and the gate as in the viewer.
- Not yet: a floor from the metric's history on the reference branch, and tests on samples. They wait for what
  runs can carry (`docs/rfcs/python-sdk-runs.md`).

### 4. The ledger, for people who review at scale
- **Provenance on every run** (B): a badge and a filter for verified CI, an agent's name and task, a dirty tree.
- **Rule changes on the commit page** (the rest of C), from the verdict of step 1.
- **Record the decision** (D): "approve as the new reference", with who, when, and the verdict they saw.
- **A review inbox** (E): batches awaiting a decision, ranked by what moved beyond noise (step 3) and what failed.
- **An evidence pack** (F) for a read-only MCP server: the gate's comment is its first renderer.

### Small things the November review left open
Found by the reviews of the gate, the server and the viewers; none blocks the steps above.
- **Gate, comment**: a job of an older commit that finishes last replaces the newer commit's sections (skip the
  write when the pull request's head moved on). Two jobs that finish together can still lose a section or post two
  comments: GitHub and GitLab have no conditional update.
- **Gate, verdicts**: rules with only `min`/`max` are undecidable without a reference, they don't need one.
  `on_looser_rules: fail` stays undecidable when the server never got the reference's *qaboard.yaml*. Project
  settings a `qa` doesn't know fail the gate (exit 1): exit 2 would keep old CI jobs from going red after a server
  upgrade. `max_regression: 5` means 500%: warn above 1.
- **Gate, numbers**: unscoped medians are the Summary's (every reference run on the same inputs, the reference's
  tuning iterations included); scoped rules and means, min, max use paired runs only. Pick one, in `compare.py` and
  `webapp/src/utils/compare.js` together.
- **Gate, forges**: GitLab's `PRIVATE-TOKEN` header follows redirects to other hosts (use `Authorization: Bearer`
  or refuse redirects); GitLab's status for undecidable is `failed`. Neither forge was tried live: mocked in tests.
- **Project settings**: two owners saving at once, the last wins silently (send `gate_updated.at`, answer 409). The
  endpoints aren't in `openapi.yaml`. Earlier attempts keep up to 300 metrics each: 50 would do.
- **Attempts on NFS**: after a stale read `reserve()` can skip a directory `qa batch` reserved; a requeued LSF or
  Kubernetes job that had started gets a new attempt.
- **Words**: the web app's selector says "Batch" for what `qa --label` sets, and the compare API's messages say
  `batch "default"`: the docs say label.
- **Viewers**: parsing happens on the main thread (a worker for files over ~20 MB); cards narrower than 450 px clip
  the benchmark table; `qaboard.flamegraphs`' folded reader is stricter than the web app's.

### Later, or when someone asks
- Regression alerts on the reference branch (item 4): a metric that stepped against its trailing window.
- The machine each run ran on (item 5), and bisect (item 6).
- Viewers: Chrome's trace-event JSON in the flame graph viewer, synced zoom between two graphs, a rule for
  benchmark files that report no spread. Their screenshots: "Shots" in `docs/TODO.md`.
- Keeping the output files of earlier attempts, not only their logs (`docs/rfcs/rerun-directories.md`).
