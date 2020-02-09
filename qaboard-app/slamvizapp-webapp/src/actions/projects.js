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


export const fetchCommits = (project, branch, date_range, aggregation_metrics, extra_params) => {
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
