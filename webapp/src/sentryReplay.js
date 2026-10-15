// Imported dynamically (see analytics.js), so that session replays get their own chunk, only downloaded when Sentry is used
// oxlint-disable-next-line import/named -- @sentry/react re-exports it from @sentry/browser, oxlint doesn't follow
export { replayIntegration } from "@sentry/react";
