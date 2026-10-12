# Docs, screenshots and positioning overhaul: plan

Status: plan v2.2 (2026-10-12), approved; phase 0 in progress. **(decide)** marks what's still open;
each has a recommendation. Section 10 lists what's already decided.

Changes since v1:
- No hosted or static public demo for now. "Try it" means a local quickstart with demo data, on Docker Compose
  or Kubernetes, and both are tested in CI.
- A GitHub-first tutorial with a stack picker (tabs that remember your choices).
- A Kubernetes quickstart that works, owned by its own subagent.
- Quality gate v1, shipped as experimental.
- A vision page with a much larger roadmap: N-way comparisons, enterprise, deep learning, a W&B-style SDK.
- Small product gaps are fixed in phase 0.
- Media is served from the docs site itself. `sivoov.app` is only used by build tooling and never appears to readers.

## TL;DR
- The product is in much better shape than the website. The user guide text is current and the app got a lot of
  polish in 2026, but every screenshot and the whole landing page date from 2019-2020. That's most of why the
  project looks inactive.
- **One pipeline, several payoffs.** Demo projects and a seeder fill a real stack with a believable history.
  - A Playwright shot list captures stills and clips. They're stored in R2 and served from the docs site.
  - The same demo data ships as a container image, so anyone can run QA-Board locally with data in minutes, on
    Compose or Kubernetes. That replaces a hosted demo until hosting is possible.
- Heavy media runs are opt-in: manual dispatch, a PR label, release tags and a monthly refresh.
- Reposition from "experiment tracker" to **results review for algorithm teams**: the tool every team ends up
  building badly in-house. The agent story is a vision page backed by one real, experimental feature: a CI quality gate.
- Two release-plumbing problems block any quickstart, so we fix them first:
  - The published Docker images are from 2022, and there's no `proxy` image.
  - The Helm chart has never been installed in CI.

---

## 1. Where we are (audit summary)

**Website** (`website/`, Docusaurus 3.10)
- **Where it's published:**
  - The live site is `samsung.github.io/qaboard` and it's current (3.10.2, with release notes).
  - The official repository is `Samsung/qaboard`, which deploys that site. `arthur-flam/qaboard` is the maintainer's
    working fork (merges are re-pushed to Samsung), so its own Pages URL is 404 by design.
- **Pages:** 51 doc pages in 3 sidebars (User guide / Project integration / Admin).
  - The user guide is maintained and good.
  - "Getting started" and several guides are 2020-era: `introduction` embeds a SlideShare and links `https://qa`.
- **Media:**
  - ~40 web-app screenshots, all 2019-2020 UI, some captioned "older screenshot".
  - 4 GIFs (5 MB). No videos except one YouTube embed.
  - 5 referenced images are missing (4 deep-learning GIFs and the social card).
- **Landing page** (`src/pages/index.js`):
  - 2019 slide crops with orange arrows, typos, and a `<title>` of "Hello from QA-Board".
  - "I run the server" links to an internal runbook.
- **Internal runbooks on the public site:** `backend-admin/{deployment,troubleshooting,host-upgrades,getting-SSL-certiticates-from-IT}`
  and parts of `start-server`/`kubernetes` (internal hosts, paths, registry). `dag-pipelines` is a design proposal that names colleagues.
- **Blog and release notes:** the blog has 2 posts, both from 2020. The release notes are very active (37 notes, monthly in 2026).
- **`.gitignore`:** the root file ignores `*.png *.jpg *.gif *.svg *.ico`, so new screenshots are silently not committed.

**Web app** (React 19 / Blueprint 6 / Vite 8): rich and screenshot-friendly, because most state lives in the URL.
- **Polish to show off:**
  - Images: synced zoom/pan with crosshair, perceptual diff with threshold, pixel tooltip, ROI histograms, auto-ROI, filters, IIIF deep zoom on 100MP+ images.
  - Other viewers: dynamic outputs with synced sliders, Plotly overlays, differential flame graphs, Monaco text diff, video sync, point clouds, 6DoF trajectories, bit-accuracy tree with in-place diff.
  - Logs and files: live log tail with LSF hints, keyboard-driven file browser, Monaco batch editor.
  - Tuning analysis, milestones, What's new.
- **Gaps:**
  - No dark mode and no command palette.
  - History page: the sidebar is empty and one tab has no title.
  - Plotly "Send to Cloud" button in the SLAM viewer.

**Data and ingest**
- No demo project (`qaboard/sample_project` computes nothing), no seed data, and only tiny inline e2e mocks.
- **A fresh stack is still easy to fill:** `POST /api/v1/output/` doesn't need git when payloads carry the `commit_*`
  fields, or the real `qa` CLI runs with fake CI variables (`CI=1 GITHUB_SHA=... GITHUB_REF=...`).
- **Two bugs a seeder will hit:**
  - `commit_branch=None` crashes `to_dict`.
  - `CiCommit.get_or_create` tests `'qatools_config' not in data` against a payload keyed `qaboard_config`, so
    every commit overwrites the project config (`backend/backend/models/CiCommit.py:265`).
- **The ingest endpoints are unauthenticated.** That's acceptable behind a firewall, but not once a server is exposed so GitHub-hosted runners can reach it.
- **The CLI never uploads output files.** Runs write to storage shared with the server (NFS-style, same absolute
  path), so a CI runner must mount that storage. GitHub-hosted runners can't use QA-Board today.

**Release plumbing**
- **PyPI is current:** `qaboard` 1.1.1, Oct 2026.
- **Docker Hub is stale:** `arthurflam/qaboard` has backend/frontend/website from Feb 2022 and cantaloupe from Jul 2025.
  There's no `proxy` image. CI pushes only when `DOCKERHUB_*` secrets are set, and they evidently aren't.
- **The chart was never installed:** CI lints `charts/qaboard` and runs kubeconform, nothing more.
  Results storage has to be wired by hand into backend, proxy and Cantaloupe through three separate `extraVolumes`.

**CI:** GitHub CI already builds every image with a layer cache, brings the full Compose stack up and smoke-tests it
on a 4-CPU runner. The media job and the quickstart tests build on that.

---

## 2. Positioning and narrative

### Who we're for
Teams whose output quality can't be captured by pass/fail tests:
- camera/ISP and imaging;
- computer vision and ML model evaluation;
- robotics and automotive perception;
- embedded and HW/SW co-design (bit-accuracy);
- performance engineering.

The buyer is the tech lead or manager who maintains a pile of scripts, spreadsheets, an internal dashboard, and
screenshots pasted in Slack.

### The pitch
> **Tests tell you it runs. QA-Board shows you it's better.**
> Every commit and every experiment runs on your test set; QA-Board puts the outputs side by side
> (images, plots, flame graphs, logs, metrics) so your team can see what changed, agree it's better and ship it.
> Self-hosted, git-native, built for heavy data.

- Short form for social cards and the GitHub description: *"Code review for results."*
- The category we claim is **results review**, not "experiment tracking".

### Why not X (an honest comparison page)
| Alternative | What it's great at | Where QA-Board wins |
|---|---|---|
| In-house dashboard + scripts | Fits exactly, at first | Years of polish you won't build: deep zoom, synced diff, tuning, cluster runners, bit-accuracy, file browser, auth |
| W&B, MLflow, Comet, ClearML | Training runs, scalar curves, model registry | Output-centric, commit-centric, any algorithm, self-hosted, no per-seat pricing, and you can keep using them (roadmap: W&B-style SDK and importers) |
| CodSpeed, Bencher, asv | Micro-benchmarks on PRs | Perf and output quality in one place, flame graph diffs, real workloads on your data |
| LangSmith, Braintrust | LLM traces and evals | Not limited to text/LLMs; the same review loop for every algorithm |
| Notebooks | Exploration | Persistent, comparable, shareable by link |

One sentence of context, not a campaign: Neptune's hosted tracker shut down in March 2026 after its acquisition.
Self-hosted open source is a real argument for buyers who got burned.

### Story spine (landing page, tour, tutorials)
1. **Run**: wrap your code with `qa` and run it on a batch of inputs, locally, on a cluster or in CI.
2. **Compare**: every commit against the reference branch or a milestone, with a metrics diff against targets.
3. **Look**: the outputs themselves, side by side, synced, diffed and zoomed to the pixel.
4. **Find**: History across commits; hover to find the commit that regressed.
5. **Tune**: launch sweeps or black-box optimization from the browser, then analyse them.
6. **Gate** (experimental): fail CI when quality regresses, for changes made by people or by agents.

### Origin story (paraphrased, not a quote)
At Samsung Israel R&D Center since 2018, QA-Board is still the central platform, used by ~50 projects in production.
It gave image-quality engineers the tools to put their energy into the algorithms and software, not into QA logistics.
Today a team might start by forking MLflow; QA-Board is what you get after years of solving the problems that
forking a training tracker doesn't.

### Voice
- Confident and concrete, with no hype words.
- Every claim can be seen in a screenshot or verified in the code. Roadmap items live on the vision page, labeled.
- No internal hostnames, colleague names or ticket ids.
- Rules live in `website/STYLE.md`, including the terminology from `SIDEBAR.md`.

---

## 3. Demo projects (the sample data)

Real, runnable QA-Board projects under `examples/`:
- deterministic (seeded RNG) and small enough for a CI runner;
- license-clean inputs, listed in each project's `LICENSES.md`;
- they're both the screenshot data and the tutorial material.

| Project | Use case | What it computes | Showcases |
|---|---|---|---|
| `examples/image-quality` | Camera ISP / image enhancement | Simulated sensor (noise, Bayer) → demosaic → denoise → sharpen → tone-map; PSNR, SSIM, noise in flat patches, MTF50 on a slanted edge, runtime | Deep zoom on one 100MP+ image, synced zoom, perceptual diff + threshold, pixel tooltip, ROI histograms, auto-ROI, filters, per-stage dynamic outputs, targets, a fixed-point "HW model" platform for bit-accuracy, tuning |
| `examples/serving-latency` | Server performance / tail latency | A small Rust inference gateway (request queue, dynamic batching, worker pool, CPU "model") driven by an open-loop load generator; p50/p90/p99/p99.9, max, variance across repeats, throughput, CPU, batch sizes; knobs: workers, max batch, max batch delay, allocator, CPU pinning, queue policy | Latency CDF overlays (log tail), throughput-vs-p99 curves, flame graphs (CPU), per-core utilization, History, hover-to-find-the-regression, tuning sweep + efficient frontier, the gate failing on p99 |
| `examples/detection-eval` | CV / ML model evaluation | A permissively licensed detector (e.g. torchvision, BSD) at fp32 vs int8 vs input sizes; mAP, per-class recall, latency | Metrics Table/Diff per class, PR curves overlaid, images with boxes, HTML report, `qa optimize` + Analysis, milestones as model releases |
| `examples/robotics-3d` (phase 3) | Robotics / perception | Trajectory vs ground truth, point clouds, camera video | 6DoF viewer, point clouds, synced videos |
| `examples/agent-evals` (phase 3) | LLM / agent features | Text tasks scored by checks; pass rate, cost, latency, transcripts | Text diffs, HTML reports, the gate |

**Inputs:**
- Generated test charts (slanted edge, color checker, Siemens star) are ours outright.
- Photos and video come from public-domain or CC0 sources. Large ones are fetched from their original public URL
  with a checksum, and mirrored in R2 for CI.

**A story per project** (`examples/<name>/story.yaml`):
- ~4-6 weeks of history before a seed date T0.
- 30-60 commits on `main` and 3-4 feature branches.
- A fictional company and team of ~6 people with generated avatars, plus 2 milestones.
- One plot per project:
  - a shared cache that makes p50 faster but p99 45% worse (lock contention, visible in the flame graph), caught by the
    gate, fixed by sharding, then a tuning sweep picks the batching config on the efficient frontier;
  - a denoiser that wins PSNR but adds halos;
  - a quantized model that regresses on small objects and is tuned back.
- Failed runs with real-looking logs, and a run still in progress at capture time.

Every number on screen is actually computed. The contracts are in `examples/README.md` (the company and people),
`examples/STORY.md` (the story format) and `examples/<project>/SPEC.md`; the shot list is `docs-media/shots.yaml`.

Notes from the specs:
- The shared-cache commit that the gate catches is authored by "Kitefin Agent", the team's coding agent: the gate story
  is also the agent story. A second, subtler regression stays on `main` (it only hurts the heavy-tail test) so History
  has something to find.
- No CC0 detection dataset exists: detection labels come from a larger reference model, and the docs say so, unless a
  person reviews them (~1 hour for ~150 images).
- The demo projects are never connected to GitHub: the backend would look up avatars by committer name and could show
  a real person's photo next to a fictional name.

---

## 4. The media pipeline

```
examples/*  ──seed.py──►  stack (Compose + demo overlay)  ──snapshot──►  R2 qaboard-ci (private)
                                    │                                 └─► demo-data image (GHCR) for the quickstarts
                        shots/*.spec.ts (Playwright)
                                    │
             stills (PNG@2x → AVIF/WebP + LQIP) · clips (CDP screencast → MP4/WebM + poster) · terminal (VHS)
                                    │
                        publish.py: perceptual diff vs current → upload changed → website/media.json
                                    │
           R2 qaboard-media ──(fetched at build time)──► docs build ──► served same-origin to readers
```

### Layout
```
examples/<project>/                 # demo projects + story.yaml
docs-media/
  compose.demo.yml                  # overlay: results storage mounted in backend/nginx/cantaloupe, demo env
  seed.py                           # uv script: replay stories into a running stack (real `qa` CLI + fake CI env)
  snapshot.py                       # uv script: save/restore db + storage (R2), build the demo-data image
  shots/*.spec.ts                   # the shot list, one file per area
  shots/lib/                        # clock, waits (IIIF tiles, Plotly), cursor + caption overlay, shot()/clip()
  tapes/*.tape                      # terminal recordings (charmbracelet/vhs)
  publish.py                        # uv script: encode, dedupe by perceptual diff, upload, write the manifest
website/media.json                  # committed manifest: id → key, width, height, lqip, alt, captured, app version
website/plugins/media/              # downloads the manifest's files into the build (same-origin URLs)
website/src/components/{Shot,Clip,Compare,StackPicker}.tsx
.github/workflows/docs-media.yml
```

### Determinism
- **Capture from a restored snapshot**, not a fresh seed, because profiles and timings vary between runs.
- **Freeze `page.clock` at T0.**
- **Fixed rendering:** a 1440x900 viewport at 2x, pinned fonts, and `reducedMotion` for stills.
- **Stable page state:**
  - Pre-seed localStorage (What's new seen, panel states).
  - Wait for OpenSeadragon `fully-loaded` and Plotly `afterplot`.
  - Mask truly volatile bits.
- **No churn:** `publish.py` keeps the published image when the new one is within a perceptual-diff threshold.

### Stills, clips, terminal
- **Stills:**
  - Shot specs are code: `shot('commit/image-diff', {url, actions, locator, alt})`.
  - Captures stay clean. Call-outs are HTML overlays in the docs (`<Shot id callouts=[...]>`), so they're editable without re-capturing.
- **Clips:**
  - 6-20 s, silent and captioned.
  - Recorded with the CDP screencast at 30 fps (Playwright's own video is too low quality), with a fake cursor and click ripples.
  - Encoded to MP4 H.264 + WebM, with a poster frame. The hero clip stays under 2 MB.
  - With `prefers-reduced-motion`, readers see the poster.
- **Terminal:** VHS tapes for `qa run`, `qa batch`, `qa check-bit-accuracy`, `qa gate`, and the quickstart commands.
- **Build checks:** each shot carries its alt text, and a missing or unused shot fails the docs build.

### Storage and serving (R2 + `sivoov.app`, invisible to readers)
- **`qaboard-media`:** content-addressed (`shots/<id>/<hash>.avif`), immutable.
  - Its public hostname on `sivoov.app` (e.g. `qaboard-media.sivoov.app`) is used **only by build tooling**.
  - The docs plugin downloads the manifest's files into the build, so pages serve them same-origin from wherever
    the site is hosted, and readers never see the hostname.
  - Contributors see it in `website/media.json`, and `yarn start` loads from it directly.
- **`qaboard-ci`:** private; holds snapshots and PR preview galleries.
- **Why a public hostname at all:** builds then work anywhere without credentials: whatever publishes
  `samsung.github.io`, the in-app docs image (`QABOARD_DOCS_FOR_WEBAPP`), air-gapped site builds behind a proxy,
  and contributors' laptops. Only the media workflow writes, through the S3 API.
- **Secrets:** `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, scoped to the two buckets.
- **Cleanup:** a lifecycle rule deletes objects no manifest has referenced for 90 days.
- **GitHub Pages limits:** 1 GB per site and ~100 GB/month of soft bandwidth.
  - Budget: ~60 stills × 2 formats + ~15 clips ≈ 60-100 MB.
  - Videos use `preload="none"` and only play when in view.
  - If traffic ever outgrows Pages, media can move to a CDN hostname on a project domain.
- **Optional:** PR previews of the whole docs site on Cloudflare Pages (`<branch>.<project>.pages.dev`, no custom
  domain), using a Pages-scoped Cloudflare token.

### When it runs (`.github/workflows/docs-media.yml`)
| Trigger | What happens |
|---|---|
| `workflow_dispatch` (`only` glob, `reseed`, `publish`) | The main way: regenerate some or all shots |
| PR labeled `docs-media` | Capture the affected shots, upload, commit `website/media.json` to the PR, comment a before/after gallery |
| Tag `v*` | Full refresh, rebuild the demo-data image, open a PR |
| Monthly (with the release notes) | Full refresh; opens a PR only if something changed beyond the threshold |

- Never on every push.
- Runtime: 15-30 min from a snapshot. Re-seeding the three phase-2 stories takes ~70 min on a 4-CPU runner (serving-latency
  measures performance, so it must run alone): seed each project in its own parallel job and merge the snapshots.
- Fork PRs never see the secrets.

### The same demo data, several payoffs
1. Screenshots and clips.
2. **Local quickstarts with data** (§5): the demo-data image restores the database and results into Compose or Helm.
3. **The Kubernetes CI test** installs the chart with that data and checks real pages.
4. **A hosted demo later**, when hosting is possible: it needs nothing new.

---

## 5. Quickstarts and the GitHub-first tutorial

### The stack picker
A `<StackPicker>` at the top of the quickstart and the tutorials sets every tab group at once.
- **How it works:** Docusaurus `<Tabs groupId=... queryString>`. The choice persists across pages (localStorage), and
  links carry it (`?server=k8s&ci=github-actions`).
- **Defaults:** GitHub everywhere, since GitHub comes first.

| Group | Tabs |
|---|---|
| `server` | Docker Compose · Kubernetes (Helm) |
| `forge` | GitHub · GitLab |
| `ci` | GitHub Actions · GitLab CI · Jenkins |
| `runner` | Local · LSF · Dask · Celery |
| `code` | Python · Any executable (C++, shell...) |

**Docs that are tested:** every Compose, Helm and GitHub Actions snippet is copied from files that CI runs.
- A check fails if a snippet drifts from its source file.
- GitLab CI and Jenkins snippets are lint-checked and marked "tested manually".

### Quickstart: "QA-Board with demo data in 5 minutes"
- **Docker Compose:** `curl` one compose file → `docker compose up` → open `localhost:5151`.
  - The demo-data container restores the database and results on first start.
- **Kubernetes:**
  - `kind create cluster --config <ours>`, then `helm install qaboard oci://ghcr.io/.../qaboard -f quickstart.yaml`, then `kubectl port-forward`.
  - Also k3d, minikube and Docker Desktop; differences live in a tab.
- **Then:** the same 4-click tour of the demo (screenshots next to each step), then "wrap your own code" → tutorial.

### Kubernetes quickstart that works (own subagent, WS8)
- **Publish current images and the chart:**
  - Versioned images (`<service>-<version>` plus release tags) on every master build and release.
  - The chart as an OCI artifact.
  - **Recommended registry:** GHCR. It needs no extra secret (the workflow's `GITHUB_TOKEN`) and avoids Docker Hub's strict
    anonymous pull limits, which bite users behind a corporate NAT. Docker Hub stays as a mirror, once its secrets are set.
- **Chart: a first-class `results` value:**
  - A PVC, an existing claim, NFS or hostPath, mounted at the same path into backend, proxy and Cantaloupe.
  - It sets `QABOARD_STORAGE_ROOTS` automatically.
  - It replaces three hand-wired `extraVolumes`; the existing values keep working.
- **`quickstart.yaml` values:** embedded Postgres, single replicas, Cantaloupe on, no ingress (port-forward), and a demo-data Job.
- **Running `qa` against the cluster:**
  - From the laptop: a kind `extraMounts` gives the same absolute path on the host and the node.
  - Or in the cluster: a toolbox Job using the backend image, which already ships the CLI.
- **CI job `helm-e2e`:**
  - kind on the GitHub runner, load the images built in the same run, `helm install` with `quickstart.yaml`, wait, then smoke tests.
  - Run an example batch in-cluster and check it through the API.
  - Run a Playwright check that the commit page renders the demo data.
  - Test `helm upgrade` from the previous release.
- **Real clusters:** a docs page covering RWX storage classes (NFS, EFS, Filestore, Azure Files), ingress + TLS, SSO,
  CloudNativePG, backups, and why ingest must stay behind the firewall until token auth lands.

### GitHub-first tutorial: "Your project on QA-Board"
1. **Start a server** (`server` tabs). Or point to an existing one.
2. **Install the CLI:** `uv tool install qaboard` (pip in a tab).
3. **Wrap your code:** `qa init --template image-quality`, or your own code (`code` tabs).
4. **Run and share:** `qa run` on one input, `qa --share batch` on a test set, then open the link.
5. **Connect the repo** (`forge` tabs): webhook, avatars, links to commits and diffs.
6. **Run in CI** (`ci` tabs).
   - Today the runner must see the results storage: a self-hosted GitHub Actions runner, GitLab runners on your
     cluster, or Jenkins agents.
   - The tutorial says so plainly. GitHub-hosted runners need **HTTP upload of outputs**, the first "Next" roadmap item.
7. **Compare and gate:** add `qa gate` (experimental) and get a failing check on a regression.
8. **Scale out** (`runner` tabs): local multiprocessing, LSF, Dask, Celery.

**Honest constraint:** the tutorial is as GitHub-first as the architecture allows today. HTTP upload plus
token-authenticated ingest would make GitHub-hosted runners work end to end, so they're the highest-leverage
product items after this effort. **(decide)** whether to pull them in after phase 2.

---

## 6. Website: information architecture and landing page

### Sidebars
Navbar: Product · Docs · Use cases · Roadmap · Release notes · Blog · GitHub.
- **Get started** (new): the quickstart (§5), the GitHub-first tutorial (§5), and concepts in one page.
- **Product tour** (new): "QA-Board in 5 minutes" following the story spine, one clip per step.
- **Use cases** (new): one page per demo project: the problem, the workflow, screenshots from that project, the
  config that produces them, and "run this example".
- **Tutorials** (new):
  - hunt a performance regression;
  - tune parameters from the browser;
  - set up a quality gate (experimental);
  - self-host for your team (Compose / Helm).
- **Recipes** (new cookbook, short task pages):
  - Comparing and investigating:
    - compare against a milestone;
    - find the commit that broke a metric;
    - share a link to an exact crop/zoom;
    - metrics with targets and pass/fail.
  - Outputs and visualizations:
    - dynamic per-frame outputs;
    - flame graphs from py-spy/perf;
    - side-by-side videos;
    - export results for a report.
  - Running and integrating:
    - query the API from a notebook;
    - run on LSF / Dask / Celery / Kubernetes;
    - monorepos;
    - bit-accuracy before a HW handoff;
    - W&B or TensorBoard alongside QA-Board.
  - Agents: let a coding agent run `qa` and read the Metrics Diff (works today, CLI + API).
- **User guide:** keep the text, replace every screenshot, add clips.
- **Project integration:** deduplicate overlapping pages:
  - outputs / faq / sharing;
  - milestones / comparing-results;
  - installation / qa-cli;
  - runner precedence.
- **Admin:** generic self-hosting only (Compose, Helm, auth, storage, upgrades, troubleshooting). The SIRC runbooks
  move next to `deployments/sirc`, as `docs/known-issues.md` already intends.
- **Reference** (generated, so it can't drift):
  - the CLI from Click;
  - `qaboard.yaml` and `metrics.yaml` from a JSON Schema, also published for editor autocomplete;
  - the REST API from an OpenAPI spec.
- **Why QA-Board** (the comparison, §2) and **Roadmap / vision** (§8).
- **Moves and links:**
  - Every moved page gets a redirect.
  - The ids the app links to stay stable: `user-guide/overview`, `user-guide/files`, `visualizations`,
    `computing-quantitative-metrics`, `installation`, `triggering-third-party-tools`,
    `batches-running-on-multiple-inputs`, `celery-integration`, `auto-optimization`.

### Landing page (rebuilt from scratch)
1. **Hero:**
   - Headline and a one-line subhead.
   - CTAs: **"Run it locally in 5 minutes"** (the quickstart) and "Get started", plus GitHub stars.
   - Visual: a 15-20 s muted loop of the commit page (synced zoom on an image diff → threshold → Metrics Diff), poster first.
2. **Proof strip:** open source (Apache 2.0), self-hosted, born at Samsung Israel R&D Center in 2018, the central
   quality platform for ~50 projects in production there.
3. **"You already built half of this"**: the in-house pain, in the reader's words.
4. **The loop:** Run · Compare · Look · Find · Tune · Gate, as tabs with one clip each.
5. **Use cases:** 5 cards linking to the use-case pages.
6. **"Polish you'd never build in-house"**: a grid of ~12 micro-clips and stills.
7. **Fits your stack:** GitHub/GitLab/Jenkins, LSF/Dask/Celery/Kubernetes, LDAP/SAML, Compose/Helm, air-gapped installs.
8. **Where we're going:** 3 roadmap highlights → roadmap page.
9. **Quotes** from people who used it and miss it, with permission.
10. **CTA,** plus the latest release-note highlights (the component already exists).

**Budgets:**
- LCP under 2.5 s on 4G (the poster is the LCP element).
- No layout shift: the manifest has dimensions.
- Under 4 MB total with lazy clips.

### Site plumbing
- **Canonical URL:** `samsung.github.io/qaboard`, deployed from the official `Samsung/qaboard` repository. Media works the
  same wherever the site is built (§4).
- **Deploys:** use `actions/deploy-pages` (artifact-based) rather than committing builds to a `gh-pages` branch.
- **Search:** keep Algolia if the `samsung_qaboard` index still crawls the live site; otherwise `docusaurus-search-local`.
- **Analytics:** Cloudflare Web Analytics (cookie-free, no custom domain involved).
- **Build checks:** `yarn build` on PRs, `onBrokenLinks: 'throw'`, and a weekly external link check.
- **Social card:** a new one generated from a shot.

---

## 7. Product work in this effort

### Small gaps (phase 0, one PR)
| Item | Size |
|---|---|
| `qatools_config`/`qaboard_config` key bug in `CiCommit.get_or_create`; `commit_branch=None` crash | S |
| History page: empty sidebar, untitled compare tab, `href`s that reload the app (`webapp/TODO.md`) | S |
| Turn off the SLAM viewer's Plotly "Send to Cloud" (also a data-leak risk) | XS |
| Avatars without GitLab: accept an avatar URL or email (Gravatar) in the payload, plus GitHub-hosted projects | S |
| Broken links from the app (`lsf-cluster-integration`, spectrum.chat) and the missing images | XS |
| `.gitignore` image rule scoped so `website/static/img/` brand assets can be committed | XS |
| `qa init --template <example>` scaffolds from `examples/` | S |

Dark mode and a command palette go on the roadmap, not into this effort: early screenshots without them are fine.

### Release plumbing (phase 0-1, part of WS8)
- Publish versioned images and the chart (GHCR recommended), and attach the demo-data image to releases.
- Add a first-class `results` storage value to the chart.

### Quality gate v1, experimental (phase 2, WS9)
```yaml
# qaboard.yaml (experimental: may change without notice)
gate:
  reference: main              # branch, milestone or commit; default: project.reference_branch
  batches: [ci]
  rules:
    - {metric: psnr, max_regression: 1%}              # median over tests, vs the reference
    - {metric: latency_p99, max_regression: 5%}
    - {metric: map, min: 0.42}                        # absolute floor
    - {metric: psnr, per_test_max_regression: 5%}     # no single test worse than this
  max_failed_runs: 0
  require_bit_accuracy: false
```

**`qa gate`:**
- **Exit codes:**
  - 0: pass.
  - 1: regression.
  - 2: undecidable (reference missing or still running; `--wait` polls).
- **Output:** a text, Markdown or JSON table. On GitHub it's also written to `$GITHUB_STEP_SUMMARY`.
- **`--post-status github|gitlab`:** posts a commit status that links to the Metrics Diff. On GitHub this uses
  `GITHUB_TOKEN` with `statuses: write`; GitLab uses a token. The job's own exit code already acts as the check.

**Backend:**
- A new `GET /api/v1/commit/<sha>/compare?reference=&batch=` returns per-metric aggregates: medians, per-test deltas, pass rates.
- Tests prove it gives the same numbers as the Summary and Metrics Diff views.
- The CLI, the future MCP server and API users all share this one endpoint.

**Labelled experimental everywhere:** docs page badge, CLI notice, release note.

**Tested in CI:** the `serving-latency` story has a commit where the gate must fail on p99 and a fix where it must pass.

---

## 8. Vision and roadmap page

A public page, "Where QA-Board is going", plus a GitHub Project board for discussion and votes. Statuses are honest:
**Shipped**, **Experimental**, **Next**, **Exploring**. The landing page only claims Shipped and Experimental items.

**Principles:**
- Your data stays yours: self-hosted, air-gap friendly.
- Look at outputs, not just numbers.
- Fit existing workflows: QA-Board shouldn't need to be the entrypoint.
- Humans and agents review quality together.

| Theme | Items | Status (proposed) |
|---|---|---|
| **Compare more than two** | N-way comparisons: pick N commits, batches or tuning runs and see outputs in a grid per input, metrics tables with N columns, plots overlaid; "this vs the last 5 milestones"; saved, shareable comparison views | Next |
| **Deep learning** | Step-indexed metrics per run (training curves, not only final scalars); overlay convergence plots from N runs on one graph; hyper-parameter tables and parallel coordinates across runs (exists for tuning, generalize); evaluate every checkpoint; dataset slices; confusion-matrix viewer | Exploring (overlays: Next) |
| **Log from your code** | A Python SDK with a W&B-style API (`qaboard.init()`, `run.log({...})`, `run.log_image()`, `run.finish()`) that works in training loops, notebooks and pytest, without `qa run`; a shim that mirrors existing `wandb.log` calls; importers for W&B/MLflow/TensorBoard runs; MLflow tracking-API compatibility to evaluate | Next (SDK), Exploring (shim, compat) |
| **Cloud-native** | HTTP upload of outputs (unlocks GitHub-hosted runners and clusters without shared volumes); token-authenticated ingest; object storage for results (S3/R2/GCS/MinIO; Cantaloupe can read S3); a Kubernetes Job runner; published images and chart | Next (upload, ingest auth); images/chart Shipped in this effort |
| **Enterprise** | Admin UI for users and groups; project-level roles and permissions; OIDC SSO next to LDAP/SAML; SCIM provisioning; API tokens UI; audit log; retention and quota policies UI; usage analytics; HA and backups (chart supports CloudNativePG); air-gapped installs | Exploring (air-gapped, HA: Shipped) |
| **Collaboration** | Comments pinned to an output region or log line; review and "approve as new reference" with who/when; notifications (Slack/Teams/email) on regressions and finished batches | Exploring |
| **Agents** | Quality gate (v1); OpenAPI spec and `--json` outputs; an MCP server (`qa mcp`: read results, metrics diffs, failing tests, image crops; then start batches); an agent kit (`AGENTS.md`/skill template: "run the batch and read the Metrics Diff before claiming it's better"); agent-authored badges; agents proposing tuning experiments; Metrics Diff summaries on PRs | Experimental (gate), Next (OpenAPI, MCP read-only), Exploring (rest) |
| **Polish** | Dark mode; command palette (projects, branches, commits, views); date ranges in the URL; faster huge batches | Next (dark mode), Exploring (rest) |

The statuses are my proposal; you curate them before the page goes live.

---

## 9. Execution with subagents

Agents work in parallel against fixed contracts. I coordinate, review and merge; you review at the checkpoints.

### Contracts (phase 0, before any fan-out)
- The `website/media.json` schema, and the `<Shot>/<Clip>/<StackPicker>` component APIs.
- Shot id naming (`<area>/<subject>`) and the shot list (appendix).
- The `story.yaml` format and the persona/company bible (fictional, trademark-checked name, generated avatars).
- `website/STYLE.md`: voice, terminology, the claim-verification rule, captions that say what to notice.
- Docs can be written before the media exist: `<Shot id>` renders a labeled placeholder until the manifest has it.

### Workstreams
| # | Workstream | Agents | Depends on | Output |
|---|---|---|---|---|
| WS0 | Groundwork | me | decisions | contracts, small gaps (§7), SIRC runbooks moved, site config |
| WS1 | Demo projects | 1 per project | contracts | `examples/*` runnable, deterministic, licensed, story, README |
| WS2 | Seeder + demo data | 1 | WS1 (one project) | `compose.demo.yml`, `seed.py`, `snapshot.py`, demo-data image |
| WS3 | Capture + publish | 1 | WS2 | shot/clip helpers, VHS tapes, `publish.py`, R2, docs build plugin, `docs-media.yml` |
| WS4 | Website platform | 1 | contracts | components, stack picker, IA + redirects, landing page, search, analytics, generated references |
| WS5 | Content | 4-6 by section | WS4 contracts | quickstart and tutorial text, tour, use cases, recipes, user-guide refresh, dedupe, comparison, roadmap page, blog |
| WS8 | Kubernetes quickstart | 1 | none (demo data from WS2 later) | published images + chart, `results` storage value, `quickstart.yaml`, `helm-e2e` CI job, cluster docs |
| WS9 | Quality gate v1 | 1 | none (`serving-latency` story for e2e) | compare endpoint, `qa gate`, statuses, docs, release note |
| WS7 | Review | 3 standing | each PR | claims vs code, visual QA of every image (no internal data, spinners, empty or error states), links/build |

### Phases
- **Phase 0, groundwork** (one session):
  - Open decisions, contracts, small gaps.
  - WS8 starts right away: publishing images and the chart doesn't depend on anything.
- **Phase 1, vertical slice:**
  - `examples/image-quality`, the seeder, a snapshot, ~8 stills, 2 clips and 1 tape → R2 → served from the
    docs build on two user-guide pages, triggered by `workflow_dispatch`.
  - In parallel: the roadmap page (no media needed) and the first `helm-e2e` green run.
  - **Checkpoint:** you look at the images, the clip and the workflow run.
- **Phase 2, breadth:**
  - Perf and detection projects, the full shot list (~60 stills, ~15 clips).
  - Quickstart and GitHub-first tutorial with stack tabs, on top of a working Kubernetes quickstart.
  - Landing page, user guide fully re-illustrated, tour, use-case pages, gate v1.
  - **Checkpoint:** landing page preview, plus you run both quickstarts yourself.
- **Phase 3, story and reach:**
  - Recipes, the comparison page, generated references.
  - Blog relaunch: "QA-Board in 2026", "Why every algorithm team builds a worse QA-Board", "Reviewing agents' changes like algorithms".
  - Robotics and agent demo projects; an optional 2-min tour assembled from the clips.
- **Later:**
  - A hosted demo when hosting is possible: the demo-data image + Helm values are all it needs.
  - HTTP upload and ingest auth if you pull them in **(decide)**.

Multi-agent fan-outs run as workflows of under 10 agents each, each agent in its own worktree.

**Branches:** this session can only push to `claude/qaboard-docs-overhaul-z0u9rt`. For reviewable PRs, allow me one
branch per workstream (`claude/docs-<ws>`); otherwise everything lands here, phase by phase.

---

## 10. Decisions

**Decided:**
- **Demo:** no hosted or static demo for now. Local quickstarts (Compose + Kubernetes) with demo data instead.
- **Tutorial:** GitHub-first, with a stack picker.
- **Kubernetes quickstart:** its own workstream, tested in CI.
- **Polish:** small gaps get fixed; early screenshots may lack the bigger polish.
- **`sivoov.app`:** OK as long as readers never see it: build-time media host only.
- **Gate:** v1 ships as experimental.
- **Roadmap page:** includes N-way comparisons, enterprise, deep-learning overlays and a W&B-style SDK.

- **Official repository:** `Samsung/qaboard`; `arthur-flam/qaboard` is a working fork. Every user-facing link, image and chart
  points to the official one: `ghcr.io/samsung/qaboard`, issues on `Samsung/qaboard`. Workflows derive the owner from the
  repository, so forks publish to their own namespace.
- **Registry:** GHCR (Docker Hub stays an optional mirror). A Samsung org admin must allow Actions to publish packages and make
  the packages public.
- **What we may say:** born at Samsung Israel R&D Center in 2018, ~50 projects in production, still the central platform.
  No quotes for now.
- **HTTP upload:** yes, designed properly first (design doc in phase 0, `docs/design/http-upload.md`), built after phase 2.
- **Demo fiction:** Kitefin Robotics (working name, no collision found), a company building camera robots with a model-serving
  backend: image quality, perception, serving latency, SLAM and agent evals all fit one believable team.

- **Docs URL:** `samsung.github.io/qaboard` stays canonical.
- **Branches:** one per workstream, `claude/docs-*`, each with its own PR.

**Open:** none in this plan; the HTTP upload design (`docs/design/http-upload.md` §12) has its own questions for when it's built.

**From you:**
- The R2 buckets and token (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`).
- A `sivoov.app` hostname for `qaboard-media`.
- Optionally a Pages-scoped Cloudflare token for PR previews.
- Photos you own and can release, and 3-5 quotes from former colleagues.

---

## 11. Risks
- **Heavy stack in CI:** the backend compiles uwsgi/lxml/xmlsec and Cantaloupe is Java.
  - Mitigated by the existing bake cache, capturing from snapshots, and reusing built images in `helm-e2e`.
- **Pretty but untrue docs:** a claims reviewer traces every feature claim to code, and roadmap content is labeled.
- **Snippet drift:** snippets are generated from tested files, and CI fails when they differ.
- **Fixture rot:** the snapshot is re-seeded when `examples/`, the seeder or the backend models change (hash key).
- **Clip weight and Pages bandwidth:** hard budgets enforced by `publish.py`; the CDN escape hatch is in §4.
- **Unauthenticated ingest:** quickstart and cluster docs say to keep the server behind the firewall until token auth ships.
- **The gate's credibility:** noisy metrics make flaky gates. Rules use medians and per-test thresholds, "undecidable"
  is a distinct exit code, and the feature stays experimental until it has been used on real projects.

---

## Appendix: shot list (first cut, ~60 stills / ~15 clips)
**Legend:**
- Demo projects: **IQ** image-quality, **PERF** serving-latency, **DET** detection-eval, **R3D** robotics-3d, **AG** agent-evals.
- 🎬 marks a clip; 🖥 marks a terminal tape.

**Quickstart and CLI**
- 🖥 `quickstart/compose`: `docker compose up` to a running server with data
- 🖥 `quickstart/kind`: kind + `helm install` + port-forward
- 🖥 `cli/first-run`: `qa run` on one input, link printed (IQ)
- 🖥 `cli/batch`: `qa batch` with progress (DET)
- 🖥 `cli/bit-accuracy`: `qa check-bit-accuracy` failing, then passing (IQ)
- 🖥 `cli/gate`: `qa gate` failing on the regression commit (PERF)
- `ci/step-summary`: the gate's Markdown summary, rendered (PERF)

**Projects and commits**
- `projects/home`: cards, favorites, filter
- `commits/feed`: commits grouped by day, branch tags, crashed/pending tags (PERF)
- `commits/branch-evolution`: metrics over time on a branch (PERF)
- `commits/filter`: branch suggestions and "go to commit" (PERF)
- `integrations/menu`: integrations with statuses (IQ)

**Commit page: metrics**
- `commit/summary`: metric tiles, deltas, pass-rate bars, new vs ref histograms (DET)
- `commit/metrics-table`, `commit/metrics-diff`: quality and improvement reports (DET)
- `commit/milestone`: star a commit as a milestone (DET)
- `commit/batch-picker`, `commit/output-filter`: batch selector, negative/regex filters (IQ)

**Commit page: outputs**
- `commit/image-sbs`: new vs ref side by side (IQ)
- 🎬 `commit/image-diff`: synced zoom → perceptual diff → threshold slider (IQ)
- `commit/pixel-tooltip`, `commit/roi-histograms`, `commit/auto-roi`, `commit/image-filters` (IQ)
- 🎬 `commit/deep-zoom`: a 100MP+ image from overview to pixels (IQ)
- 🎬 `commit/dynamic-outputs`: a synced slider across ISP stages (IQ)
- `commit/plotly-overlay`: PR curves with a dashed reference (DET)
- `commit/flame-diff`: differential flame graph (PERF)
- `commit/text-diff`: Monaco diff with "Next Diff" (AG or PERF config dumps)
- `commit/html-report` (DET), `commit/video-sync` (R3D), `commit/pointcloud` (R3D), `commit/trajectory-6dof` (R3D)
- `commit/output-files`: bit-accuracy tree, "Bit-accurate" tag (IQ fixed-point)
- 🎬 `commit/bit-accuracy-diff`: Ctrl-click two files to diff them in place (IQ)
- `commit/controls-panel`, `commit/export` (IQ), `commit/run-menu` (PERF), `commit/artifacts-configs` (DET)

**Logs**
- 🎬 `logs/live-tail`: live log, error count, jump to the next error (PERF)
- `logs/lsf-hints` and `logs/batch-commands` (PERF)

**History**
- `history/performance-over-time`: per-test lines with a target (PERF)
- 🎬 `history/find-regression`: hover across commits, inline output card, freeze the reference (PERF)
- `history/relative` (PERF), `history/image-diff`: output files over time (IQ)

**Tuning**
- `tuning/available-tests`: Monaco batches editor and problems panel (DET)
- `tuning/which-tests-run`, `tuning/manual-form`, `tuning/auto-form` (DET)
- 🎬 `tuning/launch-to-analysis`: launch a sweep, see the Analysis (DET)
- `tuning/analysis`: convergence, sensitivity, parallel coordinates, frontier (DET)

**Files and global**
- `files/browser`, `files/runbar`, `files/hotkeys` (PERF)
- `whats-new/dialog`, `whats-new/drawer`, `auth/login`

**Landing**
- 🎬 `landing/hero` (15-20 s loop)
- One 🎬 per loop step, reused from above
- `landing/social-card`
