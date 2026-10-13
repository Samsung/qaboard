import axios from "axios";
const { get } = axios;

import {
  FETCH_PROJECT,
  FETCH_PROJECTS,
  UPDATE_PROJECTS,
  FETCH_BRANCHES,
  UPDATE_BRANCHES,
  FETCH_COMMITS,
  UPDATE_COMMITS,
  UPDATE_FAVORITE,
  UPDATE_MILESTONES,
} from "./constants";


export const updateProjects = (projects, error) => ({
  type: UPDATE_PROJECTS,
  projects,
  error: error,
})

export const fetchProjects = () => {
  return dispatch => {
    dispatch({ type: FETCH_PROJECTS })
    get("/api/v1/projects")
      .then(response => {
        dispatch(updateProjects(response.data))
      })
      .catch(error => {
        dispatch(updateProjects(null, error))
      });
  }
}



export const fetchProject = project => {
  return dispatch => {
    dispatch({ type: FETCH_PROJECT })
    get(`/api/v1/project?project=${project}`)
      .then(response => {
        // the project's data: its configuration and metrics, which the list of projects leaves out
        dispatch(updateProjects({[project]: {data: response.data}}))
      })
      .catch(error => {
        dispatch(updateProjects(null, error))
      });
  }
}


export const fetchBranches = project => {
  return dispatch => {
    dispatch({
      type: FETCH_BRANCHES,
      project,
    })
    get("/api/v1/project/branches", { params: { project } })
      .then(response => {
        dispatch(updateBranches(project, response.data.map(branch => branch.replace('origin/', '')).filter((v, i, a) => a.indexOf(v) === i)))
      })
      .catch(error => {
        dispatch(updateBranches(project, null, error))
      });
  }
}

export const updateBranches = (project, branches, error) => ({
  type: UPDATE_BRANCHES,
  project,
  branches,
  error: error,
})


// The metrics the commits endpoint aggregates per batch (median, average), with their targets:
// the project's default and main metrics, those the commit list and the branch's chart show
export const aggregation_metrics = qatools_metrics => {
  const available_metrics = qatools_metrics?.available_metrics || {};
  let metrics = {};
  [qatools_metrics?.default_metric, ...(qatools_metrics?.main_metrics || [])].forEach(m => {
    if (available_metrics[m] !== undefined)
      metrics[m] = available_metrics[m]?.target ?? 0
  });
  return metrics
}

// The server only reads the metrics' names
const same_metrics = (a, b) => {
  const names = metrics => Object.keys(metrics || {}).sort().join('\n')
  return names(a) === names(b)
}


export const fetchCommits = (project, branch, date_range, aggregated_metrics, extra_params, fetch_once) => {
  return dispatch => {
    dispatch({ type: FETCH_COMMITS, project, branch, date_range })
    var url
    if (branch.committer)
      url = `/api/v1/commits/?committer=${branch.committer}`;
    else {
      let branch_ = "/";
      if (branch.name) branch_ = `/${branch.name}`;
      url = `/api/v1/commits${branch_}`;
    }
    get(url, {
      params: {
        project,
        from: date_range[0],
        to: date_range[1],
        metrics: JSON.stringify(aggregated_metrics || {}),
        ...extra_params,
      }
    })
      .then(response => {
        dispatch({ type: UPDATE_COMMITS, project, branch, commits: response.data })
        // A branch's metrics are those of its latest commit, which we may not have known when asking:
        // ask once more for them, e.g. for the chart above the branch's commits
        if (!!branch.name && response.data && response.data.length > 0 && !fetch_once) {
          const latest_commit_metrics = aggregation_metrics(response.data[0].data?.qatools_metrics)
          if (!same_metrics(latest_commit_metrics, aggregated_metrics))
            dispatch(fetchCommits(project, branch, date_range, latest_commit_metrics, extra_params, true))
        }
      })
      .catch(error => {
        dispatch({ type: UPDATE_COMMITS, project, branch, error, commits: [] })
      });
  }
}


export const updateFavorite = (project, is_favorite) => ({
  type: UPDATE_FAVORITE,
  project,
  is_favorite,
})

export const updateMilestones = (project, milestones) => ({
  type: UPDATE_MILESTONES,
  project,
  milestones,
})
