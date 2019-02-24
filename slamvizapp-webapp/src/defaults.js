import moment from "moment";


const params = new URLSearchParams(window.location.search);
export const default_project_id = params.get("project") || 'dvs/psp_swip';

export const default_metrics = {
  available_metrics: {},
  default_metric: undefined,
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
	lsf: {
		user: 'ispq',
	},
	ci_root: {
		linux: '/home/arthurf/ci',
	},
	inputs: {
		configuration: 'base',
		database: {
			linux: null,
			windows: null,
		}
	},
	outputs: {
		detailed_views: [],
		style: {
			width: '350px',
		},
	}
}


export const default_project = {
	// what is stored as json metadata in the database, with default values
	information: {
		qatools_metrics: default_metrics,
		qatools_config: default_qatools_config
	},
	// for each reference (branch, tag...), we keep a list of relevant commits
	commits: {

	},
	// we will fetch a list of that project's branches
	branches: [],
	branches_loading: false,	
}

// FIXME: get the /commit/X part...

export const default_selected = () => {
	let commit_from_pathname = window.location.pathname.includes('/commit') && window.location.pathname.slice(8)
    var params = new URLSearchParams(window.location.search);
	return {
		new_commit_id: params.get("commit_folder") || commit_from_pathname || null,
		ref_commit_id: params.get("reference") || params.get("commit_ref_folder") || null,

		batch_new: params.get("batch_new") || "default",
		batch_ref: params.get("batch_reference") || "default",

		filter_batch_new: params.get("filter") || "",
		filter_batch_ref: params.get("filter_ref") || "",

		selected_tab_summary: params.get("selected_tab_summary") || "metrics",
		selected_tab_details: params.get("selected_tab_details"), // || "table-compare",
	}
}



export const empty_batch = {
  valid_outputs: 0,
  running_outputs: 0,
  pending_outputs: 0,
  failed_outputs: 0,
  outputs: {},
};
