import { get } from "axios";

import {
  UPDATE_COMMIT,
  FETCH_COMMIT,
} from "./constants";
import { updateSelected } from './selected';


export const updateCommit = (project, commit, error) => ({
  type: UPDATE_COMMIT,
  id: commit.id,
  data: commit,
  error,
})

export const fetchCommit = (project, id, used_for, branch, batch, update_selected=true) => {
  return dispatch => {
    dispatch({
      type: FETCH_COMMIT,
      project,
      id,
    })
		// the API defaults to the latest commit on the reference branch, it is useful
    let use_default_reference_commit = !id
    get(`/api/v1/commit${use_default_reference_commit ? "/" : `/${id}`}`, { params: { project, branch, batch } })
      .then(response => {
        dispatch(updateCommit(project, response.data))
        // when we ask for the default reference commit we dont know the id yet
        let id_ = response.data.id
        if (update_selected)
          dispatch(updateSelected(project, { [used_for]: id_}) )
        // we want to keep updated
        // we could use setInterval and update the reference but it makes the logic more complicated...
        // TODO: if not the one selected, stop updating...
        // if (used_for === "new_commit_id") // why not both?
        //   setTimeout(
        //     x => dispatch(fetchCommit(project, id_, used_for, branch, batch, update_selected=false)),
        //     60 * 1000
        //   );
      })
      .catch(error => {
      	if (error.response)
        	dispatch(updateCommit(project, {id}, error.response.data.error))
      });
  }
}
