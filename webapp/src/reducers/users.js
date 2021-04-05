import {
  LOG_IN,
  LOG_OUT,
} from '../actions/constants'


const user_logged_out_state = {
  is_logged: false,
  user_id: null,
  user_name: null,
  full_name: null,
  email: null,
}

export const loggedReducer = (state = {...user_logged_out_state}, action) => {
  switch (action.type) {
    case LOG_IN:
      return {
        ...state,
        is_logged: true,
        ...action.user,
      }
    case LOG_OUT:
      return {...user_logged_out_state}
    default:
      return state
    }
};
