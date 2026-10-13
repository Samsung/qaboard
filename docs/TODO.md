# TODO

Loose ends from the docs overhaul (`docs/docs-overhaul-plan.md`), smallest first within each section. Each item says
where to start. When you finish one, delete it.

## Shots still planned
The shot list is `docs-media/shots.yaml`, how to capture is `docs-media/README.md`. Pages already reference these ids
and show a "not captured yet" placeholder until they're published.

- **`quickstart/compose`** (tape): the Docker Compose quickstart from a clean machine, `docker compose -f
  deployments/quickstart/compose.yml up -d` then the demo in the browser.
  - The demo stack holds port 5151, locally and in the `docs-media` workflow, so record it on another port:
    `QABOARD_PORT_HTTP=5252` (the compose file reads it, and `QABOARD_URL` follows). Use a separate compose project
    name (`-p qaboard-quickstart`) so it doesn't touch `qaboard-demo`, and `down -v` it at the end of the tape's
    hidden teardown.
  - The tape should hide the image pulls (`Hide` / `Show` around a `docker compose pull`), show `up -d`, then
    `curl -sSf http://localhost:5252/api/v1/health` and the projects list.
  - The demo-data image must exist: `ghcr.io/<owner>/qaboard:demo-data` is published by a `workflow_dispatch` run of
    `docs-media.yml` on master. In CI, build it locally first (the workflow's "Demo-data image" step does) and point
    the compose file at it with `QABOARD_IMAGE`.
  - Docker Hub rate-limits anonymous pulls: CI runners are fine, shared dev machines often aren't.
- **`quickstart/kind`** (tape): `kind create cluster --config charts/qaboard/kind.yaml`, `helm install` with
  `charts/qaboard/quickstart.yaml`, a port-forward, then the demo. `.github/scripts/helm_e2e.py` does all of it in the
  `helm-e2e` CI job: copy its commands. Needs kind, helm and kubectl on the runner (the `helm-e2e` job installs them)
  and about 6 GB of disk.
- **`landing/social-card`** (still): needs its template (a page that lays out the logo, tagline and a crop of the
  hero), then a spec like the others.
- **Phase 3**: the robotics and agent demo projects' shots (`project: robotics-3d`, `agent-evals`).

## Shots to improve
- **`commit/bit-accuracy-diff`** could end on "Bit-accurate" now: `docs-tuning-guide` vs `isp-4-1`, the facade run on
  the hw-model platform. The `ui` helpers can't change pages mid-clip: add a `ui.goto(url)` that waits like the
  initial load.
- **`commit/dynamic-outputs`** switches to the Full Image preset because the viewers used to zoom out when the stage
  changed. Fixed: it could stay on the facade's "Window frame (halos)" preset.
- **Landing "polish" tiles** cut from full-page 1440×900 clips (deep zoom, every stage, bit accuracy) are hard to read
  at tile size: capture tighter regions for the landing. The "Pixel values" tile is mostly white.
- **`cli/bit-accuracy`** lists `charts/*.png` in filesystem order, which differs between machines (see "Product" below):
  re-record once inputs are sorted.

## Docs
- **Old screenshots still used** where no shot covers them; check them for internal names and replace or drop them:
  `first-outputs.png`, `image-viewer-selection.png`, `plotly-3d-example.png`, `rich-metrics-in-card.png`,
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
- **History**: the y axis cuts off its top tick label ("000 ms" for 1000); `?breakdown_per_test=false` in the URL is
  ignored. (`webapp/src/CommitsEvolution.jsx`)
- **Branch chart**: `has_all_metrics` in `webapp/src/CommitsEvolution.jsx` uses `&&` where it means `||`, so it never
  filters commits out and the chart shows gaps instead.
- **Analysis view** (tuning): the frontier and plots only use the metrics selected in its tag picker; with another
  metric, the points are null and the plot is empty. (`webapp/src/components/tuning/`)
- **Commits page**: `from=2026-09-17` showed 9/18 while `from=2026-09-10` showed 9/10: a time zone off-by-one?
- **Summary**: the box plots of metrics on a log scale (e.g. AP small) overlap their y axis labels.
- **Detection-eval cards** are 390 px wide: add `outputs.style.width` to `examples/detection-eval/qaboard.yaml`
  (changes the snapshot key: the next `docs-media` run reseeds).
- **Run cards** are 1500 px wide without `outputs.style.width` in `qaboard.yaml`, wider than a 1440 px window.
- **Image viewer**: `Init()` adds `add-item` and `tile-load-failed` handlers on every image change, so they pile up
  (`webapp/src/viewers/images/images.jsx`). `OutputCard` logs React warnings (an unknown DOM prop, a non-boolean
  attribute, missing list keys).
- **Bit accuracy**: when both runs have a pixel hash (`md5_data`), the web app compares it instead of the file's md5,
  so it can call images identical when `qa check-bit-accuracy` wouldn't. Without manifests, the CLI matches
  `bit_accuracy.ignore` against file names rather than path prefixes.
- **Inputs order**: `qaboard/iterators.py` lists globbed inputs in filesystem order (`database.glob` isn't sorted), so
  batches list their runs in a different order on different machines. Sorting changes the snapshot key: the next
  `docs-media` run reseeds.
- **Backend**: `Batch.to_dict` runs one status-count query per batch; it could be grouped like
  `backend/backend/metrics_aggregation.py`.
- **Seeder**: the gate check's log prints "None: fail" for the max-failed-runs rule (it reads `metric`; use `kind`).
  `docs-media/snapshot.py` imports `Optional` without using it.
