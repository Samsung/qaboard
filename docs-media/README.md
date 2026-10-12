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
                       # (ghcr.io/samsung/qaboard, tag demo-data-<version>, phase 2)
  demo/                # stack.py (the stack, for seed.py and snapshot.py), kitefin_stub.py (*.kitefin.example)
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
  src/components/{Shot,Clip,Compare,StackPicker}.tsx, stack.ts
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
- **Selection:** `SHOTS_ONLY` (captures), `--only` (tapes, publish) take comma-separated globs over ids.
- **`out/<area>/<subject>/meta.json`** is what `publish.py` reads: `id`, `kind`, `width`/`height` (CSS px of the
  shot), `scale`, `alt`, `caption`, `project`, `app_version`, `source_spec`, `captured` (ISO time), `t0`,
  `dedupe_tolerance`, `anchors`, `files`; clips add `region` (their box in the viewport, CSS px), `duration`, `frames`,
  `poster`, `loop`; tapes add `duration`, `poster`.
- `npm test` in `shots/` runs the lib's own tests on fixture pages (an OpenSeadragon viewer on a slow fake IIIF server,
  Plotly redraws, spinners, a page to click, type, wheel and drag on), without the demo stack.
  `uv run docs-media/test_publish.py` tests `publish.py` on synthetic captures.
- Locally, `PLAYWRIGHT_CHROMIUM_EXECUTABLE` uses a Chromium that's already installed.

### Stills
1. A spec calls `shot(id, options)` (API below), which registers one Playwright test named after the id.
2. The test opens `options.url`, runs `options.actions`, waits until the page is settled, then screenshots the viewport
   or `options.target` (plus `padding`), at 1440x900 and `deviceScaleFactor: 2`. A target is measured once its box stops
   moving (a popover still opening), and never crops in the bars fixed at the top of the viewport (the commit page's
   header): if it's under them, the page scrolls it below. Scrolling moves what's under the mouse and closes the popovers
   that open on hover: before hovering, scroll the target in place in the actions.
3. It writes `out/<id>/still.png` and `out/<id>/meta.json` (`kind`, `width`/`height` in CSS pixels, `alt`, `caption`,
   `project`, `app_version`, `source_spec`, `anchors`).

Captures stay clean: no arrows, boxes or text burned in. Call-outs are HTML overlays added by `<Shot callouts>`,
positioned from the `anchors` a spec records with `ui.anchor(name, locator)`, so they survive a re-capture.
The one exception is `landing/social-card`: a spec renders an HTML template (logo, tagline, a crop of another shot) at
1200x630, scale 1.

### Clips
- 6-20 s, silent, 30 fps, captioned. Same viewport and scale as stills, `reducedMotion: 'no-preference'`.
- **Recording:** the CDP screencast (`Page.startScreencast`, JPEG quality 92, every frame), not Playwright's video,
  which is too blurry. Frames arrive only when the page repaints, each with a timestamp: `record.ts` writes
  `out/<id>/frames/NNNNN.jpg` and an ffmpeg concat list with each frame's duration.
- **Encoding** (in `publish.py`): resample to constant 30 fps, scale to at most 1920 px wide.
  - MP4: H.264 High, `-crf 26 -preset slow -pix_fmt yuv420p -movflags +faststart`, no audio track.
  - WebM: VP9, `-crf 36 -b:v 0 -row-mt 1 -cpu-used 2` (the default `-cpu-used 0` takes minutes per clip), no audio track.
  - Poster: WebP (`-q 80`) of the frame given by `poster` (default: the last frame), at the video's size.
- **Cursor:** a fake cursor (SVG arrow, injected by `addInitScript`) moves along eased paths; clicks show a ripple.
  It is burned into the video. Stills never show it. The real mouse follows the same path, so hovers happen.
- **Captions** are not burned in: each `ui.caption(text)` adds a WebVTT cue (`out/<id>/captions.vtt`) starting at that
  moment. `<Clip>` overlays the current cue and adds a `<track kind="captions">`. Keep cues under 60 characters.

### Terminal tapes
- [charmbracelet/vhs](https://github.com/charmbracelet/vhs) 0.11.0 (`install-tools.sh`; 0.12 writes no video), with
  ttyd, ffmpeg and a Chromium. `uv run docs-media/tapes/record.py [--only GLOB]` runs VHS from `docs-media/`, then
  writes `meta.json`. File `tapes/<area>-<subject>.tape` makes shot `<area>/<subject>`.
- Each tape starts with `# key: value` lines: `alt` (required), `caption`, `project`, `user` (the persona, default
  `ines`), `env` (extra `KEY=VALUE`s, e.g. CI variables), `poster`, `dedupe_tolerance`.
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
  settle(opts?: { timeout?: number }): Promise<void>;  // the default wait, see Determinism
  tiles(opts?: { timeout?: number }): Promise<void>;   // OpenSeadragon images fully loaded
  plots(opts?: { timeout?: number }): Promise<void>;   // Plotly graphs drawn and quiet
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
  hold(ms: number): Promise<void>;                     // let the viewer read; recorded as-is in clips
  anchor(name: string, target: Locator): Promise<void>; // records target's box, in % of the shot, for <Shot callouts>
}

export interface ShotOptions {
  project: ProjectKey | null;                          // null: not tied to a demo project (login, What's new)
  url: string | ((demo: Demo) => string);
  alt: string;                                         // required, see website/STYLE.md
  caption?: string;                                    // default caption; pages can override it
  actions?: (ui: Ui) => Promise<void>;
  target?: (page: Page) => Locator | Locator[];        // crop to this element (several: their union); default: the viewport
  padding?: number;                                    // CSS px around target, default 16
  mask?: (page: Page) => Locator[];                    // painted over with the surrounding background color
  viewport?: { width: number; height: number };        // default 1440x900
  storage?: Record<string, string>;                    // localStorage entries, merged over the defaults
  login?: string | null;                               // persona logged in (password kitefin-demo); default: the project's main author
  dedupeTolerance?: number;                            // share of differing pixels still "unchanged", default 0.0005
}

export interface ClipOptions extends Omit<ShotOptions, 'target'> {  // actions: set the scene before recording, not drawn
  script: (ui: Ui) => Promise<void>;
  region?: (page: Page) => Locator | Locator[];        // crop the recording to this box at start
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
- **Clock:** `page.clock.install({ time: T0 })` then `page.clock.resume()`: time starts at T0 and flows normally.
  Don't use `setFixedTime`: OpenSeadragon's springs and Plotly transitions read `Date.now()` and stall on a frozen clock.
  Stories keep the newest data at least 10 minutes before T0, so relative times ("12 minutes ago") don't flip while
  recording.
- **Rendering:** Chromium from the pinned Playwright image; viewport 1440x900 at scale 2; `locale: 'en-US'`,
  `timezoneId: 'UTC'`, `colorScheme: 'light'`; `reducedMotion: 'reduce'` for stills.
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
  3. no `.bp6-spinner`, `.bp6-skeleton` or `.bp6-progress-bar` visible;
  4. `ui.tiles()`: no `/iiif/` request in flight for 750 ms and every `.openseadragon-canvas` has drawn. The viewer
     tracks OpenSeadragon's `fully-loaded-change` internally but doesn't expose it: until it does (a `data-shot`
     attribute is the proposed fix), the network rule decides;
  5. `ui.plots()`: every `.js-plotly-plot` has `_fullLayout`, and no `plotly_afterplot` event fired for 300 ms
     (listeners are attached with `gd.on`).
- **Masks:** only for what is truly volatile (a live log's elapsed time, a running batch's spinner). Never mask data.
  Masked elements are hidden (`visibility: hidden`), so what's behind them shows, and spinners in them don't block
  `settle()`.
- **No churn:** `publish.py` keeps the published file when the new capture is within the dedupe tolerance.

### Known issues
- The image viewer's **Sharpen** filter draws seams at the borders of the tiles (it filters each tile on its own):
  `commit/image-filters` uses brightness and gamma only.
- The **histograms** of a selected region (`commit/roi-histograms`) are computed from the rendered canvas, at whatever
  resolution the tiles have loaded: they vary slightly between captures, and so does the shot.

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

1. **Encode** each `out/<id>/`:
   - stills: PNG (oxipng), AVIF (`avifenc -q 60 --yuv 444 -s 4`), WebP (`cwebp -q 82 -m 6 -sharp_yuv`),
     LQIP (16 px wide WebP, base64);
   - clips and tapes: MP4, WebM, poster, and `captions.vtt` when there are captions.
2. **Dedupe** against the current manifest entry, downloaded from `base_url` (the S3 API when it isn't reachable),
   cached in `website/.media-cache/media/<key>` like the docs plugin does:
   - stills: same dimensions, and [pixelmatch](https://github.com/mapbox/pixelmatch) 7 (`threshold 0.1`, anti-aliasing
     ignored; a numpy port, checked against the JS one) finds at most `dedupeTolerance` of the pixels different on
     the PNG masters;
   - clips and tapes: duration within ±10%, and the poster plus one frame per second pass the same test. Recordings
     run in real time, so a frame passes if the old video shows it within ±0.4 s.
   - If unchanged, the entry is kept as it is: no upload, no manifest change.
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
  shot renders as a placeholder). `QABOARD_MEDIA_BASE_URL` points at a mirror for air-gapped builds. The website
  image passes both as build args.
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
  problems are warnings and the page shows them. Without `docs-media/shots.yaml` (the website image is built with
  `website/` as its context), ids missing from `media.json` render as placeholders without checks.

## Website components (spec; WS4 implements)

Files: `website/src/components/{Shot,Clip,Compare,StackPicker}.tsx`, values in `website/src/components/stack.ts`.
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
  `<TabItem value="github-actions" label="GitHub Actions" default>`. A build check rejects unknown groups or values.
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
| Tag `v*` | Reseed if the snapshot key changed, full refresh in strict mode, rebuild the demo-data image, open a PR |
| Monthly (`17 6 2 * *`, with the release notes) | Full refresh from the snapshot; opens a PR only if something changed beyond the tolerance; runs `publish.py gc` |

- Never on push. One run per ref at a time (`concurrency`), PR runs cancel the previous one.
- The stack runs this checkout's images (built like CI's, from its layer cache), so web app changes show.
  `affected.py` computes the affected shots of a pull request.
- **Affected shots** on a PR: all of them if `webapp/**` or `docs-media/shots/lib/**` changed; an area if its
  `shots/<area>.spec.ts` changed; a project's shots, with a reseed, if `examples/<project>/**` changed; a tape if its
  `.tape` changed.
- **Reseed** when `reseed` is set, or when the snapshot key changes: a hash of `examples/**`, `docs-media/seed.py`,
  `backend/backend/models/**` and `qaboard/**`. Snapshots are `snapshots/<key>.tar.zst` in `qaboard-ci`.
- **Gallery:** the PR comment shows before/after thumbnails from `qaboard-media` (new files are uploaded anyway, under
  new keys); the full HTML gallery is a workflow artifact.
- **Runtime:** 15-30 min from a snapshot on a 4-CPU runner. A reseed adds the stories' seeding time (budgets in each
  `examples/<project>/SPEC.md`): about 70 min for the three phase-2 projects, since `serving-latency` measures
  performance and must run alone. Seeding each project in its own job and merging the results would bring it down.
- **Secrets:** `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, scoped to `qaboard-media` and
  `qaboard-ci`. Fork PRs never get them, and the workflow doesn't run for them.
- **Permissions:** `contents: write`, `pull-requests: write`.
