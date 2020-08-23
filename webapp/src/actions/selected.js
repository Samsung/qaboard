import qs from "qs";

import history from "../history";
import {
  UPDATE_SELECTED,
} from './constants'



const attribute_mappings = {
  ref_commit_id: "reference",
  selected_batch_new: "batch",
  selected_batch_ref: "batch_ref",
  filter_batch_new: "filter",
  filter_batch_ref: 'filter_ref',
}

export const updateSelected = (project, selected, url_search) => {
  if (!!selected) {
    // Update the URL path and query
    var pathname = window.location.pathname; 
    if (!!selected && !!selected.new_commit_id && selected.new_commit_id !== '' && window.location.pathname.includes('commit') && !window.location.pathname.includes('commits') && !window.location.pathname.includes('history')) {
      let pathname_parts = window.location.pathname.split('/')
      pathname_parts[pathname_parts.length-1] = selected.new_commit_id;
      pathname = pathname_parts.join('/')
    }
    // FIXME: when we update the branch, we should also update the URL correctly if it's for dashboard/commit list

    let selected_in_url = {};
    Object.entries(selected).forEach( ([key, value]) => {
        selected_in_url[attribute_mappings[key] || key] = value
    })
    // if set, already part of the URL path
    selected_in_url.new_commit_id = undefined;

    let search = qs.parse(window.location.search.substring(1));
    history.push({
      pathname,
      search: qs.stringify({
        ...search,
        ...selected_in_url,
        ...(url_search || {})
      })
    })
  }
  return {
    type: UPDATE_SELECTED,
    project,
    selected,   
  }
}

