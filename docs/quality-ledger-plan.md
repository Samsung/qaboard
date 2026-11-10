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
| 2 | **Benchmark files: viewers and metrics.** pytest-benchmark and Google Benchmark JSON first, then Criterion and hyperfine: a table against the reference, each benchmark a metric. An "import a benchmark suite" shape in the integration skill. Still inside `run()`; the HTTP API will later make "upload one file" easy. | Next, after the gate work. Use Opus subagents, one per format. |
| 3 | **The gate's table as a pull request comment**, updated in place, saying when runs passed after being done again. | Done: `qa gate --post-comment github\|gitlab`. Experimental, like the gate. |
| 4 | **Regression alerts.** After each CI batch of the reference branch, flag metrics that stepped against their trailing window, mark them in History, list them per project, notify (Slack, Teams, email). | Not started. Needs the project admin page to configure it. |
| 5 | **Testbed fingerprint.** `qa` records the CPU model, cores, memory and kernel; History and the gate compare within one; the Metrics Diff warns when the reference ran elsewhere. | Not started. |
| 6 | **Bisect**, from History or `qa bisect`: good and bad commits, QA-Board runs the batch on the midpoints. | Not started. |

Also asked for:
- **A project admin page**, with a new Admin menu that groups it with **Access**: configure the gate and the alerts
  from the web app. Today only access is there.
- **Flame graphs without the busywork.** Today projects convert profiles to our JSON by hand. Accept the usual
  formats (perf script, collapsed stacks, speedscope, pprof, py-spy), and make the diff and the search need no setup.
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

## Order of work
1. Reruns in their own directory, with the log, status and metrics of earlier attempts. Done.
2. The gate's table as a PR comment, with reruns and rule changes (item 3 and C). Done.
3. The project admin page and the Admin menu; the gate's and alerts' settings there.
4. Benchmark files (item 2), then flame graph formats.
5. Checkpoint: noise (item 1) once the SDK's design says what runs return.
