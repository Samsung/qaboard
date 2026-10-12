# Docs, screenshots and positioning overhaul: plan

Status: proposal, nothing generated yet. Written 2026-10-12 after a full audit of `website/`, `webapp/`,
the backend ingest path and CI. Decisions marked **(decide)** need the maintainer; each has a recommendation.

## TL;DR
- The product is in much better shape than the website. The user guide text is recent and good, the
  web app got a lot of polish in 2026, but every screenshot and the whole landing page date from 2019-2020
  (old "KPIs" sidebar, "QA" header, PowerPoint call-outs, real employee names). That is most of why the
  project looks inactive.
- Build **one pipeline** with three payoffs: demo projects + a seeder fill a real stack with a believable
  story, then a Playwright shot list captures stills and clips to R2. The same seeded snapshot later powers
  a public read-only demo and a "try it locally with demo data" quickstart.
- Heavy runs are **opt-in**: manual dispatch, a PR label, release tags, and a monthly refresh. Never on every push.
- Reposition from "experiment tracker" (a crowded, ML-training category) to **"results review for
  algorithm teams"**: the thing every team ends up building badly in-house. Agents come in as a
  roadmap/vision story, backed by one real feature (a CI quality gate) before we market it.
- Execution is mostly subagents in parallel workstreams with fixed contracts (shot ids, manifest
  schema, story format), in 4 phases. Phase 1 is a thin vertical slice that proves the pipeline end to end
  before anything scales.

---

## 1. Where we are (audit summary)

**Website** (`website/`, Docusaurus 3.10, GitHub Pages)
- 51 doc pages in 3 sidebars (User guide / Project integration / Admin). The user guide (Oct 2026) is good;
  "Getting started" and several guides are 2020-era: `introduction` embeds a SlideShare, links `https://qa`.
- ~40 web-app screenshots, all 2019-2020 UI, some captioned "older screenshot". 4 GIFs (5 MB). No videos
  except one YouTube embed. 5 referenced images are missing (4 deep-learning GIFs, the social card).
- Landing page (`src/pages/index.js`): 2019 slide crops with orange arrows, typos, `<title>` is
  "Hello from QA-Board", hero CTA goes to the stale intro, "I run the server" goes to a SIRC runbook.
- Site config still says `url: https://samsung.github.io`, `organizationName: Samsung`, edit links to
  `Samsung/qaboard`, Algolia DocSearch index `samsung_qaboard`. No analytics, no PR build check.
- Public docs contain internal runbooks: `backend-admin/{deployment,troubleshooting,host-upgrades,
  getting-SSL-certiticates-from-IT}` and parts of `start-server`/`kubernetes` (internal hosts, paths,
  registry). `dag-pipelines` is a design proposal naming colleagues.
- Blog: 2 posts, both 2020. Release notes: very active (37 notes, monthly in 2026), wired into the app.
- Root `.gitignore` ignores `*.png *.jpg *.gif *.svg *.ico`: new screenshots are silently not committed.

**Web app** (React 19 / Blueprint 6 / Vite 8): rich and screenshot-friendly, since most state is in the URL
(`selected_views`, `batch`, `reference`, `filter`, `controls`, `#whats-new`...). Notable polish to show off:
synced zoom/pan + crosshair across cards, perceptual image diff with threshold, pixel tooltip, ROI
histograms, "Find regions of interest", image filters, IIIF deep zoom on 100MP+ images, dynamic outputs
with synced sliders, Plotly overlays, differential flame graphs, Monaco text diff, video sync, point clouds,
6DoF trajectories, bit-accuracy file tree with in-place diff, live log tail with LSF hints, keyboard-driven
file browser, Monaco batch editor with conflict handling, tuning forms + analysis (convergence,
sensitivity, parallel coordinates), milestones, integrations menu, What's new dialog/drawer.
Gaps that screenshots will expose: no dark mode, no command palette, History page sidebar empty and an
untitled tab, Plotly "Send to Cloud" button in the SLAM viewer (all listed in `webapp/TODO.md`).

**Data**: no demo project (only `qaboard/sample_project`, which computes nothing), no seed data, no
fixtures beyond tiny inline e2e mocks. But a fresh stack can be filled without git/GitLab/LSF:
`POST /api/v1/output/` is unauthenticated and git-free when payloads carry the `commit_*` fields, or the
real `qa` CLI can run with fake CI variables (`CI=1 GITHUB_SHA=... GITHUB_REF=...`). Output files must sit
under the storage root mounted into backend, nginx and Cantaloupe (`deployments/example.yml`).
Seeder gotchas found: `commit_branch` must be set (`to_dict` crashes on `None`), and
`CiCommit.get_or_create` tests `'qatools_config' not in data` against a payload keyed `qaboard_config`, so
every new commit overwrites the project config (`backend/backend/models/CiCommit.py:265`, a real bug to fix).
Committer avatars only come from GitLab/GitHub APIs.

**CI**: GitHub CI already builds every image with a layer cache, brings the full stack up
(`deploy.py deployments/production.env up --init`) and smoke-tests it on a 4-CPU runner. The screenshot
job reuses that path. Playwright already runs in CI (mocked API, `webapp/e2e/`).

**Agents/LLMs**: nothing in the code yet. Building blocks: REST API with bearer tokens,
`qa check-bit-accuracy` (exit code), `target_passfail` metrics. No GitHub check runs or commit statuses
(`docs/github-support-roadmap.md` lists them as deferred).

---

## 2. Positioning and narrative

### Who we're for
Teams whose output quality can't be captured by pass/fail tests: camera/ISP and imaging, computer vision
and ML model evaluation, robotics/automotive perception, embedded and HW/SW co-design (bit-accuracy),
performance engineering. The buyer is the tech lead or manager currently maintaining a pile of scripts,
spreadsheets, an internal Flask dashboard and screenshots pasted in Slack.

### The pitch
> **Tests tell you it runs. QA-Board shows you it's better.**
> Every commit and every experiment runs on your test set; QA-Board puts the outputs side by side
> (images, plots, flame graphs, logs, metrics) so your team can see what changed, agree it's better and ship it.
> Self-hosted, git-native, built for heavy data.

Short form for social cards / GitHub description: *"Code review for results."*
Category we claim: **results review** (or "quality CI"), not "experiment tracking".

### Why not X (to be written honestly, as a comparison page)
| Alternative | What it's great at | Where QA-Board wins |
|---|---|---|
| In-house dashboard + scripts | Fits exactly, at first | Years of polish you won't build: deep zoom, synced diff, tuning, runners, bit-accuracy, file browser, auth |
| W&B, MLflow, Comet, ClearML | Training runs, scalar curves, model registry | Output-centric (look at the results, not just numbers), commit-centric, any algorithm, self-hosted, no per-seat pricing |
| CodSpeed, Bencher, asv | Micro-benchmarks on PRs | Perf *and* output quality in one place, flame graph diffs, real workloads on your data |
| LangSmith, Braintrust | LLM traces and evals | Not limited to text/LLMs; same review loop for every algorithm |
| Notebooks | Exploration | Persistent, comparable, shareable by link |

Context worth one sentence, not a campaign: Neptune's hosted tracker shut down in March 2026 after its
acquisition; self-hosted open source is a real argument for buyers who got burned.

### Story spine (used by the landing page, the tour and the tutorials)
The evaluation loop, one step per section, each with a clip:
1. **Run**: wrap your code with `qa`, run on a batch of inputs locally, on a cluster or in CI.
2. **Compare**: every commit against the reference branch or a milestone; metrics diff with targets.
3. **Look**: the outputs themselves, side by side, synced, diffed, zoomed to the pixel.
4. **Find**: History across commits; hover to find the commit that regressed.
5. **Tune**: launch parameter sweeps or black-box optimization from the browser, analyse them.
6. **Gate**: block merges that regress quality, for humans' and agents' changes alike (roadmap: §8).

### Voice
Confident and concrete, no hype words. Every claim is something you can see in a screenshot or verify
in the code. Second person, task-first. No internal hostnames, colleague names, ticket ids. A style guide
(`website/STYLE.md`) gives agents these rules plus terminology from `SIDEBAR.md`
(Summary / Metrics Table / Metrics Diff / Outputs / Source / Tuning / Integrations).

---

## 3. Demo projects (the sample data)

Real, runnable QA-Board projects under `examples/`, deterministic (seeded RNG), small enough for a CI runner,
with license-clean inputs. They are both the screenshot data and the tutorial material
("clone `examples/image-quality` and run it").

| Project | Use case | What it computes | Showcases |
|---|---|---|---|
| `examples/image-quality` | Camera ISP / image enhancement | Simulated sensor (noise, Bayer) → demosaic → denoise → sharpen → tone-map; PSNR, SSIM, noise in flat patches, MTF50 on a slanted edge, runtime | IIIF deep zoom on one 100MP+ image, synced zoom, perceptual diff + threshold, pixel tooltip, ROI histograms, auto-ROI, filters, per-stage dynamic outputs, targets, a fixed-point "HW model" platform for bit-accuracy, tuning denoise strength |
| `examples/perf-regression` | Software performance | A small library benchmarked on realistic inputs: p50/p95 latency, throughput, peak RSS; sampling-profiler flame graphs | History over 6 weeks, the hover-to-find-the-regression flow, differential flame graph, latency Plotly overlays, logs, metrics with `smaller_is_better` |
| `examples/detection-eval` | CV / ML model evaluation | A small permissively licensed detector (e.g. torchvision, BSD) at fp32 vs int8 vs input resolutions; mAP, per-class recall, latency | Metrics Table/Diff per class, PR curves overlaid, images with boxes, HTML report, `qa optimize` tuning + Analysis view, milestones as model releases |
| `examples/robotics-3d` (phase 3) | Robotics / perception | Trajectory estimation vs ground truth, point clouds, camera video | 6DoF viewer, point clouds, synced videos |
| `examples/agent-evals` (phase 3) | Evaluating LLM/agent features | Text tasks scored by checks; pass rate, cost, latency; transcripts | Monaco text diffs, HTML reports, the gate (§8) |

Inputs: procedurally generated test charts (slanted edge, color checker, Siemens star) are ours outright;
photos and video from public domain / CC0 sources, listed in each project's `LICENSES.md`. Large inputs live
in R2 (`demo-inputs/`, content-addressed, checksums in the repo), never in git.

**A story per project** (`examples/<name>/story.yaml`): ~4-6 weeks of history relative to a seed date T0,
30-60 commits on `main` and 3-4 feature branches, a fictional team of ~6 people with generated avatars,
2 milestones (releases), and one plot each: a perf regression introduced then fixed; a denoiser change
that wins PSNR but adds halos (visible in the image diff); a quantized model that regresses on small
objects and gets tuned back. Plus failed runs with real-looking logs, and one run still in progress at
capture time (for the live-log clip). The story drives the code changes (parameters/flags per commit), so
every number on screen is actually computed.

---

## 4. The media pipeline

```
examples/*  ──seed.py──►  stack (docker compose, demo overlay)  ──snapshot──►  R2 (private): db.dump + storage.tar.zst
                                     │
                         shots/*.spec.ts (Playwright)
                                     │
               stills (PNG@2x → AVIF/WebP + LQIP) · clips (CDP screencast → MP4/WebM + poster) · terminal (VHS)
                                     │
                         publish.py: perceptual diff vs current → upload changed → website/media.json
                                     │
                         <Shot id> / <Clip id> in docs and landing page  ──►  R2 (public): media.<domain>
```

### Layout
```
examples/<project>/                 # demo projects + story.yaml
docs-media/
  compose.demo.yml                  # overlay: storage mounts for backend/nginx/cantaloupe, demo env, no rabbitmq/flower/pgadmin
  seed.py                           # uv script: replay stories into a running stack (real `qa` CLI + fake CI env)
  snapshot.py                       # uv script: save/restore db + storage to/from R2, keyed by a content hash
  shots/*.spec.ts                   # the shot list, one file per area (commit page, history, tuning, files, landing...)
  shots/lib/                        # clock, waits (IIIF tiles loaded), cursor + caption overlay, shot()/clip() helpers
  tapes/*.tape                      # terminal recordings (charmbracelet/vhs) for the `qa` CLI
  publish.py                        # uv script: encode, dedupe by perceptual diff, upload to R2, write the manifest
website/media.json                  # committed manifest: id → urls, width, height, lqip, alt, captured, app version
website/src/components/{Shot,Clip,Compare}.tsx
.github/workflows/docs-media.yml
```

### Determinism (so re-runs only change what really changed)
- Capture from a **restored snapshot**, not a fresh seed: profiles and timings vary run to run, the snapshot doesn't.
- `page.clock` frozen at T0 (relative dates, the 3-day default range, the What's new popup).
- Fixed viewport 1440x900 at deviceScaleFactor 2, pinned fonts in the capture container, `reducedMotion` for stills.
- Pre-seeded localStorage (What's new seen, controls panel state, log wrap), wait for OpenSeadragon
  `fully-loaded` and Plotly `afterplot`, mask truly volatile bits (version, durations).
- `publish.py` compares each new still to the published one (pixelmatch) and keeps the old one under a
  threshold: no churn, small diffs in review.

### Stills, clips, terminal
- **Stills**: shot specs are code (`shot('commit/image-diff', {url, actions, locator, alt})`). Raw and clean;
  call-outs are HTML overlays in the docs (`<Shot id callouts=[...]>`), so they stay sharp, editable and
  don't need a re-capture. No more baked orange arrows.
- **Clips** (6-20 s, silent, captioned): Playwright's built-in video is low quality, so record with the CDP
  screencast at 30 fps, inject a fake cursor with click ripples and smooth paths, assemble with ffmpeg:
  MP4 H.264 (faststart) + WebM, poster JPEG, < 3 MB for the hero. `prefers-reduced-motion` shows the poster.
- **Terminal**: VHS tapes for `qa run`, `qa batch`, `qa check-bit-accuracy`, rendered to MP4/WebM + a final-frame PNG.
- Each shot carries its alt text and the doc pages that use it, so a missing or unused shot fails the build.

### R2
- Two buckets: `qaboard-media` (public through a custom domain, e.g. `media.<domain>`) and `qaboard-ci`
  (private: snapshots, demo inputs, PR preview galleries).
- Content-addressed keys (`shots/<id>/<hash>.avif`): immutable, cached forever, and a PR's media is
  live before merge without touching what production uses. The manifest is the only pointer that moves.
  A lifecycle rule deletes objects no manifest has referenced for 90 days.
- Upload through the S3-compatible API (`rclone` or `aws s3 --endpoint-url`), not wrangler (one object
  per call). Secrets: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, scoped to these two
  buckets with Object Read & Write. A general Cloudflare API token isn't needed.
- R2's `r2.dev` URLs are rate-limited and meant for development, so a custom domain on Cloudflare is effectively required. **(decide)**
- **Air-gapped installs**: the docs are also bundled into the app (`QABOARD_DOCS_FOR_WEBAPP=true`) and served
  inside company networks that may not reach R2. `QABOARD_DOCS_MEDIA=bundle` makes the website image
  download the manifest's media at build time into `static/media/`. Remote is the default for the public site.

### When it runs (`.github/workflows/docs-media.yml`)
| Trigger | What happens |
|---|---|
| `workflow_dispatch` (inputs: `only` glob, `reseed`, `publish`) | The main way: regenerate some or all shots |
| PR labeled `docs-media` | Capture the shots the PR affects, upload, commit `website/media.json` to the PR branch, comment a before/after gallery |
| Tag `v*` | Full refresh, opens a PR |
| Monthly (with the release notes) | Full refresh, opens a PR only if something changed beyond the threshold |

Never on every push. Expected cost on a GitHub runner: 15-30 min from a snapshot, +20-40 min when the
stories or the backend models changed and the snapshot must be re-seeded. Fork PRs never see the secrets.

Later, as dogfooding: record each capture as a QA-Board run, so UI changes are reviewed with QA-Board's own
image diff. Nice for the story, not needed for v1.

### The same snapshot, three payoffs
1. Screenshots and clips (above).
2. **Try it in 5 minutes**: `docker compose -f docker-compose.yml -f docs-media/compose.demo.yml up` restores
   the demo snapshot locally. This is the strongest answer to "everyone misses it": let people click around their own copy.
3. **Public read-only demo** `demo.<domain>` **(decide)**. Recommended: a *static* demo, the app built in a demo
   mode that serves recorded API responses (captured as HAR during the capture run) through a service worker,
   plus static IIIF tiles (`vips dzsave --layout iiif3`), hosted on Cloudflare Pages/R2. No server to operate
   or secure, read-only by construction. Degrades a few features that call the backend (pixel tooltip,
   auto-ROI): record them for the scripted spots, toast "read-only demo" elsewhere. The alternative, a hosted
   instance on a VM, means ongoing ops and an attack surface for little gain.
   Bonus: the recorded fixtures are the "realistic fixtures" `webapp/TODO.md` asks for in the e2e tests.

---

## 5. Website: information architecture and landing page

### Sidebars (navbar: Product · Docs · Use cases · Demo · Release notes · Blog · GitHub)
- **Product tour** (new): "QA-Board in 5 minutes" following the story spine, one clip per step.
- **Use cases** (new): one page per demo project: the problem, the workflow, screenshots from that project, the
  config that produces them, "run this example".
- **Tutorials** (new): first project in 15 minutes (`examples/image-quality`); hunt a performance regression;
  tune parameters from the browser; add a quality gate to GitHub Actions / GitLab CI; self-host for your team.
- **Recipes** (new cookbook, short task pages): compare against a milestone · find the commit that broke
  a metric · share a link to an exact crop/zoom · metrics with targets and pass/fail · dynamic per-frame
  outputs · flame graphs from py-spy/perf · side-by-side videos · export results for a report · query the API
  from a notebook · run on LSF / Dask / Celery / Kubernetes · monorepos · bit-accuracy before a HW handoff ·
  W&B/TensorBoard alongside · let a coding agent run `qa` and read the Metrics Diff (works today, CLI + API).
- **User guide** (keep the text, replace every screenshot, add clips).
- **Project integration** (dedupe: outputs/faq/sharing, milestones/comparing-results, installation/qa-cli, runner precedence).
- **Admin** (generic self-hosting only: compose, Helm, auth, storage, upgrades, troubleshooting).
- **Reference** (generated, so it can't drift): CLI from Click (`qa ... --help` → MDX), `qaboard.yaml` and
  `metrics.yaml` from a JSON Schema (also published for editor autocomplete via yaml-language-server), REST API
  from an OpenAPI spec (`integrating-qa-in-scripts` already says "TODO: openapi").
- **Comparison** ("Why QA-Board", §2) and **Vision: QA-Board in the agent era** (§8, clearly labeled roadmap).
- Redirects for every moved page (`@docusaurus/plugin-client-redirects`); keep the ids the app links to stable
  (`user-guide/overview`, `user-guide/files`, `visualizations`, `computing-quantitative-metrics`, `installation`,
  `triggering-third-party-tools`, `batches-running-on-multiple-inputs`, `celery-integration`, `auto-optimization`).

### Landing page (rebuilt from scratch)
1. **Hero**: headline + one-line subhead; CTAs "Try the demo" (or "Run it locally") and "Get started";
   GitHub stars. Visual: a 15-20 s muted loop of the commit page (synced zoom on an image diff → threshold →
   Metrics Diff), poster first, video lazy.
2. **Proof strip**: open source (Apache 2.0), self-hosted, years in production, project counts if we may say so **(decide)**.
3. **"You already built half of this"**: the in-house pain, in the reader's words.
4. **The loop**: Run · Compare · Look · Find · Tune · Gate, tabs with one clip each.
5. **Use cases**: 5 cards (image quality, ML eval, performance, embedded/bit-accuracy, robotics) → use-case pages.
6. **"Polish you'd never build in-house"**: a grid of ~12 micro-clips/stills (synced zoom, perceptual diff,
   pixel tooltip, ROI histograms, flame graph diff, live logs with LSF hints, keyboard file browser, Monaco
   batch editor, tuning analysis, milestones, Windows/Linux path copy, What's new).
7. **Fits your stack**: GitLab/GitHub/Jenkins, LSF/Dask/Celery/Kubernetes, LDAP/SAML, Docker/Helm.
8. **Agent era teaser** → vision page.
9. **Quotes** from people who used it and miss it (with permission) **(decide)**.
10. **CTA** + "What's new" (latest release note highlights, already a component).

Performance budget: LCP < 2.5 s on 4G (poster image, not video, is the LCP element), no layout shift (manifest
has dimensions), total landing weight < 4 MB with lazy clips.

### Site plumbing
Own domain on Cloudflare **(decide)**; update `url/baseUrl/organizationName/editUrl`; replace Algolia (tied to the
old Samsung index) with `@easyops-cn/docusaurus-search-local` or re-apply to DocSearch; Cloudflare Web Analytics
(cookie-free) to see whether any of this works; a `yarn build` check on PRs; `onBrokenLinks: 'throw'`; a weekly
external link check (lychee); a new social card generated from a shot; light/dark aware media
(`<picture>` with `prefers-color-scheme`, if the app gets dark mode).

---

## 6. Product fixes and polish to do before the shoot

Screenshots will show these; fixing them is cheaper than hiding them.

| Item | Size | Why |
|---|---|---|
| `qatools_config`/`qaboard_config` key bug in `CiCommit.get_or_create`; `commit_branch=None` crash | S | Seeding and real users both hit them |
| History page: empty sidebar, untitled compare tab, `href` reloads (`webapp/TODO.md`) | S | It's the regression-hunting hero shot |
| SLAM viewer "Send to Cloud" button | XS | Also a data-leak risk |
| Avatars without GitLab: accept an avatar URL / email (Gravatar) in the payload; GitHub-hosted projects | S | Empty avatars everywhere look abandoned; also helps every non-GitLab user |
| Broken links from the app (`lsf-cluster-integration`, spectrum.chat, `samsung.github.io`) | XS | |
| `qa init --template <example>` scaffolds from `examples/` | S | Makes tutorials one command |
| Dark mode for the app (Blueprint has it; logs/files already have `.bp6-dark` styles) **(decide)** | M | "2026 style" is hard to claim without it; doubles the screenshot set |
| Command palette (Cmd-K: projects, branches, commits, views) **(decide)** | M | Expected polish in 2026; optional |

---

## 7. Execution with subagents

Agents work in parallel against fixed contracts, each in its own worktree and PR. I coordinate, review
and merge; you review at the checkpoints.

### Contracts (written in phase 0, before any fan-out)
- `website/media.json` schema and the `<Shot>/<Clip>` component API.
- Shot id naming (`<area>/<subject>`, e.g. `commit/image-diff`, `history/find-regression`) and the shot
  list (appendix), each shot tagged with its demo project and the pages using it.
- `story.yaml` format and the persona/company bible (fictional company, ~6 people, avatars, dates relative to T0).
- `website/STYLE.md`: voice, terminology, claim-verification rule, screenshot captions say what to notice.
- Docs can be written before the media exist: `<Shot id>` renders a labeled placeholder until the manifest has it.

### Workstreams
| # | Workstream | Agents | Depends on | Output |
|---|---|---|---|---|
| WS0 | Groundwork | me | decisions | `.gitignore` fix, site config/domain, broken/missing images, SIRC content moved out, contracts above |
| WS1 | Demo projects | 1 per project, parallel | contracts | `examples/*` runnable, deterministic, licensed, story, README |
| WS2 | Seeder + demo stack | 1 | WS1 (one project) | `compose.demo.yml`, `seed.py`, `snapshot.py`, backend fixes from §6 |
| WS3 | Capture + publish | 1 | WS2 | shot/clip helpers, VHS tapes, `publish.py`, R2, `docs-media.yml` |
| WS4 | Website platform | 1 | contracts | components, IA + redirects, landing page, search, analytics, generated references |
| WS5 | Content | 4-6, parallel by section | WS4 contracts (not media) | tour, use cases, tutorials, recipes, user-guide refresh, dedupe, comparison, vision, blog posts |
| WS6 | Product polish | 1-2 | none | §6 items as separate PRs |
| WS7 | Review | 3 standing reviewers | each PR | claims vs code (every feature claim traced to code), visual QA (each image read: no internal data, spinners, empty or error states), links/build |

### Phases
- **Phase 0, decisions + groundwork** (one session): your answers to the **(decide)** items, WS0, contracts.
- **Phase 1, vertical slice** (the risky part): `examples/image-quality` + seeder + snapshot + ~8 stills, 2 clips,
  1 VHS tape → R2 → `<Shot>` on two user-guide pages, triggered by `workflow_dispatch`. Checkpoint: you look at the
  images and the workflow run. Risks retired here: storage mounts with Cantaloupe, determinism, clip quality, R2.
- **Phase 2, breadth**: perf + detection projects, the full shot list (~60 stills, ~12 clips), the landing page,
  user guide fully re-illustrated, tour, use-case pages, 2 tutorials, §6 fixes. Checkpoint: landing page preview.
- **Phase 3, story and reach**: recipes, comparison, vision page, generated references, blog relaunch
  ("QA-Board in 2026", "Why every algorithm team builds a worse QA-Board", "Reviewing agents' changes like
  algorithms"), static demo, robotics/agent demo projects, optional 2-min narrated tour assembled from the clips.
- **Phase 4, agent features** (product, §8), in parallel with phase 3 if you want it.

Rough size: phases 1-2 are most of the work; I'd expect several working sessions each, mostly agent time,
with your review at the checkpoints. Multi-agent fan-outs are run as workflows of under 10 agents each.

### What I need from you
- Answers to the **(decide)** items below.
- Cloudflare: the two buckets, the custom domain, an R2 token scoped to them → GitHub secrets
  `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
- Optional but valuable: photos/videos you own and can release (CC-BY) for the image-quality demo, and 3-5 quotes
  from former colleagues.

---

## 8. The agent era: vision now, one real feature first

What's honest today: a coding agent can already use QA-Board like any script, running `qa batch` and reading
results through the REST API with a token. That becomes a recipe in phase 3.

What to build before marketing "quality gates for agents" (phase 4, roughly in order):
1. **Quality gate**: `gates:` in `qaboard.yaml` (thresholds on metric deltas vs the reference or a milestone,
   bit-accuracy required, max failed runs) + `qa gate` (exit code, Markdown summary) + **GitHub check runs /
   GitLab commit statuses** with the Metrics Diff and links. This closes the deferred item in
   `docs/github-support-roadmap.md` and serves human CI on day one.
2. **Machine-readable surface**: OpenAPI spec, `--json` output for `qa` commands that report.
3. **MCP server** (`qa mcp`): read tools (projects, commits, batch metrics diff, failing tests, fetch an output or
   an image crop), then authenticated actions (start a batch, mark failed). Lets Claude Code, Codex or Cursor
   check their own changes against the quality bar.
4. **Agent workflow kit**: an `AGENTS.md`/skill template ("before claiming a change is better, run the batch and
   read the Metrics Diff"), runs badged as agent-authored, and a human "approve as new reference" step for
   visual changes. Humans review what agents can't judge (does it *look* right?), agents do the legwork.

The vision page tells this as a roadmap, and the landing page teaser only claims what's shipped.

---

## 9. Decisions (with recommendations)

1. **Domain and hosting**: buy a short domain on Cloudflare; docs on GitHub Pages or Cloudflare Pages, media on
   `media.<domain>`. *Recommend: own domain, Cloudflare Pages for docs + demo, R2 for media.*
2. **Samsung/SIRC on the public site**: what can we say ("born at Samsung", years in production, project counts,
   quotes, logos)? Internal runbooks and hostnames should leave the public docs (moved next to
   `deployments/sirc`, in line with `docs/known-issues.md`). *Recommend: check with the OSS office; move the runbooks either way.*
3. **Public demo**: static recorded demo vs hosted instance vs none. *Recommend: static, phase 3.*
4. **App polish before the shoot**: §6 small fixes (yes), dark mode, command palette. *Recommend: fixes + dark mode; palette later.*
5. **Agent features**: vision page only, or build the gate + MCP. *Recommend: build the gate (needed for CI anyway), MCP after.*
6. **Demo fiction**: a fictional company and team (name to pick, trademark-checked), generated avatars, no real names. *Recommend: yes.*

---

## 10. Risks
- **Heavy stack in CI** (backend compiles uwsgi/lxml/xmlsec; Cantaloupe is Java). Mitigated by the existing bake
  cache and by capturing from snapshots; phase 1 measures it.
- **Pretty but untrue docs**: a claims reviewer traces every feature claim to code; vision content is labeled.
- **Fixture rot**: the snapshot is re-seeded when `examples/`, the seeder or backend models change (hash key).
- **Clip quality and weight**: hard budgets (resolution, duration, size) enforced by `publish.py`.
- **Adoption isn't only docs**: time-to-first-value for self-hosting (10 services, GitLab-first defaults) matters
  as much as screenshots. The demo-data quickstart and a GitHub-first tutorial address it; a minimal compose
  profile (no rabbitmq/flower/pgadmin) would help further.

---

## Appendix: shot list (first cut, ~60 stills / ~12 clips)
Legend: **IQ** image-quality, **PERF** perf-regression, **DET** detection-eval, **R3D** robotics-3d, **AG** agent-evals. 🎬 = clip.

**Projects and commits**
- `projects/home`: project cards, favorites, filter (all)
- `commits/feed`: commits grouped by day, branch tags, crashed/pending tags (PERF)
- `commits/branch-evolution`: metrics over time on a branch (PERF)
- `commits/filter`: filter box suggesting branches and "go to commit" (PERF)
- `integrations/menu`: integrations with statuses (IQ)

**Commit page: metrics**
- `commit/summary`: metric tiles, deltas, pass-rate bars, new vs ref histograms (DET)
- `commit/metrics-table`: per-test quality report vs targets (DET)
- `commit/metrics-diff`: improvement report vs reference (DET)
- `commit/milestone`: star a commit as a milestone (DET)
- `commit/batch-picker`, `commit/output-filter`: batch selector, negative/regex filters (IQ)

**Commit page: outputs**
- `commit/image-sbs`: new vs ref side by side (IQ)
- 🎬 `commit/image-diff`: synced zoom → perceptual diff → threshold slider (IQ)
- `commit/pixel-tooltip`, `commit/roi-histograms`, `commit/auto-roi`, `commit/image-filters` (IQ)
- 🎬 `commit/deep-zoom`: 100MP+ image from overview to pixels (IQ)
- 🎬 `commit/dynamic-outputs`: synced slider across ISP stages / frames (IQ)
- `commit/plotly-overlay`: PR curves with dashed reference (DET)
- `commit/flame-diff`: differential flame graph (PERF)
- `commit/text-diff`: Monaco diff with "Next Diff" (AG or PERF config dumps)
- `commit/html-report` (DET), `commit/video-sync` (R3D), `commit/pointcloud` (R3D), `commit/trajectory-6dof` (R3D)
- `commit/output-files`: bit-accuracy tree, "Bit-accurate" tag (IQ fixed-point)
- 🎬 `commit/bit-accuracy-diff`: Ctrl-click two files to diff in place (IQ)
- `commit/controls-panel`: floating controls (IQ), `commit/export`: export files to a shared dir (IQ)
- `commit/run-menu`: redo, mark failed, delete (PERF)
- `commit/artifacts-configs`: config tree diff (DET)

**Logs**
- 🎬 `logs/live-tail`: live log, error count, jump to next error (PERF)
- `logs/lsf-hints`: LSF report with exit reason and hints (PERF), `logs/batch-commands` (PERF)

**History**
- `history/performance-over-time`: per-test lines with target (PERF)
- 🎬 `history/find-regression`: hover across commits, inline output card, freeze the reference (PERF)
- `history/relative`: relative to start (PERF), `history/image-diff`: show output files over time (IQ)

**Tuning**
- `tuning/available-tests`: Monaco batches editor, problems panel (DET)
- `tuning/which-tests-run`: tests drawer (DET)
- `tuning/manual-form`, `tuning/auto-form`: tuning forms (DET)
- 🎬 `tuning/launch-to-analysis`: launch a sweep, see the Analysis (DET)
- `tuning/analysis`: convergence, sensitivity, parallel coordinates, frontier (DET)

**Files**
- `files/browser`: keyboard-driven file browser (PERF)
- `files/runbar`: run folder with redo/mark failed (PERF), `files/hotkeys`: `?` dialog

**Global**
- `whats-new/dialog`, `whats-new/drawer` (real release notes)
- `auth/login`

**CLI and CI** (VHS terminal recordings)
- 🎬 `cli/first-run`: `qa run` on one input, link printed (IQ)
- 🎬 `cli/batch`: `qa batch` with progress (DET)
- `cli/bit-accuracy`: `qa check-bit-accuracy` failing then passing (IQ)
- `ci/github-check`: the gate's check run summary (after §8.1)

**Landing**
- 🎬 `landing/hero` (15-20 s loop), one 🎬 per loop step reused from above, `landing/social-card`
