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



export const commitSelector = createSelector([selectedSelector, state => state.commits], (selected, commits) => {
  return {
  	new_commit: commits[selected.new_commit_id],
  	ref_commit: selected.ref_commit_id && commits[selected.ref_commit_id],
  }
})




const unique_batch = commit => {
  if (!!!commit || !!!commit.batches) return null;
  const batches = Object.keys(commit.batches);
  if (batches.length===1) return batches[0];
}

export const batchSelector = createSelector([selectedSelector, commitSelector], (selected, {new_commit, ref_commit}) => {
    const selected_batch_new = unique_batch(new_commit) || selected.selected_batch_new;
    const selected_batch_ref = unique_batch(ref_commit) || selected.selected_batch_ref;

    let new_batch = ((!!new_commit && !!new_commit.batches) ? new_commit.batches[selected_batch_new] : empty_batch) || empty_batch;
    let ref_batch = ((!!ref_commit && !!ref_commit.batches) ? ref_commit.batches[selected_batch_ref] : empty_batch) || empty_batch;
    if (new_batch.outputs === undefined || new_batch.outputs === null) new_batch.outputs = {}
    if (ref_batch.outputs === undefined || ref_batch.outputs === null) ref_batch.outputs = {}

    let new_batch_filtered = filter_batch(new_batch, selected.filter_batch_new);
    let ref_batch_filtered = filter_batch(ref_batch, selected.filter_batch_ref);

    // we find the matching outputs once
    Object.values(new_batch_filtered.outputs).forEach(output => {
    	const { output_ref, warning } = matching_output({output, batch: ref_batch});
        output.reference_id = output_ref.id
        output.reference_warning = warning
    })

    return {
    	selected_batch_new,
    	selected_batch_ref,
    	new_batch,
    	ref_batch,
    	new_batch_filtered,
    	ref_batch_filtered,
    }
})


export const branchesSelector = createSelector([projectDataSelector], project_data => {
   return project_data.branches ||  [];
})
