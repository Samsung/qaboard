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
	inputs: {
		configuration: 'base',
	},
}

// legacy
export var slam_qatools_config = {...default_qatools_config};
slam_qatools_config.inputs.configuration = 'serial-stereo'
slam_qatools_config.inputs.database = {
	linux: '/net/f2/algo_archive/DVS_SLAM_Database',
	windows: '/net/f2/algo_archive/DVS_SLAM_Database',
}
// legacy
export var tof_qatools_config = {...default_qatools_config};
tof_qatools_config.inputs.database = {
	linux: '/net/f2/algo_archive/ToF_SW_Database',
	windows: '/net/f2/algo_archive/ToF_SW_Database',
}
tof_qatools_config.inputs.configuration = 'xrMode'



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

export const default_selected = () => {
	let commit_from_pathname = window.location.pathname.includes('/commit') && window.location.pathname.slice(8)
	return {
		new_commit_id: params.get("commit_folder") || commit_from_pathname || null,
		ref_commit_id: params.get("reference") || params.get("commit_ref_folder") || null,

		batch_new: params.get("batch_new") || "default",
		batch_ref: params.get("batch_reference") || "default",

		filter_batch_new: params.get("filter") || "",
		filter_batch_ref: params.get("filter_ref") || "",
	}
}
