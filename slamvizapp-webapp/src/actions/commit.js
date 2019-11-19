import { get } from "axios";

import {
  UPDATE_COMMIT,
  FETCH_COMMIT,
} from "./constants";
import { updateSelected } from './selected';


const refresh_interval = 15 * 1000 // seconds


export const updateCommit = (project, commit, error) => ({
  type: UPDATE_COMMIT,
  id: commit.id,
  data: commit,
  error,
})


export const fetchCommit = ({project, id, branch, update_selected, batch}) => {
  return dispatch => {
    dispatch({
      type: FETCH_COMMIT,
      project,
      id,
    })
    // the API defaults to the latest commit on the reference branch, it is useful
    get(`/api/v1/commit${!!!id ? "/" : `/${id}`}`, { params: { project, branch, batch } })
      .then(response => {
        dispatch(updateCommit(project, response.data))

        // when page load and look for, say, the latest commit on master, we don't know it's commit hash until we fetch it
        // hence we have to expose a way to updated the "selected" commit to the now-known commit
        let id_ = response.data.id
        if (update_selected)
          dispatch(updateSelected(project, { [update_selected]: id_}) )

        // we want to keep updated
        const batches = response.data.batches || {}
        if (batches.some(b => b.pending_outputs > 0))
          setTimeout(x => dispatch(fetchCommit({project, id: id_, batch})), refresh_interval);
      })
      .catch(error => {
        if (error.response)
          dispatch(updateCommit(project, {id}, error.response.data.error))
      });
  }
}
