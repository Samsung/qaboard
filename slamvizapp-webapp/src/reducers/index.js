import { combineReducers } from 'redux'
import {
	UPDATE_COMMITS,
	UPDATE_COMMIT,
	FETCH_COMMIT,
	UPDATE_SELECTED,
} from '../actions/constants'
import { projects } from './projects'
import {
	default_project_id,
	default_ref_commit_id,
	default_new_commit_id,
	default_batch_new,
	default_batch_ref,
	default_filter_batch_new,
	default_filter_batch_ref
} from "../defaults"



function selected(state = {
	// we select a default project based on the current URL
	project: default_project_id,
	[default_project_id] : {
		new_commit_id: default_new_commit_id,
		ref_commit_id: default_ref_commit_id,
		batches_new: default_batch_new,
		batches_ref: default_batch_ref,
		filter_new: default_filter_batch_new,
		filter_ref: default_filter_batch_ref,		
	}	
}, action) {
  switch (action.type) {
    case UPDATE_SELECTED:
			return {
				...state,
    		project: action.project,
				[action.project]: {
					...state[action.project],
					...action.selected,
				},
			}
    default:
    	return state;
	}
}

// function filter(state ={}, action) {
//   switch (action.type) {
//     case UPDATE_FILTER:
//     	return {
//     		...state,
//     		project: action.project,
//     		[action.project]: {
//     			...state[action.project],
//     			...action.filter,
//     		}
//     	}
//     default:
//     	return state
// 	}
// }


export const reference_key = reference => (reference.name || reference.committer || 'default');

function commits(state = {}, action) {
	var new_state;
  switch (action.type) {
    case UPDATE_COMMITS:
    	new_state = {...state}
    	action.commits.forEach( c => {
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
	// filter,
})


const default_store = {}

export { rootReducer, default_store };