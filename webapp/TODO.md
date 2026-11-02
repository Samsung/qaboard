# Webapp TODO

Follow-ups from the move to Vite 8 / React 19 / Blueprint 6, then to TanStack Query / Zustand / function components (October 2026), most valuable first.
Check items off or delete them when done, add new ones with enough context for someone else to pick them up.

## Bugs / risks
- [ ] **Check the viewers on staging after the state migration**: images (OpenSeadragon/IIIF, auto-ROIs, crops), ToF point clouds, SLAM, flame graphs, bit-accuracy trees, the tuning forms. They now fetch files with TanStack Query and `fetch` instead of axios, and most were rewritten as function components. Unit tests cover their logic, not their rendering. The ToF viewer also draws on demand since October 2026, checked with synthetic point clouds in Chromium only: try orbiting (it keeps moving a little after a drag), zooming, changing frames, the mesh/points switch and reopening.
- [ ] **Old plotly figures**: plotly.js@3 dropped deprecated attributes. `src/components/PlotlyPlot.jsx` upgrades string titles and `titlefont`, but figures with other removed attributes (`bardir`, `annotation.ref`, `autotick`, `heatmapgl`/`pointcloud` traces...) may render differently. Extend `upgradeFigure` if users report it.
- [ ] **Node on SIRC GitLab runners** is 22.14 (`deployments/sirc/.envrc`), close to the minimum the toolchain supports (22.12). Move them to Node 24 LTS like Docker and GitHub Actions.
- [ ] **Lazy tooltips** (`src/components/LazyPopover.jsx`, the commit lists' rows): checked in Chromium only. Check in Firefox and Safari that a tooltip created under the pointer closes when it leaves, and on a real touch screen that tapping a tag shows its tooltip.
- [ ] **ToF viewer's pointer-lock mode** shows a blank view (also before October 2026): its camera rig is never added to the scene, and the orbit controls stay attached.
- [ ] Compact commit rows with pending, running, failed and other batches' tags at once: the tags overlap the date column.
- [ ] Viewers not covered by automated tests with real data: images (OpenSeadragon/IIIF), ToF point clouds (three.js), SLAM, flame graphs, videos. Check them manually on staging after deploys that touch them.

## UX
- [ ] **Menus that open on hover**: all popovers use `<PopoverNext>` (Blueprint's `<Popover>` mis-positions content with React 19), and the commit, batch and run action menus open on click. Other menus still open on hover, so not on touch screens and sometimes by accident: the sidebar's Integrations and Milestones submenus, "Change" next to the commit id (`CommitNavbar.jsx`), the configuration tags' copy menus (`ConfigurationsTags` in `tags.jsx`), the image viewer's "Copy" menu and "View ROIs". Move them to click one at a time, checking that their contents still work (e.g. the integrations' search box).

## Performance
Measure with `npm run bench` before and after (`BENCH_OUTPUTS=5000 BENCH_COMMITS=1000` magnifies). On a busy machine its `cpu` column (main-thread time) varies much less than `time`.
- [ ] **Commit page polling** backs off while nothing changes (`pendingRefetchInterval` in `src/api/queries.js`), but each refresh still downloads every output. Poll the summary instead (`commitSummaryQuery`, `with_outputs=false`) and refetch the outputs only when the batches' counts change, or answer `304` with an ETag on the commit endpoint.
- [ ] The commit page's chunk imports the tuning views (`TuningForm`, `BatchesEditor`, `TuningExploration`) and `BatchLogs` (with the log viewer and `ansi-to-html`) even when they're not shown: `lazy()` would take ~60 kB gzip off it. No gain was measured in October 2026 (the shared chunks and icons arrive later anyway): measure again if the page's other chunks shrink.
- [ ] `src/api/queryClient.js`: TanStack's persister dehydrates the whole cache on every cache event (we skip writing when nothing persisted changed, not the dehydration). Each output card adds 2 manifest queries, so it grows with the Visualizations.
- Measured in October 2026, not worth changing: the IndexedDB restore (4-13 ms with 600 projects; restoring before the first render delayed the first paint), lazy-loading the command palette (Rolldown splits the modules it shares into chunks that are still preloaded), lazy Home/Explore (`/` shows 200-500 ms later), `@popperjs/core` (Blueprint's `Tooltip` needs it), debouncing `TuningForm`'s saves to localStorage (under 0.1 ms per keystroke with 50 kB of preferences, 30 ms with 2 MB). `qs` stays: `src/selection.js` relies on nested keys (`compare[1][commit]=b`).

## Testing / CI
- [ ] Run the Playwright smoke tests (`npm run e2e`) in GitLab CI too. They run in GitHub Actions; the LSF runners need Chromium (`npx playwright install chromium` through the proxy, or use `PLAYWRIGHT_CHROMIUM_EXECUTABLE`).
- [ ] Extend `e2e/smoke.spec.js` with realistic fixtures (batches, outputs, metrics) to cover the viewers and the tuning forms (Monaco).
- [ ] oxlint has no warnings left (`npm run lint`), and `no-unused-vars` is an error: make more rules errors. `no-autofocus` (inputs and dialogs users open) and `prefer-tag-over-role` (the image and video viewers' widgets) are off, a few lines are disabled with a reason (`oxlint-disable`).

## Architecture
- [ ] **One class component is left** (besides `ErrorBoundary`): `TofOutputCard` (`src/viewers/tof/`, three.js). Convert it together with the three.js upgrade below, when someone can check it visually.
- [ ] The React Compiler skips 5 components/hooks it can't compile yet (try/catch with optional chaining, `finally`, one internal error in `src/viewers/text.jsx`): `REACT_COMPILER_LOG=1 npm run build` lists them. Fine as is, revisit with newer compiler versions.
- [ ] Tuning ideas: a Pareto frontier that accounts for noisy metrics, and initial guesses (e.g. clustered from past runs) for the Bayesian optimization.
- [ ] Routes keep our own matching (`src/router.jsx`): `/:project_id+/...` can't be expressed with react-router's or TanStack Router's patterns.
- [ ] New files in TypeScript (`.tsx`); `npm run typecheck` already runs in CI.
- [ ] styled-components is in maintenance mode: prefer CSS modules for new code. We keep v5 prop-forwarding behaviour via `StyleSheetManager` in `src/App.jsx`; using transient props (`$isExpanded`) would let us drop it.

## Dependencies left behind
- [ ] three.js 0.136 -> current: our copies of `OrbitControls`/`PCDLoader`/`PointerLockControls` (`src/viewers/tof/`) can come from `three/examples/jsm`. Colors change since r152 (color management), check point clouds visually.
- [ ] d3-flame-graph 4 -> 5, react-full-screen -> Fullscreen API.
- [ ] plotly.js 4: wait for it to mature. It shows an "Upload to Cloud" button by default, disable it when upgrading.
