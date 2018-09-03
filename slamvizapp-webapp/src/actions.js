import { get } from "axios";

export const FETCH_PROJECTS = 'FETCH_PROJECTS'
export const UPDATE_PROJECTS = 'UPDATE_PROJECTS'

export const FETCH_BRANCHES = 'FETCH_BRANCHES'
export const UPDATE_BRANCHES = 'UPDATE_BRANCHES'

export const FETCH_COMMIT = 'FETCH_COMMIT'
export const UPDATE_COMMIT = 'UPDATE_COMMIT'


// export const UPDATE_OUTPUT_FILTER = 'UPDATE_OUTPUT_FILTER' // label=new, 


export const fetchProjects = () => {
  return dispatch => {
    dispatch({type: FETCH_PROJECTS})
    get("/api/v1/projects")
      .then(response => {
        dispatch(updateProjects(response.data))
      })
      .catch(error => {
        console.error(error);
      });
  }
}

export const updateProjects = (projects) => ({
  type: UPDATE_PROJECTS,
  projects,
})

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
        console.error(error);
      });
  }
}

export const updateBranches = (project, branches) => ({
  type: UPDATE_BRANCHES,
  project,
  branches,
})


// reselect: memoize
// import { createSelector } from 'reselect'
// https://redux.js.org/recipes/computingderiveddata

