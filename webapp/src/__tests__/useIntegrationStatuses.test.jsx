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


describe('Webhooks, links and GitLab CI jobs', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  // the server only calls the hosts of the integrations of the project's qaboard.yaml, and the commit's
  test('say which project and commit they are from', async () => {
    const webhook = { text: 'Bench', webhook: { url: 'https://bench.example.com/jobs', method: 'POST', json: { commit: 'abc123' } } };
    const link = { text: 'Docs', href: 'https://docs.example.com/camera' };
    const fetchMock = vi.fn().mockImplementation(async () => json({ status: 'pending' }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useIntegrationStatuses({ ...context, integrations: [webhook, link] }));

    act(() => result.current.triggerIntegration(webhook)());
    await waitFor(() => expect(result.current.integrationStatuses.Bench?.loading).toBe(false));
    act(() => result.current.startUpdateIntegrationStatuses());
    await waitFor(() => expect(result.current.integrationStatuses.Docs?.is_loaded).toBe(true));
    result.current.stopUpdateIntegrationStatuses();
    const [sent, checked] = requests(fetchMock);
    expect(sent.url).toBe('/api/v1/webhook/proxy/?project=org%2Frepo%2Fsub&commit=abc123');
    expect(sent.body).toEqual(webhook.webhook);
    expect(checked.url).toBe('/api/v1/webhook/proxy/?project=org%2Frepo%2Fsub&commit=abc123');
    expect(checked.body).toEqual({ method: 'HEAD', url: 'https://docs.example.com/camera' });
  });

  test('links to our own pages are checked directly', async () => {
    const link = { text: 'Report', href: '/s/mnt/qaboard/report.html' };
    const fetchMock = vi.fn().mockImplementation(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useIntegrationStatuses({ ...context, integrations: [link] }));
    act(() => result.current.startUpdateIntegrationStatuses());
    await waitFor(() => expect(result.current.integrationStatuses.Report?.is_loaded).toBe(true));
    result.current.stopUpdateIntegrationStatuses();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${window.location.origin}/s/mnt/qaboard/report.html`);
    expect(options.method).toBe('HEAD');
  });

  test('GitLab CI jobs say their project', async () => {
    const job = { text: 'Deploy', gitlabCI: { job_name: 'deploy' } };
    const gitlab_context = { ...context, project: 'group/repo', project_data: { data: { git: { path_with_namespace: 'group/repo' } } }, integrations: [job] };
    const fetchMock = vi.fn().mockImplementation(async () => json({ id: 3, status: 'pending' }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useIntegrationStatuses(gitlab_context));
    act(() => result.current.triggerIntegration(job)());
    await waitFor(() => expect(result.current.integrationStatuses.Deploy?.loading).toBe(false));
    const [played] = requests(fetchMock);
    expect(played.url).toMatch(/\/api\/v1\/gitlab\/job\/play\/$/);
    expect(played.body).toMatchObject({ project: 'group/repo', project_id: 'group/repo', commit_id: 'abc123', job_name: 'deploy' });
  });
});
