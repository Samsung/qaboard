/**
 * The commits endpoint aggregates the metrics we ask for (per batch: median, average), e.g. for the chart above a
 * branch's commits. A branch's metrics are its latest commit's, which may differ from what we asked for first.
 * Run with: cd webapp && npm test -- fetchCommits
 */
import axios from 'axios';

import { fetchCommits, aggregation_metrics } from '../actions/projects';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

const qatools_metrics = {
  default_metric: 'latency_p99',
  main_metrics: ['latency_p99', 'throughput', 'unknown'],
  available_metrics: { latency_p99: { target: 12 }, throughput: {}, slo_miss: { target: 0.01 } },
};
const commit = { id: 'c2534437', batches: {}, data: { qatools_metrics } };
const date_range = ['2026-10-01', '2026-10-08'];


// Runs the thunk and the thunks it dispatches, returns the requests' metrics once they're all answered
const run = async (thunk, expected_requests) => {
  const actions = [];
  const dispatch = action => typeof action === 'function' ? action(dispatch) : actions.push(action);
  dispatch(thunk);
  await vi.waitFor(() => expect(actions.filter(a => a.type === 'UPDATE_COMMITS')).toHaveLength(expected_requests));
  // nothing else comes
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(axios.get).toHaveBeenCalledTimes(expected_requests);
  return axios.get.mock.calls.map(([, { params }]) => JSON.parse(params.metrics));
};


describe('aggregation_metrics', () => {
  it("gives the main metrics' targets", () => {
    expect(aggregation_metrics(qatools_metrics)).toEqual({ latency_p99: 12, throughput: 0 });
    expect(aggregation_metrics(undefined)).toEqual({});
    expect(aggregation_metrics({ main_metrics: ['psnr'] })).toEqual({});
    // the default metric, even if it's not a main metric
    expect(aggregation_metrics({ default_metric: 'slo_miss', available_metrics: qatools_metrics.available_metrics })).toEqual({ slo_miss: 0.01 });
  });
});


describe('fetchCommits', () => {
  beforeEach(() => {
    axios.get.mockReset();
    axios.get.mockResolvedValue({ data: [commit] });
  });

  it("asks once more with the branch's metrics when they weren't known", async () => {
    const requests = await run(fetchCommits('kitefin/inference-gateway', { name: 'main' }, date_range, {}), 2);
    expect(requests).toEqual([{}, { latency_p99: 12, throughput: 0 }]);
  });

  it('asks once when we already asked for them', async () => {
    const requests = await run(fetchCommits('kitefin/inference-gateway', { name: 'main' }, date_range, { throughput: 0, latency_p99: 12 }), 1);
    expect(requests).toEqual([{ throughput: 0, latency_p99: 12 }]);
  });

  it('asks once more only, even if the metrics keep changing', async () => {
    axios.get
      .mockResolvedValueOnce({ data: [commit] })
      .mockResolvedValueOnce({ data: [{ ...commit, data: { qatools_metrics: { main_metrics: ['slo_miss'], available_metrics: qatools_metrics.available_metrics } } }] });
    const requests = await run(fetchCommits('kitefin/inference-gateway', { name: 'main' }, date_range, { slo_miss: 0.01 }), 2);
    expect(requests).toEqual([{ slo_miss: 0.01 }, { latency_p99: 12, throughput: 0 }]);
  });

  it("doesn't ask again for a committer's commits, or without commits", async () => {
    expect(await run(fetchCommits('kitefin/inference-gateway', { committer: 'mira' }, date_range, {}), 1)).toEqual([{}]);
    axios.get.mockReset();
    axios.get.mockResolvedValue({ data: [] });
    expect(await run(fetchCommits('kitefin/inference-gateway', { name: 'main' }, date_range, {}), 1)).toEqual([{}]);
  });
});


describe('the commits reducer', () => {
  it("fills the defaults of the commits' metrics, which the branch's chart reads", async () => {
    const { rootReducer } = await import('../reducers');
    const state = rootReducer({ projects: { data: { 'kitefin/inference-gateway': { commits: {} } } } }, {
      type: 'UPDATE_COMMITS', project: 'kitefin/inference-gateway', branch: { name: 'main' },
      commits: [structuredClone(commit)],
    });
    const { available_metrics } = state.commits['kitefin/inference-gateway'].c2534437.data.qatools_metrics;
    expect(available_metrics.latency_p99.key).toBe('latency_p99');
    expect(available_metrics.throughput.label).toBe('throughput');
  });
});
