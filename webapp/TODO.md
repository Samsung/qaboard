# Webapp TODO

Follow-ups from the move to Vite 8 / React 19 / Blueprint 6 (October 2026), most valuable first.
Check items off or delete them when done, add new ones with enough context for someone else to pick them up.

## Bugs / risks
- [ ] **Plotly "Send to Cloud"**: `src/viewers/slam/SlamOutputCard.jsx` sets `showSendToCloud: true` with `plotlyServerURL: chart-studio.plotly.com`. Users can upload internal data to Plotly's public cloud. Turn it off unless someone needs it.
- [ ] **Old plotly figures**: plotly.js@3 dropped deprecated attributes. `src/components/PlotlyPlot.jsx` upgrades string titles and `titlefont`, but figures with other removed attributes (`bardir`, `annotation.ref`, `autotick`, `heatmapgl`/`pointcloud` traces...) may render differently. Extend `upgradeFigure` if users report it.
- [ ] **Node on SIRC GitLab runners** is 22.14 (`deployments/sirc/.envrc`), close to the minimum the toolchain supports (22.12). Move them to Node 24 LTS like Docker and GitHub Actions.
- [ ] Viewers not covered by automated tests with real data: images (OpenSeadragon/IIIF), ToF point clouds (three.js), SLAM, flame graphs, videos. Check them manually on staging after deploys that touch them.

## Testing / CI
- [ ] Run the Playwright smoke tests (`npm run e2e`) in GitLab CI too. They run in GitHub Actions; the LSF runners need Chromium (`npx playwright install chromium` through the proxy, or use `PLAYWRIGHT_CHROMIUM_EXECUTABLE`).
- [ ] Extend `e2e/smoke.spec.js` with realistic fixtures (batches, outputs, metrics) to cover the viewers and the tuning forms (Monaco).
- [ ] Bring down the ~300 oxlint warnings (`npm run lint`), mostly unused variables, then make more rules errors.

## Architecture
- [ ] **Server state**: move API data (projects, commits, batches) from Redux thunks + redux-persist to TanStack Query (or RTK Query): caching, request deduplication, background refresh, much less code.
- [ ] **Class components -> function components + hooks** (58 classes), starting with the leaves. Then enable the React Compiler (`babel-plugin-react-compiler` with `@vitejs/plugin-react`) for automatic memoization.
- [ ] Use hooks instead of `withRouter` in function components: add `useRouteMatch()` helpers in `src/router.jsx`. Routes keep our own matching: `/:project_id+/...` can't be expressed with react-router's patterns.
- [ ] Redux store: `createStore` is deprecated, use `configureStore` from Redux Toolkit (dev checks for mutations and non-serializable state).
- [ ] New files in TypeScript (`.tsx`); `npm run typecheck` already runs in CI.
- [ ] styled-components is in maintenance mode: prefer CSS modules for new code. We keep v5 prop-forwarding behaviour via `StyleSheetManager` in `src/App.jsx`; using transient props (`$isExpanded`) would let us drop it.

## Dependencies left behind
- [ ] three.js 0.136 -> current: our copies of `OrbitControls`/`PCDLoader`/`PointerLockControls` (`src/viewers/tof/`) can come from `three/examples/jsm`. Colors change since r152 (color management), check point clouds visually.
- [ ] OpenSeadragon 3 -> 6: our plugins (`src/viewers/images/{selection,rgb,filtering,filters}.js`) need porting.
- [ ] d3-flame-graph 4 -> 5, react-copy-to-clipboard -> `navigator.clipboard`, react-full-screen -> Fullscreen API.
- [ ] plotly.js 4: wait for it to mature. It shows an "Upload to Cloud" button by default, disable it when upgrading.
