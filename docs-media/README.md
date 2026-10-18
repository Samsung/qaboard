# docs-media: screenshots, clips and terminal recordings for the docs

The docs show the real web app, running on demo data computed by the projects in [`examples/`](../examples/README.md).
This folder captures those media, publishes them, and records them in [`website/media.json`](../website/media.json).
It is the contract for the agents that build the pipeline (WS2, WS3) and the website components (WS4).

```
examples/*/story.yaml ──seed.py──► stack (Compose + compose.demo.yml) ──snapshot.py──► R2 qaboard-ci (private)
                                          │                                         └─► demo-data image (GHCR)
                         shots/*.spec.ts (Playwright) · tapes/*.tape (VHS)
                                          │
                   out/<id>/  stills (PNG@2x) · clips (CDP frames + captions.vtt) · tapes (MP4/WebM)
                                          │
              publish.py: encode → perceptual dedupe → upload changed files → website/media.json
                                          │
        R2 qaboard-media (public host, tooling only) ──docs build downloads──► served same-origin
```

## Layout

```
docs-media/
  README.md            # this file
  shots.yaml           # the shot list: id, kind, project, what it shows, pages, status
  compose.demo.yml     # overlay on docker-compose.yml: results storage in backend/nginx/cantaloupe, demo env
  seed.py              # uv script: replays examples/*/story.yaml into a running stack (real `qa`, fake CI env)
  snapshot.py          # uv script: save/restore the database + results (R2 qaboard-ci), build the demo-data image
  demo/                # stack.py (the stack, for seed.py and snapshot.py), kitefin_stub.py (*.kitefin.example),
                       # webapp_runs.py (the examples' inputs and runs for the web app's tuning forms)
  demo-data/           # the demo-data image: Dockerfile, restore.sh (see "The demo-data image")
  tests/fixture/       # a tiny project and story that exercise everything seed.py does, in about 2 minutes
  publish.py           # uv script: encode, dedupe, upload, write website/media.json; `gc` subcommand
  shots/
    package.json       # pinned @playwright/test, same version as webapp/
    playwright.config.ts
    lib/               # index.ts (the only import for specs), demo.ts, waits.ts, overlay.ts, record.ts, ids.ts
                       # capture.setup.ts (checks before capturing), test/ (the lib's tests, on fixture pages)
    <area>.spec.ts     # one file per area: commit.spec.ts, history.spec.ts...
  tapes/
    <area>-<subject>.tape   # VHS tapes; the shot id is <area>/<subject>
    _settings.tape     # the settings every tape starts with
    record.py          # uv script: records the tapes, writes their meta.json
  install-tools.sh     # the pinned encoders and recorders (oxipng, avifenc, cwebp, VHS, ttyd, actionlint)
  fonts.conf           # the only fonts captures see (FONTCONFIG_FILE)
  affected.py          # the shots a pull request affects
  test_publish.py      # publish.py's tests, on synthetic captures
  out/                 # capture output, gitignored: out/<area>/<subject>/...
website/
  media.json           # committed manifest, schema: website/media.schema.json
  plugins/media/       # Docusaurus plugin: downloads the manifest's files into the build, build checks
  src/components/{Shot,Clip,Compare}.tsx, StackPicker/, stack.ts
.github/workflows/docs-media.yml
```

`website/.media-cache/` (downloaded files) and `docs-media/out/` are gitignored.

## Shot ids

- Format: `<area>/<subject>`, lowercase kebab-case, exactly one slash:
  `^[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*$`, at most 80 characters.
- **Areas** (adding one means editing this list): `quickstart`, `cli`, `ci`, `projects`, `commits`, `integrations`,
  `commit`, `logs`, `history`, `tuning`, `files`, `whats-new`, `auth`, `landing`.
  The area is where the shot is taken in the app (or `cli`/`quickstart`/`ci` for terminals and CI), not the doc page.
- The subject names what's shown, not how: `commit/flame-diff`, not `commit/flame-graph-2`.
- An id is permanent. If what it shows changes meaning, retire it (`status: retired` in `shots.yaml`) and pick a new id.
- The id is the Playwright test title, the `out/` folder, the R2 prefix and the manifest key.

## The demo stack and its data

The stack is the root `docker-compose.yml` with [`compose.demo.yml`](compose.demo.yml), Compose project `qaboard-demo`,
at http://localhost:5151. It runs the published images (`QABOARD_IMAGE`, default `ghcr.io/<owner>/qaboard` in
GitHub Actions, else `ghcr.io/samsung/qaboard`), and shares the results storage with the host at the same path
(`QABOARD_DEMO_RESULTS`, default `/mnt/qaboard`, which you may have to create: `sudo mkdir -p /mnt/qaboard && sudo chown
$USER /mnt/qaboard`). Every persona of the demo world can log in, with the password `kitefin-demo`.
To capture a web app or Cantaloupe that isn't published yet, build its image and point one service at it:
`QABOARD_DEMO_FRONTEND_IMAGE=qaboard-demo-local:frontend-<sha>` (also `_BACKEND_`, `_PROXY_`, `_CANTALOUPE_`), e.g.
`docker compose build frontend` from that checkout, then `docker tag`. Restores and seeds use it while it's set.

Restore the current snapshot (needs the R2 variables, see [When it runs](#when-it-runs-githubworkflowsdocs-mediayml)):

```bash
uv run docs-media/snapshot.py restore            # the snapshot of this checkout's key; --latest for the newest one
uv run docs-media/seed.py down --volumes         # when you're done
```

Seed a story yourself, e.g. after changing an example, the seeder, the models or the CLI (the snapshot key changed):

```bash
uv run docs-media/seed.py --project image-quality           # starts the stack if needed, then checks the story
uv run docs-media/seed.py --project image-quality --resume  # after a failure: continue where it stopped
uv run docs-media/seed.py --story docs-media/tests/fixture/story.yaml   # test seed.py itself
uv run docs-media/snapshot.py save                          # snapshots/<key>.tar.zst, with T0 and the shas
```

- `--validate` checks a story and prints what it does, without a stack: use it while writing one.
- `--fresh` empties the stack first (do it before seeding the projects of a new snapshot), `--until <commit>` stops
  early, `--checks-only` reruns the checks, `--t0 2026-10-08T16:00Z` picks T0 (default: the stack's, else the last
  Thursday 16:00 UTC). All projects of a snapshot share T0.
- `seed.py` writes T0 and each story's shas in `<results>/.qaboard-demo/demo.json`, served at
  http://localhost:5151/s/mnt/qaboard/.qaboard-demo/demo.json. The snapshot's metadata has them too (`snapshot.py info`).
- How runs, failures and times are simulated: the docstring of [`seed.py`](seed.py).
- An example with compiled code ships `qa/build.py` (`serving-latency`: `cargo build --release`, about 2 minutes):
  the seeder runs it once in the workspace before replaying the story, like a CI job's build step, so the build
  doesn't land in the first run's log. Build outputs (`target/`) stay in the workspace between seeds.

### The demo-data image

The quickstarts start QA-Board with the demo projects: Docker Compose
([`deployments/quickstart/compose.yml`](../deployments/quickstart/compose.yml)) and the Helm chart (`demoData` in
[`charts/qaboard/quickstart.yaml`](../charts/qaboard/quickstart.yaml)). Their data comes from the
`ghcr.io/<owner>/qaboard:demo-data` image, built from a snapshot:

```bash
uv run docs-media/snapshot.py image --tag ghcr.io/samsung/qaboard:demo-data   # this checkout's snapshot; --key, --latest, --file
```

- The image is `postgres:16-alpine` (the quickstarts' database, so its layers are already there) with the snapshot's
  `db.sql`, its results as `results.tar`, and [`demo-data/restore.sh`](demo-data/restore.sh) as entrypoint.
- `results.tar` stores files with the same content and mode once: the others are hard links, and stay hard links
  when restored. Most outputs don't change from one commit to the next: the 2.2 GB of results of the image-quality
  snapshot take 0.6 GB. Duplicates share the modification time of the first copy.
- `restore.sh` restores the results into `/mnt/qaboard` (the snapshot's results root, the path the database has),
  unless `.qaboard-demo/restored` is there, then the database, unless it already has QA-Board's tables, then exits.
  The backend must start after it: it creates empty tables when it starts. It holds a PostgreSQL advisory lock while
  it restores, so concurrent restores (backend replicas, the chart's migrations Job) wait, then skip.
- [`.github/workflows/docs-media.yml`](../.github/workflows/docs-media.yml) builds it from the snapshot it restores
  or seeds, tests it with the Compose quickstart (on port 5252, next to the demo stack) and this run's images, then
  pushes it from master (`demo-data`, `demo-data-<commit>`) and release tags (`demo-data-<version>`). Pull requests
  and other branches only build and test it. CI's `publish-docker-images` gives every other published version a
  `demo-data-<version>` tag, from the latest `demo-data`.
- CI's `quickstart` and `helm-e2e` jobs can't read the snapshots: they build the image from the seeder's test story
  instead ([`.github/scripts/demo_data_fixture.sh`](../.github/scripts/demo_data_fixture.sh)), then check the
  quickstart with [`.github/scripts/demo_data_e2e.py`](../.github/scripts/demo_data_e2e.py): the API, the files, the
  image server, and the pages in Chromium.

## Producing media

All captures run against a stack restored from a snapshot (never a fresh seed: profiles and timings differ between
seeds), from the demo world of [`examples/README.md`](../examples/README.md). The snapshot's metadata gives `T0`.

```bash
docs-media/install-tools.sh                     # once: pinned oxipng, avifenc, cwebp, VHS, ttyd in ~/.cache/qaboard-docs-media/bin
sudo apt-get install ffmpeg fonts-roboto fonts-dejavu-core fonts-noto-color-emoji fonts-jetbrains-mono
(cd docs-media/shots && npm ci && npx playwright install chromium)
uv run docs-media/snapshot.py restore           # the demo stack at http://localhost:5151
(cd docs-media/shots && SHOTS_ONLY='commit/*' npm run capture)   # stills and clips -> docs-media/out/
uv run docs-media/tapes/record.py --only 'cli/*'                 # tapes -> docs-media/out/
uv run docs-media/publish.py --only 'commit/*,cli/*' --dry-run   # encode, check budgets, compare; then without --dry-run
```

- **The demo facts** (T0, project ids, commits) come from what `seed.py` writes in
  `$QABOARD_DEMO_RESULTS/.qaboard-demo/demo.json` (default `/mnt/qaboard`, restored with the snapshot). The environment
  can override them: `DEMO_META` (another file), `DEMO_T0`, `DEMO_BASE_URL` (default `http://localhost:5151`),
  `DEMO_APP_VERSION` (default: *pyproject.toml*'s version and the checkout's short sha; CI asks the stack's backend).
  `demo.sha()` uses the snapshot's shas, and fails on a commit id the snapshot doesn't have.
- **A second stack** next to the first (e.g. to seed one project while another captures): give it its own
  `QABOARD_DEMO_PROJECT` (compose project, default `qaboard-demo`), `QABOARD_DEMO_PORT` and `QABOARD_DEMO_RESULTS`,
  and its own `seed.py --workspace`.
- **Selection:** `SHOTS_ONLY` (captures), `--only` (tapes, publish) take comma-separated globs over ids.
- **`out/<area>/<subject>/meta.json`** is what `publish.py` reads: `id`, `kind`, `width`/`height` (CSS px of the
  shot), `scale`, `alt`, `caption`, `project`, `app_version`, `source_spec`, `captured` (ISO time), `t0`,
  `dedupe_tolerance`, `anchors`, `files`; clips add `region` (their box in the viewport, CSS px), `duration`, `frames`,
  `poster`, `loop`; tapes add `duration`, `poster`, `dedupe_mask`.
- `npm test` in `shots/` runs the lib's own tests on fixture pages (an OpenSeadragon viewer on a slow fake IIIF server,
  Plotly redraws, spinners, a page to click, type, wheel and drag on), without the demo stack.
  `uv run docs-media/test_publish.py` tests `publish.py` on synthetic captures.
- Locally, `PLAYWRIGHT_CHROMIUM_EXECUTABLE` uses a Chromium that's already installed.

### Stills
1. A spec calls `shot(id, options)` (API below), which registers one Playwright test named after the id.
2. The test opens `options.url`, runs `options.actions`, waits until the page is settled, then screenshots the viewport
   or `options.target` (plus `padding`), at 1440x900 and `deviceScaleFactor: 2`. A target is measured once its box stops
   moving (a popover still opening), and never crops in the bars fixed at the top of the viewport (the commit page's
   header): if it's under them, the page scrolls it below. A bar that holds part of the target is part of the shot (the
   commit bars' filter box and batch selector). Scrolling moves what's under the mouse and closes the popovers that
   open on hover: before hovering, scroll the target in place in the actions.
3. It writes `out/<id>/still.png` and `out/<id>/meta.json` (`kind`, `width`/`height` in CSS pixels, `alt`, `caption`,
   `project`, `app_version`, `source_spec`, `anchors`).

### Light and dark
Every still and clip is captured twice: in the web app's light theme (`out/<id>/`) and in its dark theme
(`out/<id>/dark/`, same files, `"theme": "dark"` in `meta.json`). The web app follows `prefers-color-scheme` unless a
user picked a theme, so the Playwright projects `stills-dark` and `clips-dark` only differ by `colorScheme: 'dark'`.
`npm run capture` runs the four projects, `capture:light` and `capture:dark` one theme; the workflow's `themes` input
does the same. A shot that has no dark version (e.g. `landing/social-card`, the Open Graph image) sets
`themes: ['light']`. Tapes are recorded once: they are already a dark terminal.

The docs show the dark capture in their dark mode (see [Publishing](#publishing-publishpy) and `<Shot>` below). A dark
capture must have the size of the light one, so actions must not depend on the theme.

Captures stay clean: no arrows, boxes or text burned in. Call-outs are HTML overlays added by `<Shot callouts>`,
positioned from the `anchors` a spec records with `ui.anchor(name, locator)`, so they survive a re-capture.
The one exception is `landing/social-card`: `landing.spec.ts` crops the commit page, then renders
[`shots/templates/social-card.html`](shots/templates/social-card.html) (logo, tagline, the crop) at 1200x630, scale 1.
Once published, it is every page's Open Graph image (`themeConfig.image` in `website/docusaurus.config.ts`, from the PNG
master the docs build downloads).

### Clips
- 6-20 s, silent, 30 fps, captioned. Same viewport and scale as stills, `reducedMotion: 'no-preference'`. The screencast
  sends frames at 1x in headless Chromium: `meta.json`'s `scale` is the frames' (pixels per CSS px), which `publish.py`
  crops the `region` with.
- **Another page** in a clip: `ui.goto(url)` (a path of the stack, e.g. `ui.demo.commitUrl(...)`) waits like the first
  load and isn't recorded: the next frame shows the new page loaded, the cursor where it was, the shot's masks applied.
  The clip's `region` stays the same: the new page should put what matters in the same place.
- **Landing tiles** (`landing/*` except the hero): 16:10 crops (`region`/`target` boxes) about 600-800 CSS px wide, so
  that their text reads at the tiles' 370 px.
- **Recording:** the CDP screencast (`Page.startScreencast`, JPEG quality 92, every frame), not Playwright's video,
  which is too blurry. Frames arrive only when the page repaints, each with a timestamp: `record.ts` writes
  `out/<id>/frames/NNNNN.jpg` and an ffmpeg concat list with each frame's duration.
- **Only scripted time is recorded**, so a clip lasts the same and shows the same frames whatever the server's latency
  or the machine's speed (two recordings on one snapshot dedupe as unchanged):
  - the clip's clock runs only in the script's scripted time: cursor moves (a point per frame of the clip, 30 fps), the
    pauses in clicks (120 ms before, 70 ms pressed, 150 ms after), key presses (150 ms), wheel steps (70 ms), typing
    (60 ms per key) and `ui.hold(ms)` (`Recorder.roll()`);
  - everything else is cut out: the page handling an input, the waits (`ui.settle()`, `ui.tiles()`, `ui.plots()`, and
    the one after each click, key press and wheel step), and any request the page starts during scripted time (a
    debounced fetch, tiles): the clock stops until it's done and drawn. Only the last frame before the clock runs
    again is kept: what an action does appears at once, loaded, without spinners;
  - the page's own time follows the clip's: `page.clock` is paused, and advanced in step with the clip's clock
    (timers, `Date`, `requestAnimationFrame`, aligned on its 16 ms frames), so debounces and fades take the same clip
    time in every recording. Waits run it in real time (at least 400 ms: what an action started with a delay is done).
    CSS and Web animations (and the click ripples) are paused outside scripted time; CSS transitions are finished;
  - `SHOTS_DEBUG=1` writes `out/<id>/timeline.json`: every frame's timestamp, the stretches of scripted time, the
    frames kept.
- **Encoding** (in `publish.py`): resample to constant 30 fps, scale to at most 1920 px wide.
  - MP4: H.264 High, `-crf 26 -preset slow -pix_fmt yuv420p -movflags +faststart`, no audio track.
  - WebM: VP9, `-crf 36 -b:v 0 -row-mt 1 -cpu-used 2` (the default `-cpu-used 0` takes minutes per clip), no audio track.
  - Poster: WebP (`-q 80`) of the frame given by `poster` (default: the last frame), at the video's size.
- **Cursor:** a fake cursor (SVG arrow, injected by `addInitScript`) moves along eased paths; clicks show a ripple.
  It is burned into the video. Stills never show it. The real mouse follows the same path, so hovers happen.
- **Captions** are not burned in: each `ui.caption(text)` adds a WebVTT cue (`out/<id>/captions.vtt`) starting at that
  moment of the clip. `<Clip>` overlays the current cue and adds a `<track kind="captions">`. Keep cues under 60
  characters.

### Terminal tapes
- [charmbracelet/vhs](https://github.com/charmbracelet/vhs) 0.11.0 (`install-tools.sh`; 0.12 writes no video), with
  ttyd, ffmpeg and a Chromium. `uv run docs-media/tapes/record.py [--only GLOB]` runs VHS from `docs-media/`, then
  writes `meta.json`. File `tapes/<area>-<subject>.tape` makes shot `<area>/<subject>`.
- Each tape starts with `# key: value` lines: `alt` (required), `caption`, `project`, `user` (the persona, default
  `ines`), `env` (extra `KEY=VALUE`s, e.g. CI variables), `passenv` (names of variables kept from the environment,
  e.g. `QABOARD_IMAGE`), `poster`, `timeout` (seconds VHS may take, default 600), `revision`, `dedupe_tolerance`,
  `dedupe_mask` (rectangles `x,y,w,h` of the video, in pixels, separated by spaces, that dedupe ignores: what the
  commands measure, like times). `--skip GLOBS` leaves tapes out.
- Then the shared settings, `Source "tapes/_settings.tape"`: `Set Shell bash`, `Set FontFamily "JetBrains Mono"`,
  `Set FontSize 18`, `Set Width 1280`, `Set Height 720`, `Set Padding 24`, `Set Framerate 30`, `Set TypingSpeed 35ms`,
  and a theme from Blueprint's dark palette. Then `Output out/<area>/<subject>/tape.mp4` and `tape.webm`.
- `HOME` is `/home/<user>`, where `record.py` builds `~/kitefin/<repo>` like the seeder's workspace: a copy of the
  example, its git HEAD on the reference branch's last commit at T0, a `.venv` with this checkout's qaboard and the
  example's `requirements.txt`, and its inputs (about a minute the first time). It's never a link to the seeder's
  `/tmp/kitefin/<repo>`: `qa` prints resolved paths. Don't run `git` in tapes: the commit objects don't exist.
- `QABOARD_URL` is the stack's, `QA_USER` and the git identity are the persona's; CI and QA-Board variables of the
  environment are dropped. Wait for a command with `Wait@60s /\$$/` (the prompt is back).
- Commands run for real: `qa` against the restored stack, with the env of the [demo world](../examples/README.md)
  (CI variables for "CI" tapes). Long waits are cut with `Hide`/`Show`; a tape lasts at most 45 s.
- The prompt is `$ ` and the working directory looks like `~/kitefin/<repo>`. No real hostnames: the server is
  `http://localhost:5151`.
- **The quickstarts' tapes** (`quickstart/compose`, `quickstart/kind`) run the commands of
  [the quickstart](../website/docs/get-started/quickstart.mdx) from a clean state, with this checkout's images
  (`QABOARD_IMAGE`, `QABOARD_VERSION`; for kind, `QABOARD_IMAGE` must name a registry, e.g. `localhost/qaboard`) and
  a demo-data image built from the snapshot (`snapshot.py image --tag $QABOARD_IMAGE:demo-data-$QABOARD_VERSION`).
  They answer on port 5151, like the docs: stop the demo stack first. Docker Compose runs as project
  `qaboard-quickstart`, kind as cluster `qaboard`; both are deleted at the end. kind needs `kind`, `kubectl`, `helm`
  and about 8 GB of disk, and loads the images in the node under the chart's default names, out of the video.
  `docs-media.yml` records them last, once the demo stack is stopped (not CI's `helm-e2e` job, which has a cluster but
  the seeder's test story as demo data, and neither VHS nor the R2 secrets). To try one while the demo stack runs, record
  a copy with another port: `sed 's/5151/5555/g' tapes/quickstart-compose.tape > out/.local/quickstart-compose.tape`,
  with `# env: QABOARD_PORT_HTTP=5555` for Compose (kind: only the port-forward and the URLs change).

## Playwright helpers

Specs import only `./lib`. Signatures (`docs-media/shots/lib/index.ts`):

```ts
import type { Page, Locator } from '@playwright/test';

export type ShotId = `${string}/${string}`;            // checked against the id regex at registration
export type ProjectKey = 'image-quality' | 'serving-latency' | 'detection-eval' | 'robotics-3d' | 'agent-evals';
export type View = 'summary' | 'table-kpi' | 'table-compare' | 'output-list' | 'bit_accuracy' | 'logs'
                 | 'parameters' | 'groups' | 'tuning' | 'optimization';   // the app's `selected_views` values

/** Facts about the restored demo snapshot (examples/README.md). */
export interface Demo {
  t0: Date;
  baseUrl: string;                                       // http://localhost:5151
  appVersion: string;                                    // 1.1.1+78813fe, recorded with each shot
  slug(project: ProjectKey): string;                     // 'kitefin/inference-gateway'
  sha(project: ProjectKey, commit: string): string;      // story commit id -> 40-hex sha (see examples/STORY.md)
  url(project: ProjectKey, path?: string, query?: Record<string, string | number | boolean>): string;
  commitUrl(project: ProjectKey, commit: string, opts?: {
    reference?: string;                                  // story commit id; default: the app's default reference
    view?: View; batch?: string; batch_ref?: string; filter?: string; filter_ref?: string;
    controls?: Record<string, unknown>;                  // serialized as the app's `controls` JSON parameter
    query?: Record<string, string>;                      // anything else the app keeps in the URL
  }): string;
  historyUrl(project: ProjectKey, branch: string, query?: Record<string, string>): string;
  filesUrl(project: ProjectKey, commit: string, relativePath?: string): string;   // the /s/ file browser
}

/** Passed to `actions` and `script`. Overlay methods only draw in clips; in stills they act without drawing. */
export interface Ui {
  page: Page;
  demo: Demo;
  settle(opts?: { timeout?: number }): Promise<void>;  // the default wait, see Determinism; not recorded in clips
  tiles(opts?: { timeout?: number }): Promise<void>;   // OpenSeadragon images fully loaded; not recorded in clips
  plots(opts?: { timeout?: number }): Promise<void>;   // Plotly graphs drawn and quiet; not recorded in clips
  hover(target: Locator, opts?: { position?: { x: number; y: number } }): Promise<void>;
  click(target: Locator, opts?: { modifiers?: Array<'Control' | 'Shift' | 'Meta'>; position?: { x: number; y: number } }): Promise<void>;
  type(target: Locator, text: string, opts?: { delayMs?: number }): Promise<void>;   // default 60 ms per key in clips
  press(key: string): Promise<void>;
  wheel(target: Locator, deltaY: number, opts?: { steps?: number; position?: { x: number; y: number } }): Promise<void>;
  drag(from: Locator | { x: number; y: number }, to: Locator | { x: number; y: number }, opts?: { steps?: number }): Promise<void>;
  cursor: {
    moveTo(target: Locator | { x: number; y: number }, opts?: { durationMs?: number }): Promise<void>;  // default 600 ms, eased
    hide(): Promise<void>;
  };
  caption(text: string, opts?: { durationMs?: number }): Promise<void>;  // WebVTT cue; ends at the next cue or after durationMs
  hold(ms: number): Promise<void>;                     // let the viewer read; in clips, ms of the clip
  anchor(name: string, target: Locator): Promise<void>; // records target's box, in % of the shot, for <Shot callouts>
  goto(url: string): Promise<void>;                    // another page, waited for like the first; not recorded in clips
}

export type Box = { x: number; y: number; width: number; height: number };   // viewport coordinates, CSS px
export type Region = Locator | Locator[] | Box;

export interface ShotOptions {
  project: ProjectKey | null;                          // null: not tied to a demo project (login, What's new)
  url: string | ((demo: Demo) => string);
  alt: string;                                         // required, see website/STYLE.md
  caption?: string;                                    // default caption; pages can override it
  actions?: (ui: Ui) => Promise<void>;
  target?: (page: Page) => Region | Promise<Region>;  // crop to this element (several: their union) or box; default: the viewport
  padding?: number;                                    // CSS px around target, default 16
  mask?: (page: Page) => Locator[];                    // painted over with the surrounding background color
  viewport?: { width: number; height: number };        // default 1440x900
  scale?: number;                                      // device scale factor, default 2
  storage?: Record<string, string>;                    // localStorage entries, merged over the defaults
  login?: string | null;                               // persona logged in (password kitefin-demo); default: the project's main author
  revision?: number;                                   // bump to publish a capture the dedupe would keep as unchanged
  dedupeTolerance?: number;                            // share of differing pixels still "unchanged", default 0.0005 (clips 0.002)
  themes?: Theme[];                                    // default both; e.g. ['light'] for a page that has no dark theme
}

export interface ClipOptions extends Omit<ShotOptions, 'target'> {  // actions: set the scene before recording, not drawn
  script: (ui: Ui) => Promise<void>;
  region?: (page: Page) => Region | Promise<Region>;  // crop the recording to this element's box (or box) at start
  poster?: 'first' | 'last' | number;                  // ms into the clip, default 'last'
  loop?: boolean;                                      // the last frame must match the first (landing loops)
}

export function shot(id: ShotId, options: ShotOptions): void;
export function clip(id: ShotId, options: ClipOptions): void;
```

Example:

```ts title="docs-media/shots/commit.spec.ts"
import { shot } from './lib';

shot('commit/pixel-tooltip', {
  project: 'image-quality',
  url: d => d.commitUrl('image-quality', 'bilateral-denoise', {
    reference: 'isp-4-1', view: 'output-list', filter: 'siemens-star low-light',
  }),
  alt: 'Two Siemens star crops side by side; the cursor shows RGB values on the new image and a crosshair on the reference.',
  caption: 'Hover a pixel: its values in both images, and a crosshair at the same spot on the reference.',
  actions: async ui => {
    const viewer = ui.page.locator('.canvas-container').first();
    await ui.hover(viewer, { position: { x: 420, y: 260 } });
    await ui.anchor('new-image', viewer);   // <Shot callouts={[{anchor: 'new-image', label: '...'}]}>
  },
  target: page => page.locator('[data-shot="output-card"]').first(),   // a data-shot hook added with the spec
});
```

- Selectors: roles and visible text first. When none is stable, add a `data-shot="..."` attribute in the web app in
  the same PR, with a test.
- `*.kitefin.example` requests (integration links, git links) are routed to stub `200` responses, so links don't
  render as unreachable. Other requests outside the stack are blocked, with a warning.
- `shot()` and `clip()` register tests tagged `@still` and `@clip`; the config's `stills` and `clips` projects set
  `reducedMotion`. Stills are taken until two screenshots in a row are identical.

## Determinism

- **Data:** restored snapshot; story commit ids resolved by `demo.sha()`. Never capture from a fresh seed.
- **Texts of measured values:** serving-latency's latencies, throughputs and their changes are measured, so every
  reseed moves them. Alt texts, captions, `ui.caption` overlays and pages say what holds on every seed ("p99 dozens of
  times the reference's", "p99 more than triples"), never one seed's values. The stories' checks
  (`story.yaml`) are what make those claims hold.
- **Clock:** `page.clock.install({ time: T0 })` then `page.clock.resume()`: time starts at T0 and flows normally.
  Don't use `setFixedTime`: OpenSeadragon's springs and Plotly transitions read `Date.now()` and stall on a frozen clock.
  Stories keep the newest data at least 10 minutes before T0, so relative times ("12 minutes ago") don't flip while
  recording. While a clip records, the page's clock follows the clip's instead ([Clips](#clips)).
- **Rendering:** Chromium from the pinned Playwright image; viewport 1440x900 at scale 2; `locale: 'en-US'`,
  `timezoneId: 'UTC'`, `colorScheme: 'light'` (`'dark'` for the dark projects); `reducedMotion: 'reduce'` for stills.
  Fonts are pinned: Chromium and VHS only see [`fonts.conf`](fonts.conf) (`FONTCONFIG_FILE`): Roboto, DejaVu Sans
  (fallback) and Sans Mono, Noto Color Emoji, JetBrains Mono, with aliases so that the app's font stack resolves to
  Roboto whatever the host has. Before capturing, the `setup` project checks with `fc-match`, then asks Chromium which
  fonts it really draws the app's stacks with.
- **Page state:** every page starts with this `localStorage`, plus `options.storage`:
  - `qaboard.release-notes.last-seen`: the slug of the newest release note whose period ended before T0 (a
    `YYYY-MM-DD` date works too), so What's new doesn't pop up (except in `whats-new/*`);
  - `controls-panel-expanded`: `false` unless the shot needs the panel;
  - no redux-persist state (favorites and date ranges come from the URL or the actions).
- **Waits** (`ui.settle()`, called after navigation and after `actions`):
  1. `document.fonts.ready`;
  2. no request in flight for 500 ms, ignoring long-polling (a request in flight for over 10 s); the page's load
     events count as activity;
  3. no `.bp6-spinner`, `.bp6-skeleton` or animated `.bp6-progress-bar` visible, except the spinners that say a run is running
     (its status, `aria-label="Running"`, and in tags): they stay while it runs;
  4. `ui.tiles()`: no `/iiif/` request in flight for 750 ms and every `.openseadragon-canvas` has drawn. The viewer
     tracks OpenSeadragon's `fully-loaded-change` internally but doesn't expose it: until it does (a `data-shot`
     attribute is the proposed fix), the network rule decides;
  5. `ui.plots()`: every `.js-plotly-plot` has `_fullLayout`, and no `plotly_afterplot` event fired for 300 ms
     (listeners are attached with `gd.on`).
- **Masks:** only for what is truly volatile (a live log's elapsed time, a running batch's spinner). Never mask data.
  Masked elements are hidden (`visibility: hidden`), so what's behind them shows, and spinners in them don't block
  `settle()`.
- **Layout shifts:** hovering an image the first time shows the hovered pixel's values above the images, which pushes
  them 18 px down. A point measured before would land elsewhere, depending on timing: `commit.spec.ts` hovers with
  `hoverImage()`, which measures the image once it stopped moving (`stableBox()`), and clips hover the images in their
  `actions`, so that the shift isn't recorded. The values can show later than two measures of a "stable" box (a busy
  runner): `commit/roi-histograms` waits for them before it measures, and fails if the image moved during its drag.
- **Mouse wheel:** OpenSeadragon ignores a wheel event less than 50 ms after the last one it zoomed for
  (`minScrollDeltaTime`): `ui.wheel()` waits 80 ms between steps in stills (it waited 30 ms: steps were dropped or not
  depending on the machine's speed), and the page settles after each step in clips.
- **Clips** only record scripted time ([Clips](#clips)): the same snapshot gives the same duration (±20 ms) and the same
  frames. What's left: in a cursor move, a frame can show what the page drew for the previous point of the path (the
  hovered pixel's values: up to 0.11% of a frame compared at half size), so clips default to a `dedupeTolerance` of
  0.002.
- **Tapes:** the commands run for real, so what they measure changes with every run (`qa run` prints each stage's time
  and the runtime): a tape's `dedupe_mask` hides those rectangles from the comparison, and `Hide`/`Show` around a
  `Wait` cuts a command's run time out of the video (its output appears at once).
- **No churn:** `publish.py` keeps the published file when the new capture is within the dedupe tolerance. Two captures
  on one snapshot, with one stack, dedupe as unchanged (the 12 phase 1 media, checked locally): compare captures from
  the same machine, never a local capture with one from Actions (different host rendering).

### Known issues
- The image viewer's **Sharpen** filter draws seams at the borders of the tiles (it filters each tile on its own):
  `commit/image-filters` uses brightness and gamma only.
- The **histograms** of a selected region (`commit/roi-histograms`) are computed from the rendered canvas, at whatever
  resolution the tiles have loaded. Once the tiles are loaded (`settle()`), they're the same from one capture to the
  next: the shot varied (0.04-0.39%) because the region was dragged while the images moved down (layout shifts above).
- In **`commit/image-diff`**, while the Controls panel is open, its text lands 1 pixel apart in about a third of the
  recordings (0.27-0.30% of the frames differ, compared at half size; the panel's `right` and the page's scroll are the
  same). The clip's `dedupeTolerance` is 0.005 until the cause is found.
- In clips, the sidebar's user name can be drawn half a pixel apart from one recording to the next (0.01% of a frame,
  constant within a recording).
- Clips take about 3-6 times their length to record (`commit/image-diff`: 11 s of clip, 40-55 s of waits cut out):
  each point of a cursor move waits for the page to draw it.
- **Rebuilt demo data** (a reseed) changes the runtime metrics, which are measured: the shots that show them change
  slightly.
- **`logs/live-tail`** records a run that really runs: it starts `qa run` (this checkout's, with `uv`) on the inference
  gateway's `bursty-high`, shared with the stack in a `live-tail` batch of `tuned-batching`, measuring for 2 minutes so
  that it's still running when the clip ends, then stops it and deletes the batch. It needs cargo (the first capture
  builds `gateway-bench`, about 2 minutes), and differs from one recording to the next (up to 8% of a frame: timings,
  request ids, how loaded the machine is): its `dedupeTolerance` is 0.15. `ci/step-summary` also runs `qa`
  (`qa gate --format markdown`) with `uv`.
- **The tuning forms** list a batch's tests from the inputs in the commit's artifacts folder: the examples' `inputs`
  folder isn't saved there, so `tuning.spec.ts` links it into the detector's commits while it captures, and removes
  the links afterwards ([`demo/webapp_runs.py`](demo/webapp_runs.py) `link`, `unlink`). **`tuning/launch-to-analysis`**
  really sends its grid: its 8 runs run in the backend's container (`QABOARD_TUNING_RUNNER=local`), about a minute
  cut from the clip. `webapp_runs.py build` first prepares them, cached in `<results>/.qaboard-demo-runs/`: the
  detector's photos and models (the first time, a few minutes: PyTorch for the ONNX export), its Python packages for
  the backend's Python, and an `.envrc` the backend's `qa batch` sources. The batch is deleted afterwards. Its
  accuracy metrics are the same from one recording to the next, its latency isn't: the clip's `dedupeTolerance` is 0.01.
- **`cli/batch`** shares a batch (`--label my-batch`) on the camera ISP's head of `main`, and deletes it in its hidden
  teardown. It ends while the runs run: its `dedupe_mask` hides their logs.

## Budgets

`publish.py` fails, before uploading anything, when a file is over budget.

| Kind | Rule |
|---|---|
| Still | AVIF ≤ 250 KB, WebP ≤ 450 KB (both at 2x), LQIP data URI ≤ 1 KB. PNG master ≤ 6 MB, never served to readers |
| Clip | 6-20 s; MP4 ≤ 3 MB and WebM ≤ 3 MB; `landing/hero` ≤ 2 MB each; poster ≤ 200 KB |
| Tape | ≤ 45 s; MP4 and WebM ≤ 1.5 MB each |
| All published media | ≤ 120 MB served files in total (GitHub Pages: 1 GB per site) |
| Landing page | ≤ 4 MB before any clip plays; the hero poster is the LCP element (< 2.5 s on 4G) |

## Publishing (`publish.py`)

`uv run docs-media/publish.py [--only GLOBS] [--dry-run] [--base-url URL] [--manifest PATH]`, then
`publish.py gc [--dry-run] [--days 90] [--no-prs]`. Encoders: `install-tools.sh` (oxipng 10.2.0, libavif 1.4.2,
libwebp 1.6.0) and the distribution's ffmpeg (Ubuntu 24.04: 6.1.1). Budgets count 1 KB = 1000 bytes.

1. **Encode** each `out/<id>/`, and each `out/<id>/dark/` (see [Light and dark](#light-and-dark)):
   - stills: PNG (oxipng), AVIF (`avifenc -q 60 --yuv 444 -s 4`), WebP (`cwebp -q 82 -m 6 -sharp_yuv`),
     LQIP (16 px wide WebP, base64);
   - clips and tapes: MP4, WebM, poster, and `captions.vtt` when there are captions.
2. **Dedupe** against the current manifest entry, downloaded from `base_url` (the S3 API when it isn't reachable),
   cached in `website/.media-cache/media/<key>` like the docs plugin does:
   - stills: same dimensions, and [pixelmatch](https://github.com/mapbox/pixelmatch) 7 (`threshold 0.1`, anti-aliasing
     ignored; a numpy port, checked against the JS one) finds at most `dedupeTolerance` of the pixels different on
     the PNG masters;
   - clips and tapes: duration within ±10%, and the poster plus one frame per second pass the same test. A frame
     passes if the old video shows it within ±0.4 s; frames are compared at half their size (2x2 pixels averaged), so
     that the encoder's artifacts on detailed content, which differ between two encodes of recordings that look the
     same (up to 0.1% of the pixels), don't count;
   - a tape's `dedupe_mask` (meta.json, from its header) lists rectangles that don't count.
   - If unchanged, the entry keeps its files (no upload) and takes the spec's current alt, caption and project. A
     shot whose `revision` (spec option or tape header) differs from the published one's is never unchanged: bump it
     when a high `dedupe_tolerance` would keep a worse capture, e.g. a fixed clip of a live run.
3. **Upload** changed files to the `qaboard-media` bucket (S3 API) at `shots/<id>/<hash>.<ext>`:
   - `<hash>`: the first 16 hex characters of the file's SHA-256;
   - `Cache-Control: public, max-age=31536000, immutable`, the right `Content-Type`;
   - objects are never overwritten (`If-None-Match: *`, which R2 honors: 412 when the key exists).
   - `base_url`'s path, if any, prefixes the object keys (`https://<host>/_test` writes `_test/shots/...`), to try
     `publish.py` without touching real shots.
4. **Manifest:** write `website/media.json` (sorted keys, 2-space indent, final newline), valid against
   `website/media.schema.json`. `captured` is the capture date; `app_version` is the stack's `qaboard` version plus its
   short git sha (e.g. `1.1.1+78813fe`).
5. **`gc`:** R2 lifecycle rules can't see references, so `gc` deletes objects under `shots/` older than 90 days that no
   `website/media.json` references, on `master`, on an open PR branch or at a release tag of the last 90 days.
   It needs `origin/master` and the tags fetched, and lists pull requests with `gh api` (`GH_TOKEN`).
6. **Gallery:** `out/gallery.md` (before/after from `base_url`, for the PR comment), `out/gallery/index.html` (local
   files, a workflow artifact) and `out/publish-report.json`.
7. A shot fails if `shots.yaml` lists `anchors` its capture didn't record.
8. **Dark variants:** a dark capture becomes the entry's `dark` (`files`, `lqip`; the anchors are the light one's). It
   must have the light capture's kind and size, and a light capture, in the same run or published. It's deduped like
   the light one, against the published `dark`; and if it looks like the light capture within the shot's tolerance
   (a template page with no dark theme), the entry gets no `dark` and readers see the light one. When only the light
   capture is published, the entry keeps its `dark` while the size doesn't change. `gc` and the served-bytes budget
   count the dark files.

## Serving: the docs build fetches media

Readers load media from the docs site itself. The public media hostname (`base_url` in `media.json`) is for build
tooling and contributors only: it never appears in a page.

- `website/plugins/media/` reads `media.json` and, in **local** mode (every `yarn build`, including the web app's docs
  image built with `QABOARD_DOCS_FOR_WEBAPP=true`):
  - downloads each referenced file into `website/.media-cache/media/<key>` (8 in parallel, `HTTPS_PROXY` honored,
    retried, the SHA-256 prefix checked against the file name), skipping files already cached;
  - adds `.media-cache` to `staticDirectories`, so a file is served at `useBaseUrl('/media/' + key)`;
  - downloads AVIF, WebP, MP4, WebM, posters and VTT. PNG masters only for ids in the plugin's `png` option
    (default `['landing/social-card']`).
  - removes cached files the manifest no longer references, so they don't end up in the build;
  - only fetches the shots pages use.
- **Remote** mode (default for `yarn start`): components load straight from `base_url`, nothing is downloaded. The
  bucket's CORS headers let clips load their captions cross-origin.
- `QABOARD_MEDIA=local|remote|placeholder` overrides the mode. `placeholder` builds without network access (every
  shot renders as a placeholder). `QABOARD_MEDIA_BASE_URL` points at a mirror for air-gapped builds.
  `QABOARD_MEDIA_MISSING` keeps a local build going when some files can't be downloaded (e.g. a proxy blocks videos),
  with a warning (strict builds still fail): `remote` has readers' browsers load those shots from `base_url` (or the
  mirror, which then needs the bucket's CORS headers for the captions), `placeholder` renders them as placeholders.
  The leak check below then allows the host readers load them from. An HTML answer for a media file (a proxy's
  "blocked" page) isn't retried. The website image passes all three as build args.
- When the browser can't load a published shot (e.g. a proxy blocks the media host), the components show a
  placeholder that says it's unavailable, with the shot's description, instead of a broken image or video.
- The plugin exposes `{mode, base, shots, planned}` as global data for the components (`planned`: what placeholders
  show).
- After a build in local or placeholder mode, the build fails if the media hostname (or the mirror's) appears in the
  built site.
- **Build checks** (a remark plugin collects literal `id`/`before`/`after` props from MDX, plus a scan of
  `website/src/**/*.{tsx,js}`):
  - an id that is neither in `media.json` nor in `docs-media/shots.yaml` fails the build (typo);
  - an id in `shots.yaml` but not yet in `media.json` renders a placeholder; strict builds (`QABOARD_MEDIA_STRICT=1`:
    release tags and the monthly refresh) fail instead;
  - a `media.json` entry no page uses is a warning, an error in strict builds;
  - a component with the wrong kind (`<Shot>` of a clip), a non-literal id, or a `<Compare>` of two sizes fails;
  - a callout `anchor` must be listed under the shot's `anchors` in `shots.yaml`, then recorded in `media.json`
    (a warning, an error in strict builds);
  - `media.json` is validated against its schema, so an entry without `alt` can't exist.
- The checks parse every page themselves (webpack's persistent cache can skip the MDX loader). With `yarn start`,
  problems are warnings and the page shows them. Without `docs-media/shots.yaml` (e.g. a copy of `website/` alone;
  the website image includes it), ids missing from `media.json` render as placeholders without checks.

## Website components (spec; WS4 implements)

Files: `website/src/components/{Shot,Clip,Compare}.tsx` and `StackPicker/`, values in `website/src/components/stack.ts`.
Props must be literals in MDX (`id="commit/flame-diff"`), so the build checks can read them. `Shot`, `Clip` and
`Compare` are available in every MDX page without an import (`website/src/theme/MDXComponents.tsx`).

### `<Shot>`

```ts
type Callout = {
  anchor?: string;             // a name recorded by ui.anchor(); or give x/y
  x?: number; y?: number;      // % of the image width/height, top-left origin
  w?: number; h?: number;      // % size, for kind 'box'
  kind?: 'dot' | 'box';        // default 'dot' for x/y, 'box' for an anchor
  label?: string;              // plain text, listed under the image
};
type ShotProps = {
  id: string;
  caption?: string;            // overrides the manifest caption; '' hides it
  alt?: string;                // overrides the manifest alt (rare)
  callouts?: Callout[];
  maxWidth?: number;           // CSS px; default and maximum: the manifest width (never upscaled)
  priority?: boolean;          // eager load + fetchpriority="high" (the LCP image); default lazy
  zoom?: boolean;              // click opens the full-size image in a dialog; default true
};
```

- Renders `<figure>` → `<picture>` (AVIF source, WebP source, WebP `<img>`) with `width`/`height` from the manifest, so
  there's no layout shift, `loading="lazy"`, `decoding="async"`, and the LQIP as background until it loads.
- With a `dark` variant, both `<picture>`s are in the page and CSS shows the one of the docs' color mode
  (`html[data-theme]`): no flash on hydration, and browsers don't fetch the hidden lazy image. `<Compare>` and the zoom
  dialog do the same; `<Clip>` loads the dark variant's sources in dark mode.
- Call-outs are numbered markers (`aria-hidden`) drawn over the image, scaled with it. Their labels are an ordered list in
  the `<figcaption>`, after the caption, so screen readers get them.
- A planned id (in `shots.yaml`, not yet in `media.json`): a placeholder box with the planned aspect ratio (16:10 when
  unknown), the id, and `shows` from `shots.yaml`. In `yarn start`, an unknown id shows the same box with an error
  instead of stopping the dev server.

### `<Clip>`

```ts
type ClipProps = {
  id: string;                  // kind 'clip' or 'tape'
  caption?: string; alt?: string; maxWidth?: number; priority?: boolean;
  autoplay?: 'inview' | 'never';   // default 'inview'
  loop?: boolean;                  // default true
};
```

- `<video muted playsinline preload="none" poster=...>` with WebM then MP4 sources, `aria-label` = alt, the same
  `width`/`height` as the manifest. Tapes get a dark terminal frame.
- **Autoplay:** plays when at least half visible (IntersectionObserver), pauses when it leaves the viewport. Never with
  `prefers-reduced-motion: reduce`, or `autoplay="never"`: then the poster shows with a play button.
- A pause/play button is always visible (WCAG 2.2.2), and the video is keyboard focusable.
- Captions: the current VTT cue as an overlay at the bottom, plus `<track kind="captions" default>`.

### `<Compare>`

```ts
type CompareProps = {
  before: string; after: string;   // two still ids with the same width and height (build check)
  beforeLabel?: string;            // default 'Before'
  afterLabel?: string;             // default 'After'
  position?: number;               // initial divider position in %, default 50
  orientation?: 'horizontal' | 'vertical';  // default 'horizontal' (divider moves left-right)
  caption?: string; maxWidth?: number;
};
```

- Both images stacked; the after image clipped at the divider. Drag, click or touch to move it.
- The divider is a `role="slider"` (`aria-valuenow` in %), arrows move 1%, Page Up/Down 10%, Home/End to the ends.
- Labels stay pinned in the top corners. Alt text: `before.alt` then `after.alt`.

### `<StackPicker>`

```ts
type StackGroup = 'server' | 'forge' | 'ci' | 'runner' | 'code';
type StackPickerProps = { groups?: StackGroup[]; compact?: boolean };  // default: all groups
```

Canonical values (`stack.ts`, the only place they're defined; the first one is the default):

| Group | Values (label) |
|---|---|
| `server` | `compose` (Docker Compose), `k8s` (Kubernetes (Helm)) |
| `forge` | `github` (GitHub), `gitlab` (GitLab) |
| `ci` | `github-actions` (GitHub Actions), `gitlab-ci` (GitLab CI), `jenkins` (Jenkins) |
| `runner` | `local` (Local), `lsf` (LSF), `dask` (Dask), `celery` (Celery) |
| `code` | `python` (Python), `executable` (Any executable) |

- Pages use plain Docusaurus tabs with those values: `<Tabs groupId="ci" queryString>` and
  `<TabItem value="github-actions" label="GitHub Actions" default>`. A build check (`website/plugins/stack`) rejects unknown groups or values.
- The picker shows one segmented control per group. A choice:
  - writes the same storage slot as Docusaurus tabs (`docusaurus.tab.<group>`, through `createStorageSlot` from
    `@docusaurus/theme-common`), so every tab group on the page switches at once and later pages remember it;
  - updates the URL query (`?server=k8s&ci=github-actions`) with `history.replace`, keeping the other parameters, so a
    copied link carries the choice.
- On load: URL parameters win, then storage, then defaults. URL values are written to storage, because Docusaurus tabs
  only read the query string and don't persist it.
- Without JavaScript the defaults (GitHub everywhere) show.

## When it runs (`.github/workflows/docs-media.yml`)

| Trigger | What happens |
|---|---|
| `workflow_dispatch`, inputs `only` (glob over ids, default `*`), `reseed` (default false), `publish` (default true) | The main way: capture the matching shots; with `publish`, upload and open a PR with `website/media.json` |
| PR labeled `docs-media` (same-repo branches only) | Capture the affected shots, upload, commit `website/media.json` to the PR branch, comment a before/after gallery |
| Tag `v*` | Reseed if the snapshot key changed, full refresh in strict mode, build and push the demo-data image (`demo-data-<version>`), open a PR |
| Monthly (`17 6 2 * *`, with the release notes) | Full refresh from the snapshot; opens a PR only if something changed beyond the tolerance; runs `publish.py gc` |

- Never on push. One run per ref at a time (`concurrency`), PR runs cancel the previous one.
- A capture that fails (a spec waiting for an element the web app no longer has fails after 20 s,
  `SHOTS_ACTION_TIMEOUT`) doesn't stop the others from being published, except in strict runs: the failed shots keep
  their published version, and the job fails.
- The stack runs this checkout's images (built like CI's, from its layer cache), so web app changes show.
  `affected.py` computes the affected shots of a pull request.
- **Affected shots** on a PR: every still and clip (the specs' areas, not the tapes) if `webapp/**` or
  `docs-media/shots/lib/**` changed, all of them if `docs-media/fonts.conf` did; an area if its
  `shots/<area>.spec.ts` changed; a shot if its template (`shots/templates/<subject>.html`) changed; a project's shots, with a reseed, if `examples/<project>/**` changed; a tape if its
  `.tape` changed.
- **Reseed** when `reseed` is set, or when no snapshot fits (`snapshot.py pick`): the snapshot of this checkout's key
  (a hash of `examples/**`, `docs-media/seed.py`, `backend/backend/models/**` and `qaboard/**`), else the newest one
  taken from a commit with the same stories (`examples/**` and `docs-media/seed.py`). Changes to the CLI or the
  backend don't reseed: they don't change what the stories seed, and the backend migrates the restored database when
  it starts. Snapshots are `snapshots/<key>.tar.zst` in `qaboard-ci`.
- **Gallery:** the PR comment shows before/after thumbnails from `qaboard-media` (new files are uploaded anyway, under
  new keys); the full HTML gallery is a workflow artifact.
- **Runtime** on a 4-CPU runner, measured on a light-only run (2026-10): setup and images 5 min, captures 15 min (the
  14 clips most of it), tapes 12 min (the quickstarts' start a kind cluster), publishing 13 min. The dark captures
  about double the captures and what publishing encodes. A reseed adds the stories' seeding time (budgets in each
  `examples/<project>/SPEC.md`): about 70 min for the three phase-2 projects, since `serving-latency` measures
  performance and must run alone. Seeding each project in its own job and merging the results would bring it down.
- **Secrets:** `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, scoped to `qaboard-media` and
  `qaboard-ci`. Fork PRs never get them, and the workflow doesn't run for them.
- **Demo-data image:** every run that restores or seeds the snapshot builds and tests it; runs on master and tags
  publish it (see [The demo-data image](#the-demo-data-image)). Then the demo stack stops, and the quickstarts' tapes
  are recorded with it and this run's images (about 10 minutes with kind), before `publish.py`.
- **Permissions:** `contents: write`, `pull-requests: write`, `packages: write` (the demo-data image).
