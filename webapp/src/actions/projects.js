import { get } from "axios";

import {
  FETCH_PROJECTS,
  UPDATE_PROJECTS,
  FETCH_BRANCHES,
  UPDATE_BRANCHES,
  FETCH_COMMITS,
  UPDATE_COMMITS,
  UPDATE_FAVORITE,
  UPDATE_MILESTONES,
} from "./constants";
import { metrics_fill_defaults } from "../utils"


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


export const fetchCommits = (project, branch, date_range, aggregation_metrics, extra_params, fetch_once) => {
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
        metrics: JSON.stringify(aggregation_metrics),
        ...extra_params,
      }
    })
      .then(response => {
        dispatch({ type: UPDATE_COMMITS, project, branch, commits: response.data })
        if (!!branch.name && response.data && response.data.length > 0 && !fetch_once) {
          const latest_commit = response.data[0]
          const available_metrics = metrics_fill_defaults(latest_commit.data.qatools_metrics?.available_metrics);
          let aggregated_metrics = {};
          (latest_commit.data.qatools_metrics?.main_metrics || []).forEach(m => {
            if (available_metrics[m] !== undefined)
              aggregated_metrics[m] = available_metrics[m].target ?? 0
          });
          fetchCommits(project, branch, date_range, aggregated_metrics, extra_params, false)
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

export const updateMilestones = (project, milestones, storage /*"local" | "shared"*/) => ({
  type: UPDATE_MILESTONES,
  project,
  milestones,
})
