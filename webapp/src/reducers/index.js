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
import { loggedReducer } from './users'

import { metrics_fill_defaults } from "../utils"


function selected(state = {
  // we select a default project based on the current URL
  project: default_project_id,
  [default_project_id]: {
    ...default_selected(default_project_id),
  }
}, action) {
  switch (action.type) {
    case UPDATE_SELECTED:
      return {
        ...state,
        project: action.project,
        [action.project]: {
          ...default_selected(action.project),
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


function commits(state = { [default_project_id]: {} }, action) {
  var new_state;
  switch (action.type) {
    case UPDATE_COMMITS:
      new_state = {
        ...state,
        [action.project]: {
          ...state[action.project],
        },
      }
      action.commits.forEach(c => {
        new_state[action.project][c.id] = {
          ...new_state[action.project]?.[c.id],
          ...c,
        }
      })
      return new_state;
    case FETCH_COMMIT:
      return {
        ...state,
        [action.project]: {
          ...state[action.project],
          [action.id]: {
            ...state[action.project]?.[action.id],
            // we mark that we loaded the whole data about the commit
            // not just a summary
            is_loaded: false,
            error: action.error,
          }  
        }
      }
    case UPDATE_COMMIT:
      if (action.data.data?.qatools_metrics) {
        action.data.data.qatools_metrics.available_metrics = metrics_fill_defaults(action.data.data.qatools_metrics.available_metrics);
        action.data.data.qatools_metrics.main_metrics = action.data.data.qatools_metrics.main_metrics.filter(m => !!action.data.data.qatools_metrics.available_metrics[m]);
      }
      // here we precompute various useful output information
      // like str representaton of their configs or merged "outputs.params"
      //    params: str -> {config: str}
      Object.keys(action.data.batches).forEach(b => {
        Object.keys(action.data.batches[b].outputs).forEach(id => {
          // this is useful for filtering
          action.data.batches[b].outputs[id].configurations_str = JSON.stringify(action.data.batches[b].outputs[id].configurations)
          action.data.batches[b].outputs[id].extra_parameters_str = JSON.stringify(action.data.batches[b].outputs[id].extra_parameters)
          // this is useful for tuning analysis
          var params = {}
          let configs = [...action.data.batches[b].outputs[id].configurations, action.data.batches[b].outputs[id].extra_parameters]
          configs.forEach(c => {
            if (typeof c === "string")
              return
            params = {...params, ...c}
          })
          action.data.batches[b].outputs[id].params = params
        })
      })
      return {
        ...state,
        [action.project]: {
          ...state[action.project],
          [action.id]: {
            ...state[action.project]?.[action.id],
            ...action.data,
            // we mark that we loaded the whole data about the commit not just a summary
            is_loaded: true,
            error: action.error,
          }
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
  user: loggedReducer,
})


const default_store = {}

export { rootReducer, default_store };