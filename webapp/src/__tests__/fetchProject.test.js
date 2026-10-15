/**
 * A project's metrics come from GET /api/v1/project (the list of projects leaves them out): History's
 * "Performance over time" and the branches' charts need them.
 * Run with: cd webapp && npm test -- fetchProject
 */
import { createElement } from 'react';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { unstable_HistoryRouter as HistoryRouter, useLocation } from 'react-router';

import { useProjectData, useSelected } from '../hooks';
import { projectsQuery, projectQuery } from '../api/queries';
import { normalize_projects } from '../api/normalize';
import { history, matchRoutes, RouteMatch } from '../router';
import { routes } from '../routes';
import { makeQueryClient } from '../test-utils';

const wrapper = queryClient => ({ children }) => createElement(QueryClientProvider, { client: queryClient }, children);

const project_requests = () => fetch.mock.calls
  .map(([input]) => new URL(input, 'http://localhost'))
  .filter(url => url.pathname === '/api/v1/project')
  .map(url => url.searchParams.get('project'));

afterEach(() => vi.unstubAllGlobals());


describe('useProjectData', () => {
  it("gives the project's data, metrics included", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      git: { path_with_namespace: 'kitefin/camera-isp' },
      qatools_metrics: { default_metric: 'psnr', main_metrics: ['psnr'], available_metrics: { psnr: { label: 'PSNR' } } },
    }))));
    const queryClient = makeQueryClient();
    // what the list of projects gave before
    queryClient.setQueryData(projectsQuery.queryKey, normalize_projects({
      'kitefin/camera-isp': { latest_commit_datetime: '2026-10-08T14:10:00Z', data: { git: { path_with_namespace: 'kitefin/camera-isp' } } },
    }));
    const { result } = renderHook(() => useProjectData('kitefin/camera-isp'), { wrapper: wrapper(queryClient) });
    await waitFor(() => expect(result.current.data.qatools_metrics.default_metric).toBe('psnr'));
    expect(project_requests()).toEqual(['kitefin/camera-isp']);
    const { data } = result.current;
    expect(data.qatools_metrics.main_metrics).toEqual(['psnr']);
    expect(data.git.path_with_namespace).toBe('kitefin/camera-isp');
    // and what only the list has
    expect(result.current.latest_commit_datetime).toBe('2026-10-08T14:10:00Z');
  });

  const full = { qatools_config: { project: { name: 'kitefin/camera-isp' }, outputs: { visualizations: [{ path: 'out.png' }] } } };
  const listed = { qatools_config: { project: { name: 'kitefin/camera-isp' } } };
  const projectData = (queryClient, answers) => {
    for (const [query, data] of answers)
      queryClient.setQueryData(query.queryKey, query === projectsQuery ? normalize_projects({ 'kitefin/camera-isp': { data } }) : { data });
    return renderHook(() => useProjectData('kitefin/camera-isp'), { wrapper: wrapper(queryClient) }).result.current;
  };

  it("keeps the project's whole configuration when the list of projects answers last", () => {
    const data = projectData(makeQueryClient(), [[projectQuery('kitefin/camera-isp'), full], [projectsQuery, listed]]);
    expect(data.data.qatools_config.outputs.visualizations).toHaveLength(1);
  });

  it('takes the whole configuration when it answers last', () => {
    const data = projectData(makeQueryClient(), [[projectsQuery, listed], [projectQuery('kitefin/camera-isp'), full]]);
    expect(data.data.qatools_config.outputs.visualizations).toHaveLength(1);
  });
});


describe('selecting a project', () => {
  const Project = () => {
    const { project } = useSelected();
    const { data } = useProjectData(project);
    return createElement('span', null, data.qatools_metrics.default_metric ?? 'loading');
  };
  const Page = () => {
    const { match } = matchRoutes(routes, useLocation().pathname);
    return createElement(RouteMatch, { match }, createElement(Project));
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async input => {
      const project = new URL(input, 'http://localhost').searchParams.get('project');
      const default_metric = project === 'kitefin/camera-isp' ? 'psnr' : 'latency_p99';
      return new Response(JSON.stringify({ qatools_metrics: { default_metric, main_metrics: [], available_metrics: {} } }));
    }));
  });

  it('fetches the project when another one is selected, not again for the same project', async () => {
    act(() => history.replace('/kitefin/inference-gateway/commits'));
    render(createElement(QueryClientProvider, { client: makeQueryClient() }, createElement(HistoryRouter, { history }, createElement(Page))));
    await screen.findByText('latency_p99');
    act(() => history.push('/kitefin/camera-isp/commits?filter=low-light'));
    await screen.findByText('psnr');
    act(() => history.push('/kitefin/camera-isp/history'));
    await screen.findByText('psnr');
    expect(project_requests()).toEqual(['kitefin/inference-gateway', 'kitefin/camera-isp']);
  });
});
