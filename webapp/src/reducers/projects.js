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
    let available_metrics = JSON.parse(JSON.stringify(data.data.qatools_metrics.available_metrics  || {}));
    Object.entries(available_metrics).forEach( ([key, m])  => {
      m.key = key
      m.label = m.label || key
      m.short_label = m.short_label || m.label || key
      m.scale = m.scale  || 1.0
      m.suffix = m.suffix || ''
      if (m.smaller_is_better === undefined || m.smaller_is_better === null) {
        m.smaller_is_better = true;
      } else {
        if (typeof m.smaller_is_better === "string") {
          m.smaller_is_better = m.smaller_is_better.tolower() !== 'false'
        }
      }
      if (key.startsWith('.')) {
        delete available_metrics[key]
      }
      if (key.startsWith('.')) {
        delete available_metrics[key]
      }
    })
    data.data.qatools_metrics.available_metrics = available_metrics;
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
  data: !!default_project_id ?  {
    [default_project_id]: default_project,
  } : {},
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
        data: {
          ...state.data,
        }
      };
      if (!action.projects)
        return new_state;

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
      if (action.commits.length > 0) {
        const first_commit = action.commits[action.commits.length - 1];
        const last_commit = action.commits[0];
        new_state.data[action.project].commits[branch].date_range = [
          new Date(first_commit.authored_datetime),
          new Date(last_commit.authored_datetime),
        ]
        // We keep track of the latest commit on each branch, hopping for no git tricks..
        if (branch !== 'latests') {
          var branch_last_commit = last_commit
        } else {
          const default_branch = ((state.data[action.project].data || {}).git || {}).default_branch ||
                                 (((state.data[action.project].data || {}).qatools_config || {}).project || {}).reference_branch;
          branch_last_commit = action.commits.filter(c => c.branch === default_branch )[0];
        }
        const last_commit_authored_datetime = new Date((branch_last_commit || {}).authored_datetime);
        // console.log("branch_last_commit", branch_last_commit, last_commit_authored_datetime)
        let had_latest_commit = new_state.data[action.project].commits[branch].latest_commit !== undefined;
        // console.log("had_latest_commit", had_latest_commit)
        let previous_latest_authored_datetime = had_latest_commit && new Date(new_state.data[action.project].commits[branch].latest_commit.authored_datetime)
        // console.log('newer?', previous_latest_authored_datetime, previous_latest_authored_datetime < last_commit_authored_datetime)
        if ( (!!branch_last_commit && !had_latest_commit) || previous_latest_authored_datetime < last_commit_authored_datetime) {
          // console.log('new latest')
          new_state.data[action.project].commits[branch].latest_commit = {
            id: branch_last_commit.id,
            authored_datetime: last_commit_authored_datetime,
          }  
        }
      }
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
            milestones: {...action.milestones},
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


