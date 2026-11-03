// Errors caught before Sentry is ready are reported once it is. In its own file: analytics.js remembers that
// Sentry was initialized, see analytics.test.js
import { vi, it, expect } from 'vitest';

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  addIntegration: vi.fn(),
  browserTracingIntegration: vi.fn(() => ({ name: 'BrowserTracing' })),
  replayIntegration: vi.fn(() => ({ name: 'Replay' })),
  captureException: vi.fn(),
  setUser: vi.fn(),
}));
vi.mock('../sentry', () => sentry);
vi.mock('../sentryReplay', () => sentry);
import { captureException, initSentry, setUser } from '../analytics';

it('reports the errors caught while Sentry loads', async () => {
  vi.stubEnv('PROD', true);
  try {
    const error = new Error('boom');
    // the error page shows its reference right away: the event gets it once Sentry is ready
    const id = captureException(error, { contexts: { react: { componentStack: 'at Dashboard' } } });
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    setUser({ is_logged: true, user_name: 'jdoe' });
    expect(sentry.captureException).not.toHaveBeenCalled();
    await initSentry({ sentry_dsn: 'https://key@sentry.example.com/1' }, () => '/');
    expect(sentry.setUser).toHaveBeenCalledWith({ username: 'jdoe' });
    expect(sentry.captureException).toHaveBeenCalledWith(error, { event_id: id, captureContext: { contexts: { react: { componentStack: 'at Dashboard' } } } });
    // then right away
    captureException(new Error('again'));
    expect(sentry.captureException).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllEnvs();
  }
});
