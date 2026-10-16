// Sentry and PostHog are optional: they are configured by the server (/api/v1/config),
// and only downloaded when used, in production.

let posthog = null;
let sentry = null;
let sentry_initialized = false;

// Product analytics events, ignored without PostHog
export const track = (event, properties) => posthog?.capture(event, properties);

// Errors caught by our error boundary, ignored without Sentry
export const captureException = (error, hint) => sentry?.captureException(error, hint);

// Requests to our API (same origin) carry the trace headers, so the backend's traces continue the web app's
export const tracePropagationTargets = [/^\/api\//];

// The options of Sentry.init. routeName: pathname => the route's pattern, to group transactions, e.g. /:project_id+/commit/:name+
export const sentryOptions = (config, routeName, { browserTracingIntegration }) => ({
  dsn: config.sentry_dsn,
  // The version of the image, set when building it (see vite.config.js)
  release: import.meta.env.QABOARD_RELEASE || undefined,
  environment: config.sentry_environment ?? 'production',
  integrations: [
    // Page loads and navigations, with the web vitals (LCP, CLS, INP), and the API calls they make
    browserTracingIntegration({
      beforeStartSpan: options => ({ ...options, name: routeName(window.location.pathname) }),
    }),
  ],
  tracesSampleRate: config.sentry_traces_sample_rate ?? 0.2,
  tracePropagationTargets,
  // 'static' sends transactions, that all Sentry servers understand. 'stream' needs a recent server.
  traceLifecycle: config.sentry_trace_lifecycle === 'stream' ? 'stream' : 'static',
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
});

export async function initSentry(config, routeName) {
  if (!import.meta.env.PROD || !config.sentry_dsn || sentry_initialized) return;
  sentry_initialized = true;
  const client = await import('./sentry');
  client.init(sentryOptions(config, routeName, client));
  sentry = client;
  // Session replays are heavy, we download them after the rest
  const { replayIntegration } = await import('./sentryReplay');
  client.addIntegration(replayIntegration());
}

export async function initPostHog(config) {
  if (!import.meta.env.PROD || !config.posthog_api_key || posthog) return;
  const { default: client } = await import('posthog-js');
  client.init(config.posthog_api_key, { api_host: config.posthog_host || undefined });
  posthog = client;
}
