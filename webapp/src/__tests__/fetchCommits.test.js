/**
 * The commits endpoint aggregates the metrics we ask for (per batch: median, average), e.g. for the chart above a
 * branch's commits. A branch's metrics are its latest commit's, which may differ from what we asked for first.
 * Run with: cd webapp && npm test -- fetchCommits
 */
import { createElement } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { unstable_HistoryRouter as HistoryRouter, useLocation } from 'react-router';

import { ComparisonProvider, useCommitsList, aggregation_metrics } from '../hooks';
import { normalize_commit } from '../api/normalize';
import { history, matchRoutes, RouteMatch } from '../router';
import { routes } from '../routes';
import { makeQueryClient } from '../test-utils';

const qatools_metrics = {
  default_metric: 'latency_p99',
  main_metrics: ['latency_p99', 'throughput', 'unknown'],
  available_metrics: { latency_p99: { target: 12 }, throughput: {}, slo_miss: { target: 0.01 } },
};
const commit = { id: 'c2534437', branch: 'main', authored_datetime: '2026-10-01T10:00:00Z', batches: {}, data: { qatools_metrics } };


describe('aggregation_metrics', () => {
  it("gives the default and main metrics' targets", () => {
    expect(aggregation_metrics(qatools_metrics)).toEqual({ latency_p99: 12, throughput: 0 });
    expect(aggregation_metrics(undefined)).toEqual({});
    expect(aggregation_metrics({ main_metrics: ['psnr'] })).toEqual({});
    // the default metric, even if it's not a main metric
    expect(aggregation_metrics({ default_metric: 'slo_miss', available_metrics: qatools_metrics.available_metrics })).toEqual({ slo_miss: 0.01 });
  });

  it("gives History's metrics", () => {
    const metrics = { ...qatools_metrics, dashboard_metrics: ['slo_miss', 'throughput'] };
    expect(aggregation_metrics(metrics, { dashboard: true })).toEqual({ slo_miss: 0.01, throughput: 0 });
    expect(aggregation_metrics(qatools_metrics, { dashboard: true })).toEqual({ latency_p99: 12, throughput: 0 });
  });
});


const List = () => {
  const { isSuccess } = useCommitsList();
  return createElement('span', null, isSuccess ? 'loaded' : 'loading');
};

const Page = () => {
  const { pathname } = useLocation();
  const { match } = matchRoutes(routes, pathname);
  return createElement(RouteMatch, { match }, createElement(ComparisonProvider, null, createElement(List)));
};

// Opens the page, answers with the project's metrics, then with each list of commits in turn (the last one repeats).
// Returns the metrics of the requests for commits once they're all answered.
const run = async (pathname, { project_metrics, answers }) => {
  const requests = [];
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/v1/project')
      return new Response(JSON.stringify(project_metrics ? { qatools_metrics: project_metrics } : {}));
    if (url.pathname.startsWith('/api/v1/commits/')) {
      requests.push({ pathname: url.pathname, metrics: JSON.parse(url.searchParams.get('metrics')) });
      return new Response(JSON.stringify(answers[Math.min(requests.length, answers.length) - 1]));
    }
    return new Response('{}');
  }));
  act(() => history.replace(pathname));
  render(createElement(QueryClientProvider, { client: makeQueryClient() }, createElement(HistoryRouter, { history }, createElement(Page))));
  await waitFor(() => expect(requests.length).toBeGreaterThan(0));
  // nothing else comes
  await new Promise(resolve => setTimeout(resolve, 50));
  return requests;
};

afterEach(() => vi.unstubAllGlobals());


describe("the list of commits", () => {
  it("asks once more with the branch's metrics when they weren't known", async () => {
    const requests = await run('/kitefin/inference-gateway/commits/main', { answers: [[commit]] });
    expect(requests.map(r => r.metrics)).toEqual([{}, { latency_p99: 12, throughput: 0 }]);
    expect(requests[0].pathname).toBe('/api/v1/commits/main');
  });

  it('asks once when we already asked for them', async () => {
    const requests = await run('/kitefin/inference-gateway/commits/main', { project_metrics: qatools_metrics, answers: [[commit]] });
    expect(requests.map(r => r.metrics)).toEqual([{ latency_p99: 12, throughput: 0 }]);
  });

  it('asks once more only, even if the metrics keep changing', async () => {
    const slo_miss_only = { main_metrics: ['slo_miss'], available_metrics: qatools_metrics.available_metrics };
    const requests = await run('/kitefin/inference-gateway/commits/main', {
      project_metrics: slo_miss_only,
      answers: [[commit], [{ ...commit, data: { qatools_metrics: slo_miss_only } }]],
    });
    expect(requests.map(r => r.metrics)).toEqual([{ slo_miss: 0.01 }, { latency_p99: 12, throughput: 0 }]);
  });

  it("doesn't ask again for a committer's commits", async () => {
    const requests = await run('/kitefin/inference-gateway/committer/mira', { answers: [[commit]] });
    expect(requests.map(r => r.metrics)).toEqual([{}]);
  });

  it("doesn't ask again without commits", async () => {
    const requests = await run('/kitefin/inference-gateway/commits/main', { answers: [[]] });
    expect(requests.map(r => r.metrics)).toEqual([{}]);
  });

  it("on History, asks once for History's metrics: it loads every run", async () => {
    const requests = await run('/kitefin/inference-gateway/history/main', {
      project_metrics: { ...qatools_metrics, dashboard_metrics: ['slo_miss'] },
      answers: [[{ ...commit, data: { qatools_metrics: { ...qatools_metrics, dashboard_metrics: ['throughput'] } } }]],
    });
    expect(requests.map(r => r.metrics)).toEqual([{ slo_miss: 0.01 }]);
  });
});


describe('normalize_commit', () => {
  it("fills the defaults of the commits' metrics, which the branch's chart reads", () => {
    const { available_metrics } = normalize_commit(structuredClone(commit)).data.qatools_metrics;
    expect(available_metrics.latency_p99.key).toBe('latency_p99');
    expect(available_metrics.throughput.label).toBe('throughput');
  });
});
