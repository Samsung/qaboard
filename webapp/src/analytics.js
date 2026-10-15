// Sentry and PostHog are optional: they are configured by the server (/api/v1/config),
// and only downloaded when used, in production.
import * as Sentry from "@sentry/react";


let posthog = null;
let sentry_initialized = false;

// Product analytics events, ignored without PostHog
export const track = (event, properties) => posthog?.capture(event, properties);

// routeName: pathname => the route's pattern, to group transactions, e.g. /:project_id+/commit/:name+
export async function initSentry(config, routeName) {
  if (!import.meta.env.PROD || !config.sentry_dsn || sentry_initialized) return;
  sentry_initialized = true;
  Sentry.init({
    dsn: config.sentry_dsn,
    integrations: [
      Sentry.browserTracingIntegration({
        beforeStartSpan: options => ({ ...options, name: routeName(window.location.pathname) }),
      }),
    ],
    tracesSampleRate: config.sentry_traces_sample_rate ?? 1.0,
    tracePropagationTargets: [/\/api\//],
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
  });
  // Session replays are heavy, only download them when Sentry is used
  const { replayIntegration } = await import('@sentry/replay');
  Sentry.addIntegration(replayIntegration());
}

export async function initPostHog(config) {
  if (!import.meta.env.PROD || !config.posthog_api_key || posthog) return;
  const { default: client } = await import('posthog-js');
  client.init(config.posthog_api_key, { api_host: config.posthog_host || undefined });
  posthog = client;
}
