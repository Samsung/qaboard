import { vi, describe, it, expect, beforeEach } from 'vitest';

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  addIntegration: vi.fn(),
  browserTracingIntegration: vi.fn(options => ({ name: 'BrowserTracing', options })),
  replayIntegration: vi.fn(() => ({ name: 'Replay' })),
}));
vi.mock('@sentry/react', () => sentry);

const config = {
  sentry_dsn: 'https://key@sentry.example.com/1',
  sentry_environment: 'staging',
  sentry_traces_sample_rate: 0.5,
};
const routeName = () => '/:project_id+/commit/:name+';

describe('sentryOptions', () => {
  it('uses the server configuration', async () => {
    const { sentryOptions } = await import('../analytics');
    const options = sentryOptions(config, routeName);
    expect(options.dsn).toBe(config.sentry_dsn);
    expect(options.environment).toBe('staging');
    expect(options.tracesSampleRate).toBe(0.5);
    // transactions, that all Sentry servers understand
    expect(options.traceLifecycle).toBe('static');
    expect(sentryOptions({ ...config, sentry_trace_lifecycle: 'stream' }, routeName).traceLifecycle).toBe('stream');
  });

  it('has defaults', async () => {
    const { sentryOptions } = await import('../analytics');
    const options = sentryOptions({ sentry_dsn: config.sentry_dsn }, routeName);
    expect(options.environment).toBe('production');
    expect(options.tracesSampleRate).toBe(0.2);
    // set when building the image
    expect(options.release).toBeUndefined();
  });

  it('propagates traces to our API only', async () => {
    const { tracePropagationTargets } = await import('../analytics');
    const matches = url => tracePropagationTargets.some(target => target.test(url));
    expect(matches('/api/v1/commit/abc')).toBe(true);
    expect(matches('/s/some/file.txt')).toBe(false);
    expect(matches('https://gitlab.example.com/api/v4/projects')).toBe(false);
  });

  it('names transactions after routes', async () => {
    const { sentryOptions } = await import('../analytics');
    const [tracing] = sentryOptions(config, routeName).integrations;
    expect(tracing.options.beforeStartSpan({ name: '/a/b/commit/123', op: 'pageload' }))
      .toEqual({ name: '/:project_id+/commit/:name+', op: 'pageload' });
  });
});

describe('initSentry', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.values(sentry).forEach(fn => fn.mockClear());
  });

  it('does nothing in development', async () => {
    const { initSentry } = await import('../analytics');
    await initSentry(config, routeName);
    expect(sentry.init).not.toHaveBeenCalled();
  });

  it('initializes once in production, with replays', async () => {
    vi.stubEnv('PROD', true);
    try {
      const { initSentry } = await import('../analytics');
      await initSentry({ ...config, sentry_dsn: null }, routeName);
      expect(sentry.init).not.toHaveBeenCalled();
      await initSentry(config, routeName);
      await initSentry(config, routeName);
      expect(sentry.init).toHaveBeenCalledTimes(1);
      expect(sentry.init.mock.calls[0][0].dsn).toBe(config.sentry_dsn);
      expect(sentry.addIntegration).toHaveBeenCalledWith({ name: 'Replay' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
