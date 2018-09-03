import { combineReducers } from 'redux'
import {
	FETCH_PROJECTS,
	UPDATE_PROJECTS,
	FETCH_BRANCHES,
	UPDATE_BRANCHES,
} from '../actions'


// default with the URL parameters?
// each container will call shouldFetch...


const default_store = {}

function selected(state = {}, action) {
	// project
	// commit
	// batch { new, reference, ... }
	return state
}



function update_project(state = {
	branches: [],
	branches_loading: false,
}, data) {
	return {
		...state,
		...data,
	}	
}

function projects(state = {
	data: {},
	is_loaded: false,
	error: null
}, action) {
  switch (action.type) {
    case UPDATE_PROJECTS:
    	let new_state = {
    		...state,
    		is_loaded: true,
    		error: null,
    	};
      Object.entries(action.projects).forEach( ([project, data]) => {
      	new_state.data[project] = update_project(state.data[project], data)
      })
      return new_state;
    case UPDATE_BRANCHES:
    	return {
    		...state,
    		data: {
    			...state.data,
	  			[action.project]: update_project(state.data[action.project], {
	    			branches: action.branches,
	  				branch_loading: false,
	  			}),	
    		}
    	}
	  case FETCH_BRANCHES:
	  	return {
	  		...state,
	  		data: {
	  			...state.data,
	  			[action.project]: update_project(state.data[action.project], {branch_loading: true}),	
	  		}
	  	}
	  case FETCH_PROJECTS:
	  	return {
	  		...state,
	  		is_loaded: false,
	  	}
    default:
      return state
	}
}

function commits(state = {}, action) {
	return state
}

const rootReducer = combineReducers({
	selected,
	projects,
	commits,
})
export { rootReducer, default_store };