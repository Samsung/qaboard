import {
  FETCH_PROJECTS,
  UPDATE_PROJECTS,
  FETCH_BRANCHES,
  UPDATE_BRANCHES,
  FETCH_COMMITS,
  UPDATE_COMMITS,
  UPDATE_FAVORITE,
  UPDATE_MILESTONES,
} from '../actions/constants'
import { default_project_id, default_project } from "../defaults"


function update_project(state = default_project, data) {
  // for backward compatibility, the API returned .data before
  if (!!data.information) {
    data.data = data.information
    data.information = undefined
  }
  // console.log(project_data)
  /*
  // // A quick debug tool
  const debug_views = [{
        name: 'Frames',
        type: 'image/bmp',
        path: ':frame/output.bmp',
        // path: '(.*)/output.bmp',
        display: 'single',
        // display: 'all',
      },
      {
        name: 'Files',
        type: 'text/plain',
        // path: ':frame/(.*.txt)',
        path: '(.*.txt)',
        default_hidden: false,
      }
  ]
  data.data.qatools_config.outputs.visualizations = debug_views;
  console.log('WARNING: replaced the visualizations for debugging!')
  */
  if ((data.data || {}).qatools_metrics) {
    const available_metrics = data.data.qatools_metrics.available_metrics || {};
    data.data.qatools_metrics.main_metrics = data.data.qatools_metrics.main_metrics.filter(m => !!available_metrics[m]);
  }
  return {
    ...state,
    ...data,
    // for some reason we get null for projects that are not configured with qatools
    data: { ...state.data, ...data.data },
  }
}


export const branch_key = branch => {
  if (branch === undefined || branch === null)
    return 'latests';
  return branch.name || branch.committer || 'latests';
}
export function projects(state = {
  data: {
    [default_project_id]: default_project,
  },
  is_loaded: false,
  is_loading: false,
  error: null,
  is_favorite: false,
  milestones: [],
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
      Object.entries(action.projects).forEach(([project, data]) => {
        new_state.data[project] = update_project(state.data[project], data)
      })
      return new_state;

    case UPDATE_COMMITS:
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
        new_state.data[action.project].commits[branch].date_range = [
          new Date(action.commits[action.commits.length - 1].authored_datetime),
          new Date(action.commits[0].authored_datetime)
        ]
      return new_state;


    case UPDATE_FAVORITE:
      return {
        ...state,
        data: {
          ...state.data,
          [action.project]: {
            ...state.data[action.project],
            is_favorite: action.is_favorite,
          }
        }
      }

    case UPDATE_MILESTONES:
      return {
        ...state,
        data: {
          ...state.data,
          [action.project]: {
            ...state.data[action.project],
            milestones: action.milestones,
          }
        }
      }


    case FETCH_COMMITS:
      branch = branch_key(action.branch);
      return {
        ...state,
        data: {
          ...state.data,
          [action.project]: {
            ...state.data[action.project],
            commits: {
              ...state.data[action.project].commits,
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
          [action.project]: update_project(state.data[action.project], { branches_loading: true }),
        }
      }

    default:
      return state
  }
}


