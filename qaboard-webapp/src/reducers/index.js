import { combineReducers } from 'redux'
import {
  UPDATE_COMMITS,
  UPDATE_COMMIT,
  FETCH_COMMIT,
  UPDATE_SELECTED,
  UPDATE_TUNING_FORM,
} from '../actions/constants'
import { projects } from './projects'
import {
  default_project_id,
  default_selected,
} from "../defaults"


function selected(state = {
  // we select a default project based on the current URL
  project: default_project_id,
  [default_project_id]: {
    ...default_selected(),
  }
}, action) {
  switch (action.type) {
    case UPDATE_SELECTED:
      return {
        ...state,
        project: action.project,
        [action.project]: {
          ...default_selected(),
          ...state[action.project],
          ...action.selected,
        },
      }
    default:
      return state;
  }
}


function tuning(state = { [default_project_id]: {} }, action) {
  switch (action.type) {
    case UPDATE_TUNING_FORM:
      return {
        ...state,
        [action.project]: {
          ...state[action.project],
          ...action.tuning_form,
        },
      }
    default:
      return state;
  }
}


function commits(state = {}, action) {
  var new_state;
  switch (action.type) {
    case UPDATE_COMMITS:
      new_state = { ...state }
      action.commits.forEach(c => {
        new_state[c.id] = {
          ...new_state[c.id],
          ...c,
        }
      })
      return new_state;
    case FETCH_COMMIT:
      return {
        ...state,
        [action.id]: {
          ...state[action.id],
          // we mark that we loaded the whole data about the commit
          // not just a summary
          is_loaded: false,
          error: action.error,
        }
      }
    case UPDATE_COMMIT:
      // FIXME: error handling as action.error
      /*
      // // A quick debug tool
      const debug_views = [
          //{
            //name: 'Frames',
            // type: 'image/bmp',
            // path: ':frame/output.bmp',
            // path: '(.*)/output.bmp',
            //display: 'single',
            // display: 'all',
          //},
          {
            name: 'Files',
            type: 'text/plain',
            path: ':frame/(.*.txt)',
            // path: '(.*.txt)',
            default_hidden: false,
          },
          {
            name: 'Debug',
            type: 'image/bmp',
            path: '(.*.bmp|.*.hex|.*.raw)',
            // path: '(.*.txt)',
            default_hidden: false,
          }

      ]
      console.log(action)
      action.data.data.qatools_config.outputs.visualizations = debug_views;
      console.log('WARNING: replaced the visualizations for debugging!')
      */
      if ((action.data.data || {}).qatools_metrics) {
        let available_metrics = JSON.parse(JSON.stringify(action.data.data.qatools_metrics.available_metrics  || {}));
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
        })
        action.data.data.qatools_metrics.available_metrics = available_metrics;
        action.data.data.qatools_metrics.main_metrics = action.data.data.qatools_metrics.main_metrics.filter(m => !!available_metrics[m]);
      }
      return {
        ...state,
        [action.id]: {
          ...state[action.id],
          ...action.data,
          // we mark that we loaded the whole data about the commit
          // not just a summary
          is_loaded: true,
          error: action.error,
        }
      }
    default:
      return state
  }
}


const rootReducer = combineReducers({
  projects,
  commits,
  selected,
  tuning,
})


const default_store = {}

export { rootReducer, default_store };