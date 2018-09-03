import { get } from "axios";

export const FETCH_PROJECTS = 'FETCH_PROJECTS'
export const UPDATE_PROJECTS = 'UPDATE_PROJECTS'

export const FETCH_BRANCHES = 'FETCH_BRANCHES'
export const UPDATE_BRANCHES = 'UPDATE_BRANCHES'

export const FETCH_COMMITS = 'FETCH_COMMITS'
export const UPDATE_COMMITS = 'UPDATE_COMMITS'

// export const FETCH_COMMIT = 'FETCH_COMMIT'
// export const UPDATE_COMMIT = 'UPDATE_COMMIT'


// export const UPDATE_OUTPUT_FILTER = 'UPDATE_OUTPUT_FILTER' // label=new, 



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
        dispatch({type: UPDATE_COMMITS, project, reference, error})
      });
  }  
}


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

