import { createSelector } from 'reselect'

import { filter_batch, matching_output } from "../utils";
import {
	default_project,
	default_selected,
	default_commits_data,
	empty_batch,
} from "../defaults"


// const locationSelector = (_state, props) => props.location;

export const projectSelector = state => state.selected.project
export const projectsSelector = state => state.projects.data
export const projectDataSelector = createSelector([projectSelector, projectsSelector], (project, projects) => {
   return projects[project] || default_project;
})


export const selectedSelector = createSelector([projectSelector, state=>state], (project, state) => {
   return state.selected[project] || default_selected();
})



export const commitsDataSelector = createSelector([projectSelector, projectDataSelector, selectedSelector], (project, project_data, selected) => {
  let key = selected.branch || selected.committer || 'latests';
  return project_data.commits[key] || default_commits_data;
})


const has_batches = c => Object.keys(c.batches).length > 0;
export const commitsSelector = createSelector([commitsDataSelector, state => state.commits], (commits_data, commits) => {
  let out = commits_data.ids.map(id=> commits[id] || {id, batches: {}})
  if (out.some(has_batches))
    return out.filter(c => Date.now() - new Date(c.authored_datetime) < 15 * 1000 || has_batches(c) );
  return out
})


export const latestCommitSelector = createSelector([commitsDataSelector, state => state.commits], (commits_data, commits) => {
  if (commits_data.latest_commit === undefined)
    return {id: undefined, batches: {}}
  const latest_commit = commits[commits_data.latest_commit.id] || {id: commits_data.latest_commit.id, batches: {}};
  return latest_commit
})


export const commitSelector = createSelector([selectedSelector, state => state.commits, commitsDataSelector], (selected, commits, commits_data) => {
  return {
    // we use '' as a special nothing-should-be-selected value
  	new_commit: selected.new_commit_id !== '' && commits[selected.new_commit_id || commits_data.ids[0]],
    ref_commit: selected.ref_commit_id !== '' && commits[selected.ref_commit_id || commits_data.ids[1]],
  }
})


export const configSelector = createSelector([commitSelector, projectDataSelector, selectedSelector], ({new_commit: commit={}}, project_data, selected) => {
  const info = {
    ...project_data,
    ...commit,
    data: {
      ...(project_data.data || {}),
      ...(commit.data || {}),
    }
  }

  const commit_config  = (commit.data || {}).qatools_config;
  const project_config = (project_data.data || {}).qatools_config || {};

  const commit_metrics  = (commit.data || {}).qatools_metrics;
  const project_metrics = (project_data.data || {}).qatools_metrics;
  const metrics = commit_metrics || project_metrics || {};

  let available_metrics = metrics.available_metrics || {}
  let selected_metrics = selected.selected_metrics || (metrics.main_metrics || []).map(k => available_metrics[k])
  return {
    info, /// TODO: remove this. Track usage, replace with config/metrics
    project_config: project_config,
    config: commit_config || project_config,
    project_metrics: {
      available_metrics: {},
      ...project_metrics,
    },
    metrics: {
      available_metrics: {},
      ...metrics,
    },
    selected_metrics,
  }
})


const available_batch = (commit, default_batch) => {
  if (!!!commit || !!!commit.batches) return default_batch;
  const batches = Object.keys(commit.batches);
  if (batches.length===1 || !!!commit.batches[default_batch]) return (!!batches.default && Object.keys(batches.default).length > 0) ? batches.default : batches[0];
  return default_batch
}



const makeSortOutputs = (sort_by, sort_order, outputs) => {
  // console.log(sort_by, sort_order, outputs)
  return (ka, kb) => {
    const a = outputs[ka]
    const b = outputs[kb]
    const a_value = a.metrics[sort_by] || a.extra_parameters[sort_by] || a[sort_by] || ka;
    const b_value = b.metrics[sort_by] || b.extra_parameters[sort_by] || b[sort_by] || kb;
    if (a_value === undefined || a_value === null) return 1;
    // console.log(a_value, b_value)
    if (a_value > b_value) {
      return sort_order;
    }
    if (a_value < b_value) {
      return -sort_order;
    }
    return 0;
  };
};


export const batchSelector = createSelector([selectedSelector, commitSelector, configSelector], (selected, {new_commit, ref_commit}, {metrics}) => {
    const selected_batch_new = available_batch(new_commit, selected.selected_batch_new);
    const selected_batch_ref = available_batch(ref_commit, selected.selected_batch_ref);

    let new_batch = ((!!new_commit && !!new_commit.batches) ? new_commit.batches[selected_batch_new] : empty_batch) || empty_batch;
    let ref_batch = ((!!ref_commit && !!ref_commit.batches) ? ref_commit.batches[selected_batch_ref] : empty_batch) || empty_batch;
    if (new_batch.id === ref_batch.id) {
      // can be same! need to make a copy...
      ref_batch = Object.create(new_batch);
    }
    if (new_batch.outputs === undefined || new_batch.outputs === null) new_batch.outputs = {}
    if (ref_batch.outputs === undefined || ref_batch.outputs === null) ref_batch.outputs = {}

    new_batch.filtered = filter_batch(new_batch, selected.filter_batch_new);
    const sortOutputs = makeSortOutputs(selected.sort_by || metrics.default_metric || 'input_test_path', selected.sort_order, new_batch.outputs)
    new_batch.filtered.outputs = new_batch.filtered.outputs.sort(sortOutputs)
    ref_batch.filtered = filter_batch(ref_batch, selected.filter_batch_ref);

    // we find the matching outputs once
    Object.values(new_batch.filtered.outputs).forEach(id => {
      const output = new_batch.outputs[id]
    	const { output_ref, warning } = matching_output({output, batch: ref_batch});
        output.reference_id = output_ref.id
        output.reference_warning = warning
    })


    // tuned_parameters holds all tuning values used for each parameter
    let extra_parameters = {};
    Object.entries(new_batch.outputs).forEach(([id, o]) => {
      Object.entries(o.extra_parameters).forEach(([param, value]) => {
        if (extra_parameters[param] === undefined)
          extra_parameters[param] = new Set();
        extra_parameters[param].add(value);
      });
    });
    // we sort tuned parameters by the number of different values that were used
    let sorted_extra_parameters = Object.entries(extra_parameters)
      .sort(([p1, s1], [p2, s2]) => s2.size - s1.size)
      .map(([k, v]) => k);

    new_batch.extra_parameters = extra_parameters
    new_batch.sorted_extra_parameters = sorted_extra_parameters
    return {
    	selected_batch_new,
    	selected_batch_ref,
    	new_batch,
    	ref_batch,
    }
})


export const branchesSelector = createSelector([projectDataSelector], project_data => {
   return project_data.branches ||  [];
})
