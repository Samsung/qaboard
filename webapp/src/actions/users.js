import {
  LOG_IN,
  LOG_OUT,
} from '../actions/constants'


export const login = (user) => {
  return {
    type: LOG_IN,
    user,
  };
};

export const logout = () => {
  return {type: LOG_OUT};
};