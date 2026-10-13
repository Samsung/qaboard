/**
 * A project's metrics come from GET /api/v1/project (the list of projects leaves them out): History's
 * "Performance over time" and the branches' charts need them.
 * Run with: cd webapp && npm test -- fetchProject
 */
import axios from 'axios';

import { fetchProject } from '../actions/projects';
import { updateSelected } from '../actions/selected';
import { projects } from '../reducers/projects';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));


describe('fetchProject', () => {
  it("stores the project's data, metrics included, under its id", async () => {
    axios.get.mockResolvedValue({
      data: {
        git: { path_with_namespace: 'kitefin/camera-isp' },
        qatools_metrics: { default_metric: 'psnr', main_metrics: ['psnr'], available_metrics: { psnr: { label: 'PSNR' } } },
      },
    });
    const actions = [];
    fetchProject('kitefin/camera-isp')(action => actions.push(action));
    await vi.waitFor(() => expect(actions).toHaveLength(2));
    expect(axios.get).toHaveBeenCalledWith('/api/v1/project?project=kitefin/camera-isp');

    // what the list of projects gave before
    let state = projects({ data: { 'kitefin/camera-isp': { data: { git: { path_with_namespace: 'kitefin/camera-isp' } } } } }, {});
    for (const action of actions)
      state = projects(state, action);
    const { data } = state.data['kitefin/camera-isp'];
    expect(data.qatools_metrics.default_metric).toBe('psnr');
    expect(data.qatools_metrics.main_metrics).toEqual(['psnr']);
    expect(data.git.path_with_namespace).toBe('kitefin/camera-isp');
    expect(state.data.project).toBeUndefined();
  });
});


describe('the projects reducer', () => {
  const full = { qatools_config: { project: { name: 'kitefin/camera-isp' }, outputs: { visualizations: [{ path: 'out.png' }] } } };
  const listed = { qatools_config: { project: { name: 'kitefin/camera-isp' } } };
  const update = (state, data) => projects(state, { type: 'UPDATE_PROJECTS', projects: { 'kitefin/camera-isp': { data } } });

  it("keeps the project's whole configuration when the list of projects answers last", () => {
    const state = update(update({ data: {} }, full), listed);
    expect(state.data['kitefin/camera-isp'].data.qatools_config.outputs.visualizations).toHaveLength(1);
  });

  it('takes the whole configuration when it answers last', () => {
    const state = update(update({ data: {} }, listed), full);
    expect(state.data['kitefin/camera-isp'].data.qatools_config.outputs.visualizations).toHaveLength(1);
  });
});


describe('updateSelected', () => {
  const thunks = (project, selected_project) => {
    const dispatched = [];
    updateSelected(project, { filter_batch_new: 'low-light' })(action => dispatched.push(action), () => ({ selected: { project: selected_project } }));
    return dispatched.filter(action => typeof action === 'function');
  };

  it('fetches the project when another one is selected', () => {
    expect(thunks('kitefin/camera-isp', 'kitefin/inference-gateway')).toHaveLength(1);
  });

  it("doesn't fetch it again for the same project", () => {
    expect(thunks('kitefin/camera-isp', 'kitefin/camera-isp')).toHaveLength(0);
  });
});
