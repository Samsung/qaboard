import { get } from "axios";

import {
  FETCH_PROJECTS,
  UPDATE_PROJECTS,
  FETCH_BRANCHES,
  UPDATE_BRANCHES,
  FETCH_COMMITS,
  UPDATE_COMMITS,

  // UPDATE_TUNING_FORM,
  // UPDATE_CONFIGURATIONS,
} from "./constants";


export const updateProjects = (projects, error) => ({
  type: UPDATE_PROJECTS,
  projects,
  error: error,
})

export const fetchProjects = () => {
  return dispatch => {
    dispatch({type: FETCH_PROJECTS})
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
        dispatch(updateBranches(project, response.data))
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


export const fetchCommits = (project, reference, date_range, aggregation_metrics) => {
  return dispatch => {
    dispatch({type: FETCH_COMMITS, project, reference, date_range})
    var url
    if (reference.committer)
      url =`/api/v1/commits?committer=${reference.committer}`;
    else {
      let branch = "";
      if (reference.branch) branch = `/${reference.branch}`;
      url = `/api/v1/commits${branch}`;
    }
    get(url, {
      params: {
        project,
        from: date_range[0],
        to: date_range[1],
        metrics: JSON.stringify(aggregation_metrics)
      }
    })
      .then(response => {
        dispatch({type: UPDATE_COMMITS, project, reference, commits: response.data})
      })
      .catch(error => {
        dispatch({type: UPDATE_COMMITS, project, reference, error, commits: []})
      });
  }  
}
