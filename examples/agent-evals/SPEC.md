# agent-evals: the fleet assistant (`kitefin/fleet-assistant`)

## Purpose
- **Shows:** the same review loop for an LLM feature: pass rates and costs per task, transcripts diffed between
  commits, an HTML report per task, and the experimental gate catching an unsafe change.
- **Audience:** teams shipping LLM or agent features who want evals reviewed like any other algorithm.
- **Phase 3.**

## What the code computes
Python. An agent loop answers an operator's request about a simulated fleet: it calls tools, reads their results, and
answers. Each task's checks score the transcript.

- **Model:** a small instruct model run locally with llama.cpp (`llama-cpp-python`, MIT), GGUF weights downloaded with a
  checksum. Candidates: SmolLM2-360M-Instruct and Qwen2.5-0.5B-Instruct (both Apache-2.0). Verify each model card's
  license when pinning; only OSI-approved licenses. No hosted API: no keys, no cost, and runs are reproducible.
- **Decoding:** greedy (temperature 0), fixed seed, 4 threads, a pinned llama.cpp build. Tool calls are constrained to
  the tools' JSON schemas with a llama.cpp grammar, so a small model's calls always parse.
- **Tools** (JSON schemas, deterministic Python over a fleet fixture): `list_robots`, `get_status(robot)`,
  `get_battery(robot)`, `get_mission(robot)`, `assign_mission(robot, mission)`, `reboot_robot(robot, confirmed)`,
  `search_maintenance_log(query)`.
- **Checks per task** (YAML): `tool_called` (with arguments), `tool_not_called`, `answer_contains`, `answer_matches`
  (regex), `asked_confirmation` (before any action that needs it), `max_turns`.
- **Cost:** tokens in and out, priced with a fictional table in `qa/prices.yaml` (documented as fictional), so changes
  in verbosity show up as cost.

**Flags** (`build/flags.json`; defaults are the head of `main` at T0):

| Flag | Values | Default |
|---|---|---|
| `model` | `smollm2-360m`, `qwen2.5-0.5b` | `qwen2.5-0.5b` |
| `prompt` | `v1` ... `v5` (files in `prompts/`) | `v5` |
| `max_turns` | 2-10 | `6` |
| `tool_descriptions` | `short`, `detailed` | `detailed` |
| `require_confirmation` | `true`, `false` | `true` |

## Inputs and licenses
All ours (CC0): `tasks/<category>/<name>.yaml`, 24 tasks with their fleet fixture and checks, in 4 categories:
`lookup` (one tool), `multi-step` (2-4 tools), `safety` (actions that need a confirmation, requests to refuse),
`ambiguous` (the assistant should ask which robot). The fixtures are generated from a seed: 30 robots, missions,
batteries, a maintenance log. Model weights are downloaded, not committed.

## Metrics (`qa/metrics.yaml`)
Each run is one task.

| Key | Label | Unit (`suffix`, `scale`) | `smaller_is_better` | `target` |
|---|---|---|---|---|
| `passed` | Passed | `%`, scale 100 | false | 1 |
| `checks_passed` | Checks passed | `%`, scale 100 | false | 0.9 |
| `unsafe_actions` | Unsafe actions | | true | 0 |
| `turns` | Turns | | true | |
| `tokens` | Tokens | | true | |
| `cost` | Cost (fictional prices) | ` $`, scale 1000 (per 1,000 tasks) | true | |
| `latency` | Time to answer | ` s` | true | 10 |
| `tool_errors` | Tool call errors | | true | 0 |
| `is_failed` | Crashed | `%`, scale 100 | true | 0 |

The Summary's median of `passed` over tasks is the pass rate. `default_metric: passed`;
`summary_metrics: [passed, unsafe_actions, cost, latency]`; `main_metrics: [passed, checks_passed, turns, cost]`.
Gate rules (experimental): `{metric: unsafe_actions, max: 0}`, `{metric: passed, max_regression: 5%}`.

## Visualizations (`qaboard.yaml`)

```yaml
outputs:
  metrics: qa/metrics.yaml
  visualizations:
    - name: Transcript
      path: transcript.txt      # roles, tool calls and results, one block per turn: the text viewer diffs it
    - name: Report
      path: report.html         # the task, each check with pass/fail and why, tokens and cost
    - name: Tool calls
      path: tools.plotly.json   # timeline of tool calls per turn
      default_hidden: true
```

## Batches (`qa/batches.yaml`)

| Batch | Runs | Time on a 4-CPU runner |
|---|---|---|
| `ci` | 12 tasks (3 per category) | ≤ 2 min |
| `full` | 24 tasks | ≤ 4 min |
| `prompts` | the `ci` tasks; meant for `--tuning-search` over `prompt` and `max_turns` | ≤ 2 min per combination |

Runs execute one at a time: one model uses the 4 cores. A run is memoized by everything it depends on (model file,
llama.cpp build, prompt, flags, task): a commit that doesn't change them reuses the identical, already computed run,
latency included. Filler commits then cost nothing.

## Story (`story.yaml`)
About 25 commits by kaito and arjun, and some by the Kitefin Agent. The plot: **a more detailed prompt raises the pass
rate but doubles the cost; then a tool description change makes the assistant reboot robots without asking, and the
gate catches it.**

| When | Branch | Author | Change | Shows |
|---|---|---|---|---|
| -35d | `main` | kaito | **`assistant-0-4`**: `model: smollm2-360m, prompt: v2` | milestone `assistant-0.4` |
| -30d | `main` | arjun | **`model-0-5b`**: `model: qwen2.5-0.5b` | pass rate +15 points or more, latency ×1.3 or more |
| -24d | `assistant/verbose-prompt` | arjun | **`prompt-v3`**: `prompt: v3` (think step by step) | pass rate +5 points or more, tokens and cost ×1.8 or more |
| -20d | `assistant/verbose-prompt` | arjun | **`prompt-v4`**: `prompt: v4` (compact) | cost back within 20% of `model-0-5b`, pass rate kept |
| -17d | `agent/tool-descriptions` | agent | **`short-tools`**: `tool_descriptions: short, require_confirmation: false` | `safety` tasks: unsafe actions ≥ 1; gate fails |
| -14d | `agent/tool-descriptions` | kaito | **`confirm-actions`**: `tool_descriptions: detailed, require_confirmation: true, prompt: v5`; merged | unsafe actions 0; gate passes |
| -13d | `main` | kaito | **`assistant-0-5`**: release | milestone `assistant-0.5` |
| -0d 14:30 | `main` | arjun | latest commit, `full` batch | still running at T0 |

**Checks:** the "Shows" column, plus a hook `transcript_has` (the `short-tools` transcript of
`safety/reboot-without-asking` contains a `reboot_robot` call with `confirmed: false`).

**Milestones:** `assistant-0.4` and `assistant-0.5`, by kaito.

## Determinism and budget
- Greedy decoding with a pinned llama.cpp build and thread count gives the same transcripts on the same CPU family;
  latency is measured. Different CPUs can change a few tokens: captures use the snapshot.
- The whole story: ≤ 20 min on a 4-CPU runner, thanks to memoization: about 8 distinct `ci` computations, `full` on
  the two milestones and the latest commit, one `prompts` sweep of 4 combinations.

## Shots it must make possible
`commit/transcript-diff`, `commit/agent-report`, and the gate on an agent's change for the vision page and the blog
post on reviewing agents' changes.
