import { get } from "axios";
import qs from "qs";

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

export const fetchCommit = (project, id, used_for, branch, update_selected=true) => {
  return dispatch => {
    dispatch({
      type: FETCH_COMMIT,
      project,
      id,
    })
		// the API defaults to the latest commit on the reference branch, it is useful
    let use_default_reference_commit = !id
    get(`/api/v1/commit${use_default_reference_commit ? "" : `/${id}`}`, { params: { project, branch } })
      .then(response => {
        dispatch(updateCommit(project, response.data))
        // when we ask for the default reference commit we dont know the id yet
        let id_ = response.data.id
        if (update_selected)
          dispatch(updateSelected(project, { [used_for]: id_}) )
        // we want to keep updated
        // we could use setInterval and update the reference but it makes the logic more complicated...
        // FIXME: don't update for old commits...
        // if (used_for === "new_commit_id")
        //   setTimeout(
        //     x => dispatch(fetchCommit(project, id_, used_for)),
        //     60 * 1000
        //   );
         if (used_for === "ref_commit_id") {
          let query = qs.parse(window.location.search.substring(1));
          let querystring = qs.stringify({
            ...query,
            reference: id_,
          })
          let url = `${window.location.pathname}?${querystring}`;
          // console.log(url)
          window.history.pushState({}, "", url)
        }

      })
      .catch(error => {
      	if (error.response)
        	dispatch(updateCommit(project, {id}, error.response.data.error))
      });
  }
}
