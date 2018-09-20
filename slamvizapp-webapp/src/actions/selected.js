import {
  UPDATE_SELECTED,
} from './constants'

export const updateSelected = (project, selected) => ({
  type: UPDATE_SELECTED,
  project,
  selected,
})

