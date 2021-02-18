import {
  LOG_IN,
  LOG_OUT,
} from '../actions/constants'


export const loggedReducer = (state = {is_logged: false, user_name: ''}, action) => {
  var new_state;
  switch (action.type) {
    case LOG_IN:
    case LOG_OUT:
      new_state = {
        ...state,
        ...action.payload,
      };
      return new_state
    default:
      return state
    }
};
