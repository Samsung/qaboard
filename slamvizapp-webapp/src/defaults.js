import moment from "moment";


const params = new URLSearchParams(window.location.search);
export const default_project_id = params.get("project") || 'dvs/psp_swip';

export const default_metrics = {
  available_metrics: {},
  default_metric: null,
  summary_metrics: [],
  main_metrics: [],
  dashboard_metrics: []
};

export const default_date_range = [new Date(moment().subtract(3, "d")), new Date()]

export const default_commits_data = {
  is_loaded: false,
  is_loading: false,
  error: null,
  ids: [],
  date_range: default_date_range,
}

export const default_qatools_config = {
	project: {
		reference_branch: 'develop',
	},
} 

export const default_project = {
	// what is stored as json metadata in the database, with default values
	information: {qatools_metrics: default_metrics, qatools_config: default_qatools_config},
	// for each reference (branch, tag...), we keep a list of relevant commits
	commits: {

	},
	// we will fetch a list of that project's branches
	branches: [],
	branches_loading: false,	
}

// FIXME: get the /commit/X part...
let commit_from_pathname = window.location.pathname.includes('/commit') && window.location.pathname.slice(8)
export const default_new_commit_id = params.get("commit_folder") || commit_from_pathname || null;
export const default_ref_commit_id = params.get("reference") || params.get("commit_ref_folder") || null;

export const default_batch_new = params.get("batch_new") || "default";
export const default_batch_ref = params.get("batch_reference") || "default";

export const default_filter_batch_new = params.get("filter") || "";
export const default_filter_batch_ref = params.get("filter_ref") || "";
