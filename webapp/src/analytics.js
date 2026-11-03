// Sentry and PostHog are optional: they are configured by the server (/api/v1/config),
// and only downloaded when used, in production.

let posthog = null;
let sentry = null;
let sentry_initialized = false;

// Product analytics events, ignored without PostHog
export const track = (event, properties) => posthog?.capture(event, properties);

// Whether errors are sent to Sentry: the error pages say so, and give their reference
export const reportsErrors = config => !!(import.meta.env.PROD && config?.sentry_dsn);

// Sentry's event ids: 32 hex characters. crypto.randomUUID only exists in secure contexts (QA-Board is also served over http)
const event_id = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');

// Errors caught by our error boundaries, ignored without Sentry. Those that happen while Sentry downloads, or before
// we know if the site uses it (e.g. pages that fail on their first render), are reported once it's ready.
// Returns the event's id: we choose it, so that error pages can show it right away, even before Sentry is ready.
// context: Sentry's scope data, e.g. { contexts: { react: { componentStack } }, tags }
let pending = [];
export const captureException = (error, context) => {
  const hint = { event_id: event_id(), captureContext: context };
  if (sentry) sentry.captureException(error, hint);
  else if (pending && pending.length < 10) pending.push([error, hint]);
  return hint.event_id;
};

// What users say they were doing when an error happened, attached to its event
export const captureFeedback = (message, associatedEventId) => {
  if (!sentry) return false;
  sentry.captureFeedback({ message, associatedEventId, url: window.location.href.replace(/([?&]token=)[^&#]*/g, '$1[Filtered]') });
  return true;
};

// Who is signed in: their username, like the backend's events (see backend/sentry.py). null when signed out.
const sentry_user = user => user?.is_logged && user.user_name ? { username: user.user_name } : null;
let current_user = null;
export const setUser = user => {
  current_user = sentry_user(user);
  sentry?.setUser(current_user);
};

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
  if (sentry_initialized) return;
  if (!import.meta.env.PROD || !config.sentry_dsn) {
    pending = null;
    return;
  }
  sentry_initialized = true;
  let client;
  try {
    client = await import('./sentry');
  } catch (error) {
    // e.g. a deploy replaced the bundle: errors stay in the console
    console.warn('Could not load Sentry', error);
    pending = null;
    return;
  }
  client.init(sentryOptions(config, routeName, client));
  client.setUser(current_user);
  sentry = client;
  pending?.forEach(([error, hint]) => client.captureException(error, hint));
  pending = null;
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
