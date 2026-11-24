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
- **`commit/benchmarks` is a stand-in**, made by `docs-media/standins/make.py` (so is `commit/flame-top-functions`).
  `examples/software-quality`'s default runs now save *pytest.benchmarks.json*, its qaboard.yaml shows it, and
  `commit.spec.ts` has the spec: it waits for the reseed below. Then delete the stand-in and update its `status:` in
  `shots.yaml`.
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
- **Release notes**: November's note was published as a preview with 1.2.0 (November 14) and got bullets since: at the
  start of December, curate it again (`description`, `highlights`, `date`: "Publishing" in `website/CLAUDE.md`).

## Website dependencies
- **Docusaurus 4** (canary only in November 2026). `future.v4` flags not on yet: `mdx1CompatDisabledByDefault` (592
  `{#id}` headings in 88 files: `docusaurus write-heading-ids --migrate`; 68 titled admonitions (`:::tip Title`) to rewrite as
  `:::tip[Title]`), `siteStorageNamespacing` (readers lose their saved theme and tabs once), `useCssCascadeLayers`
  (check the pages visually).
- DocSearch 4.5's Ask AI suggested questions, if we turn Ask AI on in Algolia.

## Product, small
- **Constraints in `qa optimize`**: Optuna 5's `trial.set_constraint()` would allow "best quality with runtime under
  X" (`qaboard/optimize.py`, the config, the report). 2-3 days.
- **Commits page**: `from=2026-09-17` showed 9/18 while `from=2026-09-10` showed 9/10: a time zone off-by-one?
  Not reproduced. The URL is read as local days (`date_range_from_query`), and the picker now reads typed dates in
  the browser's locale (`parse_local_date`, it used `new Date(str)`, US order only). If it's seen again, note the
  browser's locale and time zone.
- **System metrics, next** (`qaboard/system_metrics.py`, docs `website/docs/system-metrics.mdx`):
  - **PSS** next to the RSS sum: forked workers (PyTorch DataLoader) count their shared pages once each in the sum.
    `memory_full_info().pss` reads smaps: measure its cost on a big process before sampling it every 5 s.
  - **More from GPUs**, one number each in the summary: energy (`nvmlDeviceGetTotalEnergyConsumption`), throttle
    reasons, XID/ECC errors. DCGM's `SM_ACTIVE`/`PIPE_TENSOR_ACTIVE` where DCGM runs: what "busy" really means.
  - **Disk I/O** of the process tree (`io_counters`, read/written bytes): shows trainings waiting on their data.
  - **MIG instances**: today they fall back to the GPUs the run's processes use, with the whole GPU's numbers.
    Their own memory needs `nvmlDeviceGetMigDeviceHandleByIndex`.
  - **Heartbeats rewrite `outputs.data`** every 2 minutes for each running run, now that they carry `resources`
    (`report_output_progress`): skip the write when the peaks didn't change, if the database notices.
