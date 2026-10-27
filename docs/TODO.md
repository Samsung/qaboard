# TODO

Loose ends from the docs overhaul (`docs/docs-overhaul-plan.md`), smallest first within each section. Each item says
where to start. When you finish one, delete it.

## Shots
The shot list is `docs-media/shots.yaml`, how to capture is `docs-media/README.md`. Every planned shot is published.
- **Reseed the snapshot**: the robotics and agent shots were captured from local seeds of their stories, and
  `commit/regions-all-runs` from snapshot `b6f6c4b8af6d9fbe`: no snapshot has this checkout's stories yet. Run the Docs
  media workflow with `reseed` (seeding all five stories takes over an hour); its captures replace these when they
  differ beyond the dedupe tolerance.

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
- **Analysis view** (tuning): the frontier and plots only use the metrics selected in its tag picker; with another
  metric, the points are null and the plot is empty. (`webapp/src/components/tuning/`)
- **Commits page**: `from=2026-09-17` showed 9/18 while `from=2026-09-10` showed 9/10: a time zone off-by-one?
- **Bit accuracy**: when both runs have a pixel hash (`md5_data`), the web app compares it instead of the file's md5,
  so it can call images identical when `qa check-bit-accuracy` wouldn't.
