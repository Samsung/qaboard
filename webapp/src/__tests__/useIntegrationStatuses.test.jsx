/**
 * Integrations started from the web app, e.g. GitHub Actions workflows.
 * Run with: cd webapp && npm test -- useIntegrationStatuses
 */
import { act, renderHook, waitFor } from '@testing-library/react';

import { useIntegrationStatuses } from '../useIntegrationStatuses';


const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const requests = fetchMock => fetchMock.mock.calls.map(([url, options]) => ({ url, body: JSON.parse(options.body) }));

const integration = { text: 'Benchmarks', githubActions: { workflow: 'bench.yml', inputs: { size: 'big' } } };
const context = {
  project: 'org/repo/sub',
  project_data: { data: { git: { hosting_type: 'github', host: 'https://github.com', web_url: 'https://github.com/org/repo', path_with_namespace: 'org/repo' } } },
  commit: { id: 'abc123', branch: 'origin/feature/x' },
  integrations: [integration],
};


describe('GitHub Actions', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  test("starts the project's workflow, then follows the run it started", async () => {
    const fetchMock = vi.fn()
      // the server didn't see the run yet
      .mockResolvedValueOnce(json({ status: 'pending', dispatched_at: '2026-10-06T12:00:00Z' }))
      .mockResolvedValue(json({ status: 'running', id: 42 }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useIntegrationStatuses(context));

    act(() => result.current.triggerIntegration(integration)());
    await waitFor(() => expect(result.current.integrationStatuses.Benchmarks?.loading).toBe(false));
    const [dispatch] = requests(fetchMock);
    expect(dispatch.url).toMatch(/\/api\/v1\/github\/workflow\/dispatch\/$/);
    // the server checks users can access the project, and that the workflow is in its qaboard.yaml
    expect(dispatch.body).toMatchObject({ project: 'org/repo/sub', host: 'https://github.com', repo: 'org/repo', ref: 'feature/x', workflow: 'bench.yml', inputs: { size: 'big' } });

    act(() => result.current.startUpdateIntegrationStatuses());
    await waitFor(() => expect(result.current.integrationStatuses.Benchmarks?.data?.id).toBe(42));
    result.current.stopUpdateIntegrationStatuses();
    const [, status] = requests(fetchMock);
    expect(status.url).toMatch(/\/api\/v1\/github\/workflow\/$/);
    expect(status.body).toMatchObject({ project: 'org/repo/sub', repo: 'org/repo', commit_id: 'abc123', workflow: 'bench.yml', dispatched_at: '2026-10-06T12:00:00Z' });
  });
});
