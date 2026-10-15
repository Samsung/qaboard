# Webapp TODO

Follow-ups from the move to Vite 8 / React 19 / Blueprint 6, then to TanStack Query / Zustand / function components (October 2026), most valuable first.
Check items off or delete them when done, add new ones with enough context for someone else to pick them up.

## Bugs / risks
- [ ] **Check the viewers on staging after the state migration**: images (OpenSeadragon/IIIF, auto-ROIs, crops), ToF point clouds, SLAM, flame graphs, bit-accuracy trees, the tuning forms. They now fetch files with TanStack Query and `fetch` instead of axios, and most were rewritten as function components. Unit tests cover their logic, not their rendering.
- [ ] **Old plotly figures**: plotly.js@3 dropped deprecated attributes. `src/components/PlotlyPlot.jsx` upgrades string titles and `titlefont`, but figures with other removed attributes (`bardir`, `annotation.ref`, `autotick`, `heatmapgl`/`pointcloud` traces...) may render differently. Extend `upgradeFigure` if users report it.
- [ ] **Node on SIRC GitLab runners** is 22.14 (`deployments/sirc/.envrc`), close to the minimum the toolchain supports (22.12). Move them to Node 24 LTS like Docker and GitHub Actions.
- [ ] Viewers not covered by automated tests with real data: images (OpenSeadragon/IIIF), ToF point clouds (three.js), SLAM, flame graphs, videos. Check them manually on staging after deploys that touch them.

## UX
- [ ] **Menus that open on hover**: all popovers use `<PopoverNext>` (Blueprint's `<Popover>` mis-positions content with React 19), and the commit, batch and run action menus open on click. Other menus still open on hover, so not on touch screens and sometimes by accident: the sidebar's Integrations and Milestones submenus, "Change" next to the commit id (`CommitNavbar.jsx`), the configuration tags' copy menus (`ConfigurationsTags` in `tags.jsx`), the image viewer's "Copy" menu and "View ROIs". Move them to click one at a time, checking that their contents still work (e.g. the integrations' search box).

## Testing / CI
- [ ] Run the Playwright smoke tests (`npm run e2e`) in GitLab CI too. They run in GitHub Actions; the LSF runners need Chromium (`npx playwright install chromium` through the proxy, or use `PLAYWRIGHT_CHROMIUM_EXECUTABLE`).
- [ ] Extend `e2e/smoke.spec.js` with realistic fixtures (batches, outputs, metrics) to cover the viewers and the tuning forms (Monaco).
- [ ] Bring down the last 23 oxlint warnings (`npm run lint`, see TODO_WARTS.md at the repo root), then make more rules errors.

## Architecture
- [ ] **Two class components are left**: `ImgViewer` (`src/viewers/images/images.jsx`, OpenSeadragon) and `TofOutputCard` (`src/viewers/tof/`, three.js). Convert them together with the OpenSeadragon/three.js upgrades below, when someone can check them visually.
- [ ] The React Compiler skips 5 components/hooks it can't compile yet (try/catch with optional chaining, `finally`, one internal error in `src/viewers/text.jsx`): `REACT_COMPILER_LOG=1 npm run build` lists them. Fine as is, revisit with newer compiler versions.
- [ ] `TuningForm` saves to localStorage (zustand `persist`) on every keystroke, including in Monaco. Debounce if it shows up in profiles.
- [ ] Routes keep our own matching (`src/router.jsx`): `/:project_id+/...` can't be expressed with react-router's or TanStack Router's patterns.
- [ ] New files in TypeScript (`.tsx`); `npm run typecheck` already runs in CI.
- [ ] styled-components is in maintenance mode: prefer CSS modules for new code. We keep v5 prop-forwarding behaviour via `StyleSheetManager` in `src/App.jsx`; using transient props (`$isExpanded`) would let us drop it.

## Dependencies left behind
- [ ] three.js 0.136 -> current: our copies of `OrbitControls`/`PCDLoader`/`PointerLockControls` (`src/viewers/tof/`) can come from `three/examples/jsm`. Colors change since r152 (color management), check point clouds visually.
- [ ] OpenSeadragon 3 -> 6: our plugins (`src/viewers/images/{selection,rgb,filtering,filters}.js`) need porting.
- [ ] d3-flame-graph 4 -> 5, react-full-screen -> Fullscreen API.
- [ ] plotly.js 4: wait for it to mature. It shows an "Upload to Cloud" button by default, disable it when upgrading.
