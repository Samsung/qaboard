# TODO

Loose ends from the docs overhaul (`docs/docs-overhaul-plan.md`), smallest first within each section. Each item says
where to start. When you finish one, delete it.

## Shots still planned
The shot list is `docs-media/shots.yaml`, how to capture is `docs-media/README.md`. Pages already reference these ids
and show a "not captured yet" placeholder until they're published.

- **Phase 3**: the robotics and agent demo projects and their shots (`project: robotics-3d`, `agent-evals`), postponed.
  Work in progress on two branches, not merged:
  - `claude/docs-robotics-3d`: world, trajectories, sensors, ground truth (only `loop` generated), ICP odometry, loop
    closure and evaluation. The odometry crashes on `loop` (an invalid rotation matrix) and frame-to-frame ICP is 17-37
    mm off with 1% depth noise (normals from noisy points). Missing: `qa/main.py` and the outputs, configs, story.
    The SPEC's plot (`keyframe_dist: 0.6` doubles the fast figure-8's error) has no obvious mechanism: rethink it.
    The viewers may need small changes (6DoF plots fixed at 350 px; the point cloud viewer reads the ground truth from
    the inputs and plots a hard-coded `pcmd`); check that Playwright's Chromium plays the H.264 camera video.
  - `claude/docs-agent-evals`: the agent loop (llama-cpp-python, grammar-constrained tool calls, memoized), tools,
    fleet, checks, metrics, pinned GGUF downloads, 24 tasks. Qwen2.5-0.5B passes 1-3 of 6 lookup tasks with the v5
    prompt (wrong tools, repeated calls): the prompt or tasks need work before the story's effects show. Missing: the
    report and plots, prompts v1-v4, configs, story, the actions/cache step.
  - **`qa gate` on pass/fail metrics**: rules compare the median over runs, which is meaningless for 0/1 per-test
    metrics (`unsafe_actions` with `max: 0` passes while fewer than half the tests are unsafe). Add an aggregate option
    to the rules (mean, max), computed client-side from the per-test values the compare endpoint already returns.

## Shots to improve
- **`commit/text-diff`**: at the 1440 px window, the last column of HdrHistogram's table (`1/(1-Percentile)`) is cut on
  both sides of the diff. A narrower font in the text viewer, or a crop that drops that column, would read better.
- **Clips are 1x**: the CDP screencast of headless Chromium sends frames at CSS size (1440x900), not at the device
  scale (2x), so clips are softer than stills, most visibly the landing tiles (crops of 585-720 px). `meta.json`'s
  `scale` is now the frames' (`lib/record.ts`), so crops are right either way. Getting 2x frames (headed Chromium, or a
  device metrics override for the screencast) would need the clip budgets checked again.

## Docs
- **Old screenshots still used** where no shot covers them; check them for internal names and replace or drop them:
  `first-outputs.png`, `plotly-3d-example.png`, `rich-metrics-in-card.png`,
  `copy-windows-output-dir.png`, `winows-explorer-output-dir.jpg`, `export-commit-folder.png`, `gitlab-jenkins.gif`,
  `configure-jenkins-build-triggers.png`, `login-block-unsigned-user.jpg`, the FAQ's `export-files-viz/-output/-commit.jpg`,
  `slides/flame-graphs.jpg` (blog).
- **Detection-eval numbers**: int8 results differ a little between GitHub's runners and other machines, even with the
  reference QDQ arithmetic (e.g. indoor minmax 0.0713 vs 0.0647). Quote only numbers from the published demo data.
  The story's `int8-tuned` commit uses `quant_keep_fp32: first-conv`, while the CI's `qa optimize` ranks
  `quant_keep_fp32: none` best: say "the team picked" rather than "`qa optimize` found" if a page shows the commit.
- **Detection-eval indoor drop**: `examples/detection-eval/story.yaml`'s header and `SPEC.md` say "-40%" for indoor,
  the demo data measures -35% (the pages say 35%).
- **Release notes**: publish October's note at the start of November (see `website/release-notes/_template.md`).

## Product, small
- **`qa batch`**: on success, the "Results" link only prints at the start: `print_url` returns early because `qa batch`
  sets `QA_BATCH` itself (`cli/batch` shows the first one). Changes `qaboard/`: the next `docs-media` run reseeds.
- **Analysis view** (tuning): the frontier and plots only use the metrics selected in its tag picker; with another
  metric, the points are null and the plot is empty. (`webapp/src/components/tuning/`)
- **Commits page**: `from=2026-09-17` showed 9/18 while `from=2026-09-10` showed 9/10: a time zone off-by-one?
- **Image viewer**: `Init()` adds `add-item` and `tile-load-failed` handlers on every image change, so they pile up
  (`webapp/src/viewers/images/images.jsx`). `OutputCard` logs React warnings (an unknown DOM prop, a non-boolean
  attribute, missing list keys).
- **Bit accuracy**: when both runs have a pixel hash (`md5_data`), the web app compares it instead of the file's md5,
  so it can call images identical when `qa check-bit-accuracy` wouldn't. Without manifests, the CLI matches
  `bit_accuracy.ignore` against file names rather than path prefixes.
- **Backend**: `Batch.to_dict` runs one status-count query per batch; it could be grouped like
  `backend/backend/metrics_aggregation.py`.
