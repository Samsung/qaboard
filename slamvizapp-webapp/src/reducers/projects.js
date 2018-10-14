import {
  FETCH_PROJECTS,
  UPDATE_PROJECTS,
  FETCH_BRANCHES,
  UPDATE_BRANCHES,
  FETCH_COMMITS,
  UPDATE_COMMITS,
} from '../actions/constants'
import { default_project_id, default_project, slam_qatools_config } from "../defaults"

import * as slam_metrics from "../viewers/slam/metrics";


function update_project(state=default_project, data) {
  return {
    ...state,
    ...data,
    // for some reason we get null for projects that are not configured with qatools
    information: {...state.information, ...data.information},
  } 
}


export const branch_key = branch => (branch.name || branch.committer || 'default');

export function projects(state = {
  data: {
    [default_project_id]: default_project,
    // legacy
    'dvs/psp_swip': {...default_project, information: {qatools_config: slam_qatools_config, qatools_metrics: slam_metrics}},
  },
  is_loaded: false,
  is_loading: false,
  error: null
}, action) {
  var new_state;
  switch (action.type) {
    case FETCH_PROJECTS:
      return {
        ...state,
        is_loaded: false,
      }
    case UPDATE_PROJECTS:
      new_state = {
        ...state,
        is_loaded: true,
        error: action.error,
      };
      if (!action.projects) return new_state
      Object.entries(action.projects).forEach( ([project, data]) => {
        new_state.data[project] = update_project(state.data[project], data)
      })
      return new_state;

    case UPDATE_COMMITS:
      // console.log(state)
      var branch = branch_key(action.branch);
      let previous_ids = state.data[action.project].commits[branch] && state.data[action.project].commits[branch].ids;
      new_state = {
        ...state,
        data: {
          ...state.data,
          [action.project]: {
            ...state.data[action.project],
            commits: {
              ...state.data[action.project].commits,
              [branch]: {
                ...state.data[action.project].commits[branch],
                is_loaded: true,
                is_loading: false,
                // in case of error, we keep the previous list of commits
                ids: (action.commits && action.commits.map(c => c.id)) || previous_ids,
                error: action.error,
              }
            }
          }
        }
      }
      if (action.commits.length > 0)
        new_state.data[action.project].commits[branch].date_range =  [
          new Date(action.commits[action.commits.length - 1].authored_datetime),
          new Date(action.commits[0].authored_datetime)
        ]
      return new_state;

    case FETCH_COMMITS:
      branch = branch_key(action.branch);
      return {
        ...state,
        data: {
          ...state.data,
          [action.project]: {
            ...state.data[action.project],
            commits: {
              [branch]: {
                ...state.data[action.project].commits[branch],
                ids: (state.data[action.project].commits[branch] && state.data[action.project].commits[branch].ids) || [],
                is_loading: true,
                error: null,
                date_range: action.date_range,
              }
            }
          }
        }
      }

    case UPDATE_BRANCHES:
      return {
        ...state,
        data: {
          ...state.data,
          [action.project]: update_project(state.data[action.project], {
            branches: action.branches,
            branches_loading: false,
          }), 
        }
      }

    case FETCH_BRANCHES:
      return {
        ...state,
        data: {
          ...state.data,
          [action.project]: update_project(state.data[action.project], {branches_loading: true}), 
        }
      }

    default:
      return state
  }
}


