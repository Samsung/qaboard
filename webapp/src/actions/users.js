import {
  LOG_IN,
  LOG_OUT,
} from '../actions/constants'


export const logIn = (user_name) => {
  return {
    type: LOG_IN,
    payload: { user_name, is_logged: true },
  };
};

export const logOut = () => {
  return {
    type: LOG_OUT,
    payload: { user_name: null, is_logged: false },
  };
};