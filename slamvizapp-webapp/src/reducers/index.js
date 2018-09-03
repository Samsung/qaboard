import { combineReducers } from 'redux'
import {
	UPDATE_COMMITS,
} from '../actions/constants'
import { default_project_id  } from "../defaults"
// legacy
import { projects } from './projects'



function selected(state = {
	// we select a default project based on the current URL
	project: default_project_id,
	// 
}, action) {
	// commit
	// batch { new, reference, ... }
	return state
}



export const reference_key = reference => (reference.name || reference.committer || 'default');

function commits(state = {}, action) {
	var new_state;
  switch (action.type) {
    case UPDATE_COMMITS:
    	new_state = {...state}
    	action.commits.forEach( c => {
    		new_state[c.id] = c
    	})
    	return new_state;
   	default:
			return state
	}
}

const rootReducer = combineReducers({
	selected,
	projects,
	commits,
})


const default_store = {}

export { rootReducer, default_store };