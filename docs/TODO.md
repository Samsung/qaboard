# TODO

Loose ends from the docs overhaul (`docs/docs-overhaul-plan.md`), smallest first within each section. Each item says
where to start. When you finish one, delete it. Code warts are in [warts.md](warts.md), what's site-specific in
[known-issues.md](known-issues.md), the web app's follow-ups in [webapp/TODO.md](../webapp/TODO.md).

## Shots
The shot list is `docs-media/shots.yaml`, how to capture is `docs-media/README.md`.
- **Capture `commit/flame-diff` again, and `commit/flame-top-functions`** (no reseed: the Docs media workflow on the
  current snapshot, with a web app that has the new flame graph viewer). The published `commit/flame-diff` shows the
  viewer before November 2026, so the pages use `commit/flame-top-functions`, which is a stand-in from the playground.
  Once both are published: delete the stand-in, and give `commit/flame-diff` its pages back where the table isn't
  the point (`pages:` in `shots.yaml`).
- **`commit/benchmarks` is a stand-in**, made by `docs-media/standins/make.py` (so is `commit/flame-top-functions`):
  no demo project saves a benchmark file. `examples/software-quality/benchmarks/` has the suite. To capture it from
  the demo stack: a batch that runs it and saves *pytest.benchmarks.json*, the visualization in the example's
  *qaboard.yaml*, a spec in `docs-media/shots/commit.spec.ts`, then a reseed. Or keep the stand-in: run the script
  again on a quiet machine, the VM it ran on has spreads of 10-25%.
- **The other stand-ins** wait for a story or a spec: `ci/pr-comment`, `commit/attempt-tag` and `logs/attempts`
  (seed.py has no reruns), `project-admin/gate`. See their `needs:` in `shots.yaml`.
- **Reseed the snapshot**: the robotics and agent shots were captured from local seeds of their stories, and
  `commit/regions-all-runs` from snapshot `b6f6c4b8af6d9fbe`: no snapshot has this checkout's stories yet. Run the Docs
  media workflow with `reseed` (seeding all five stories takes over an hour); its captures replace these when they
  differ beyond the dedupe tolerance. Do it once, after the story changes above.

## Shots to improve
- **Clips are 1x**: the CDP screencast of headless Chromium sends frames at CSS size (1440x900), not at the device
  scale (2x), so clips are softer than stills, most visibly the landing tiles (crops of 585-720 px). `meta.json`'s
  `scale` is now the frames' (`lib/record.ts`), so crops are right either way. Getting 2x frames (headed Chromium, or a
  device metrics override for the screencast) would need the clip budgets checked again.

## Docs
- **`slides/flame-graphs.jpg`** (blog, June 2020) is the last screenshot from before the overhaul. It shows a
  person's name, an internal branch and project, and class names of internal code, public since 2020: replace it with
  a shot of the demo, or keep it as the post's picture of its time.
- **Detection-eval numbers**: int8 results differ a little between GitHub's runners and other machines, even with the
  reference QDQ arithmetic (e.g. indoor minmax 0.0713 vs 0.0647). Quote only numbers from the published demo data.
  The story's `int8-tuned` commit uses `quant_keep_fp32: first-conv`, while the CI's `qa optimize` ranks
  `quant_keep_fp32: none` best: say "the team picked" rather than "`qa optimize` found" if a page shows the commit.
- **Release notes**: publish November's note at the start of December (see `website/release-notes/_template.md`).

## Product, small
- **Analysis view** (tuning): before its rewrite (November 2026, `TuningReport.jsx`), the frontier and plots only
  used the metrics selected in its tag picker; with another metric, the points were null and the plot empty. Check
  that the new report doesn't, then delete this.
- **Commits page**: `from=2026-09-17` showed 9/18 while `from=2026-09-10` showed 9/10: a time zone off-by-one?
  Not reproduced by reading the code. A lead: the date picker parses what `toLocaleDateString()` wrote with
  `new Date(str)` (`CommitsListNavbar` in `webapp/src/AppNavbar.jsx`), which depends on the browser's locale.
- **Bit accuracy**: when both runs have a pixel hash (`md5_data`), the web app compares it instead of the file's md5,
  so it can call images identical when `qa check-bit-accuracy` wouldn't.
