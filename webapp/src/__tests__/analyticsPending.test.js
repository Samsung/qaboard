// Errors caught before Sentry is ready are reported once it is. In its own file: analytics.js remembers that
// Sentry was initialized, see analytics.test.js
import { vi, it, expect } from 'vitest';

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  addIntegration: vi.fn(),
  browserTracingIntegration: vi.fn(() => ({ name: 'BrowserTracing' })),
  replayIntegration: vi.fn(() => ({ name: 'Replay' })),
  captureException: vi.fn(),
}));
vi.mock('../sentry', () => sentry);
vi.mock('../sentryReplay', () => sentry);
import { captureException, initSentry } from '../analytics';

it('reports the errors caught while Sentry loads', async () => {
  vi.stubEnv('PROD', true);
  try {
    const error = new Error('boom');
    captureException(error, { contexts: { react: { componentStack: 'at Dashboard' } } });
    expect(sentry.captureException).not.toHaveBeenCalled();
    await initSentry({ sentry_dsn: 'https://key@sentry.example.com/1' }, () => '/');
    expect(sentry.captureException).toHaveBeenCalledWith(error, { contexts: { react: { componentStack: 'at Dashboard' } } });
    // then right away
    captureException(new Error('again'));
    expect(sentry.captureException).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllEnvs();
  }
});
