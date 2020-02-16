import {
  UPDATE_TUNING_FORM,
} from './constants'

export const updateTuningForm = (project, tuning_form) => ({
  type: UPDATE_TUNING_FORM,
  project,
  tuning_form,
})

