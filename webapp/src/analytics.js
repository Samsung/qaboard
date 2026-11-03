// Sentry and PostHog are optional: they are configured by the server (/api/v1/config),
// and only downloaded when used, in production. Usage events also go to QA-Board's own server (initUsage).

let posthog = null;
let sentry = null;
let sentry_initialized = false;

// Product analytics events: to QA-Board's usage events (with the project they're about), and to PostHog when the
// site uses it. `client_time`: when it happened, by default now.
export const track = (event, properties = {}, { project_id, client_time } = {}) => {
  posthog?.capture(event, project_id ? { ...properties, project_id } : properties);
  queueUsage(event, properties, { project_id, client_time });
};

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

// Usage events, kept by QA-Board's own server (docs/design/usage-analytics.md): who looks at what, and what they
// start. They are batched and sent in the background: the app never waits for them, and a failed send is dropped.
// `track()` feeds this queue once `initUsage(config)` enabled it, and PostHog when the site uses it.
const USAGE_URL = '/api/v1/events';
const FLUSH_EVERY_MS = 10 * 1000;
const FLUSH_AT = 20;
// the server refuses bigger requests: what's left waits for the next flush
const MAX_PER_REQUEST = 100;

// Until initUsage() says whether the server records events, we keep them (bounded): the first page view and the
// release notes popup happen before the site's configuration is known.
const MAX_PENDING = 50;
let usage_state = 'unknown'; // unknown | on | off
let usage_pending = [];
let usage_queue = [];
let usage_timer = null;
let usage_listening = false;

// The browser's random id, to count distinct anonymous browsers. Storage can be missing or throw (private windows...)
const CLIENT_ID_KEY = 'qaboard:client_id';
let client_id = null;
const clientId = () => {
  if (client_id) return client_id;
  try {
    client_id = localStorage.getItem(CLIENT_ID_KEY);
    if (!client_id) {
      client_id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(CLIENT_ID_KEY, client_id);
    }
  } catch {
    client_id = client_id ?? 'unknown';
  }
  return client_id;
};

const sendUsage = (events, { beacon = false } = {}) => {
  const body = JSON.stringify({ source: 'webapp', events });
  try {
    // when the page hides, fetch calls can be cancelled: sendBeacon isn't. As text/plain, it needs no preflight.
    if (beacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      if (navigator.sendBeacon(USAGE_URL, new Blob([body], { type: 'text/plain' }))) return;
    }
    fetch(USAGE_URL, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(error => console.debug('Usage events not sent', error));
  } catch (error) {
    console.debug('Usage events not sent', error);
  }
};

// Sends what's queued, now. `beacon`: the page is going away
export const flushUsage = ({ beacon = false } = {}) => {
  if (usage_timer) {
    clearTimeout(usage_timer);
    usage_timer = null;
  }
  while (usage_queue.length > 0) {
    const events = usage_queue.splice(0, MAX_PER_REQUEST);
    sendUsage(events, { beacon });
  }
};

const onHide = () => {
  if (document.visibilityState === 'hidden') flushUsage({ beacon: true });
};
const onPageHide = () => flushUsage({ beacon: true });

const enqueue = event => {
  usage_queue.push(event);
  if (usage_queue.length >= FLUSH_AT) flushUsage();
  else if (!usage_timer) usage_timer = setTimeout(() => flushUsage(), FLUSH_EVERY_MS);
};

const queueUsage = (event, properties, { project_id, client_time } = {}) => {
  if (usage_state === 'off') return;
  const row = {
    event,
    properties: properties ?? {},
    project_id: project_id ?? undefined,
    client_id: clientId(),
    timestamp: (client_time ?? new Date()).toISOString(),
  };
  if (usage_state === 'unknown') {
    if (usage_pending.length < MAX_PENDING) usage_pending.push(row);
    return;
  }
  enqueue(row);
};

// Starts sending usage events, with those kept while we didn't know, unless the server turned them off (analytics.enabled)
export const initUsage = config => {
  if (!config || config.analytics_enabled === false) {
    usage_state = 'off';
    usage_pending = [];
    return;
  }
  usage_state = 'on';
  const pending = usage_pending;
  usage_pending = [];
  pending.forEach(enqueue);
  if (usage_listening || typeof document === 'undefined') return;
  usage_listening = true;
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);
};

export const _resetUsageForTests = () => {
  if (usage_timer) clearTimeout(usage_timer);
  usage_timer = null;
  usage_queue = [];
  usage_pending = [];
  usage_state = 'unknown';
  client_id = null;
  if (usage_listening && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onPageHide);
  }
  usage_listening = false;
};
export const _usageQueueForTests = () => usage_queue;
