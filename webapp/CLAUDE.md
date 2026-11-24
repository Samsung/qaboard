# webapp/CLAUDE.md
The React web app. Setup, env variables (`REACT_APP_QABOARD_HOST`, default `http://localhost:5151`): `README.md`.
Follow-ups: `TODO.md`. Cross-directory rules ("Change together"): root `CLAUDE.md`.

## Commands
```bash
npm start                    # Vite dev server
npm run build                # production build; npm run preview serves it; npm run analyze adds build/stats.html
npm test -- --run            # Vitest + Testing Library (jsdom); `npm test` watches; `npm test -- isolation` one file
npm run lint                 # oxlint
npm run typecheck            # tsc
npm run e2e                  # Playwright smoke tests (e2e/) on the production build, mocked API: run npm run build first
npm run bench                # performance measurements (Playwright, e2e/perf/)
npm run build:image-viewer   # the image viewer as an npm package, see src/image-viewer/README.md
```

## Stack
React 19 (function components, React Compiler), TanStack Query (server state), Zustand (user preferences), the URL for
what's selected (`src/selection.js`), Blueprint 6, React Router 8, D3, Plotly.js 3, Monaco; Vite 8.

## Standalone viewers
These import only third-party packages and their own files; the app reaches them only through an adapter, loaded
lazily, and their CSS doesn't leak. Don't import the app from them.
- `src/image-viewer/` (OpenSeadragon; adapted in `src/viewers/images/`: runs, image servers, pixel values, regions of
  interest providers). Checked by `src/image-viewer/__tests__/core.test.js`: other apps install it.
- `src/viewers/benchmarks/`, `flamegraph/`, `parallel/`, `audio/`: checked by `src/viewers/__tests__/isolation.test.js`.
  Adapters: `viewers/benchmarks-viewer.jsx`, `flame-graph.jsx`, `audio-viewer.jsx`; `OutputViewer.jsx` loads them.
- Their Python counterparts are standalone too (`qaboard/CLAUDE.md`). Parsers shared with Python (benchmarks, series,
  media): root `CLAUDE.md`, "Change together".

## Playgrounds
`npm start`, then open these pages (each is `webapp/<name>.html`), with generated data:

| Page | Shows |
|---|---|
| `/image-viewer.html` (`?images=5`) | The image viewer alone; with N images, the tiles compared with an anchor |
| `/junit-viewer.html?tests=50000` | JUnit test reports (`src/viewers/junit/`) |
| `/benchmark-viewer.html?benchmarks=5000` | Benchmarks (`src/viewers/benchmarks/`) |
| `/flame-graph-viewer.html?stacks=300000` | Flame graphs: a new and a reference profile that differ in known ways (`flamegraph/generate.js`) |
| `/parallel-coordinates.html?rows=2000&columns=30` | Tuning Analysis' parallel coordinates (`src/viewers/parallel/`) |
| `/logged-media.html?steps=200&keys=12&shuffle=1` | The card's **Logged media** (`src/viewers/media/`) |
| `/audio-viewer.html` | The audio viewer (`src/viewers/audio/`) |
| `/metrics-table.html?runs=2000&metrics=30` | The commit page's Metrics Table and Metrics Diff |

## Where things are
- **Several references together**: ticked in the reference tabs (`together` in `src/selection.js`,
  `useComparison().together`), the image viewer shows N images as tiles compared with an anchor
  (`image-viewer/tiles.jsx`, `grid.js`, `comparePanel.jsx`); other viewers keep the selected (primary) reference.
- **Flame graphs**: the formats read are in `viewers/flamegraph/formats.js`; `qaboard/flamegraphs.py` converts
  `perf script` and pprof.
- **Tuning Analysis**: `components/tuning/TuningAnalysis.jsx`: `OptimizationReport.jsx` for `qa optimize` batches,
  `TuningReport.jsx` for the others (logic in `optimization.js`, `analysis.js`; explanations in `learn.jsx`).
  `ParallelCoordinatesPlot.jsx` loads `viewers/parallel/` lazily (canvas, no Plotly).
- **Logged media**: reads the index `qaboard/media.py` writes (*media.jsonl*, *media/*). Design: `docs/design/logged-media.md`.
- **Metrics Table / Diff**: `components/tables.jsx`, `components/metricsTable/`.
- **Local changes** of a run: `components/LocalChanges/`.
- **File types** the viewers recognize: `viewers/fileTypes.js`.

## Release notes ("What's new")
- Code: `src/releaseNotes/` (popup, panel, links). Vite reads `website/release-notes/*.md` when it builds, serves or
  tests (`releaseNotes.js`, imported as `virtual:release-notes`): nothing to generate. So the frontend image is built
  from the repo root (`Dockerfile`). `npm start` reloads on a note change; `QABOARD_RELEASE_NOTES_DRAFTS=1 npm start`
  shows drafts. Writing notes: `website/CLAUDE.md`.
- The popup is off with `npm start`, so it doesn't cover the page when you drive the app; `QABOARD_RELEASE_NOTES_POPUP=1
  npm start` turns it on. On a production build (`npm run preview`, e2e, a deployed server) it pops up: mark notes seen
  first, as the e2e tests do: `localStorage.setItem('qaboard.release-notes.last-seen', '9999-12-31')` (Playwright:
  `page.addInitScript`).
