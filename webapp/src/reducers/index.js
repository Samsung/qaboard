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


// precompute useful data
// like str representaton of their configs or merged "outputs.params"
// params: str -> {config: str}
const preprocess_output = output => {
  // output.configurations = output.configurations.slice(0, 2)
  const run_params = output.data?.params
  // const run_params = {
  //   model: 'GAN',
  //   badges: [
  //     {text: "Training", href: "https://wandb/run/<some-id>", "icon": "settings"}
  //   ]
  // }
  if (run_params !== undefined) {
    // output.configurations.push(run_params)
    output.extra_parameters = {
      ...output.extra_parameters,
      ...run_params,
    } 
  }
  // useful for filtering
  output.configurations_str = JSON.stringify(output.configurations)
  output.extra_parameters_str = JSON.stringify(output.extra_parameters)
  // useful for tuning analysis
  var params = {}
  let configs = [
    ...output.configurations,
    output.extra_parameters,
  ]
  configs.forEach(c => {
    if (typeof c === "string" || c === undefined || c === null)
      return
    params = {...params, ...c}
  })
  output.params = params
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
      action.commits.forEach(commit => {
        // const commit = new_state[action.project]?.[c.id]
        // console.log(commit)
        Object.keys(commit.batches ?? {}).forEach(b => {
          Object.keys(commit.batches[b].outputs ?? {}).forEach(id => {
            // console.log(id, commit.batches[b].outputs[id])
            preprocess_output(commit.batches[b].outputs[id])
          })
        });
        new_state[action.project][commit.id] = {
          ...new_state[action.project]?.[commit.id],
          ...commit,
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
      if (action.error === null || action.error === undefined){
        Object.keys(action.data.batches).forEach(b => {
          Object.keys(action.data.batches[b].outputs).forEach(id => {
            preprocess_output(action.data.batches[b].outputs[id])
          })
      })}
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