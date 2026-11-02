// The parts of Sentry we use. analytics.js imports this module dynamically, when the server configures Sentry:
// it's ~150kB that other sites don't download. Session replays are in their own chunk, see sentryReplay.js
// oxlint-disable-next-line import/named -- @sentry/react re-exports them from @sentry/browser, oxlint doesn't follow
export { init, addIntegration, browserTracingIntegration, captureException } from "@sentry/react";
