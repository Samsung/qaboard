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
	outputs: {
		detailed_views: [],
		style: {
			width: '350px',
		},
	}
}

// legacy
export const slam_qatools_config = {
	project: {
		reference_branch: 'develop',
	},
	inputs: {
		configuration: 'serial-stereo',
		database: {
			linux: '/net/f2/algo_archive/DVS_SLAM_Database',
			windows: '\\\\f2\\algo_archive\\DVS_SLAM_Database',
		},
	},
	outputs: {
		 style: {
		 	width: '350px',			
		 },
		detailed_views: [
			{
				label: "Video",
				type: 'video/mp4',
				path: 'results.mp4',
				poster: 'poster.jpg',
				default_hidden: true,
			},
			{
				type: '6dof/txt',
				path: 'camera_poses_debug.txt',
				path_debug: 'DebugExtensions.txt',
			},
		],
		 controls: [
		 	{	
		 		name: 'show_3d',
		 		default: false,
		 		label: '3d',
		 		type: 'toggle',
		 	},
		 	{
		 		name: 'show_debug',
		 		default: false,
		 		label: 'Debug',
		 		type: 'toggle',
		 	},
		 ]
	},
}
// legacy
export const tof_qatools_config = {
	project: {
		reference_branch: 'develop',
	},
	inputs: {
		configuration: 'xrMode',
		database: {
			linux: '/net/f2/algo_archive/ToF_SW_Database',
			windows: '\\\\f2\\algo_archive\\ToF_SW_Database',
		},
	},
	outputs: {
		style: {
			width: '840px',
		},
		detailed_views: [
			{
				path: 'pointcloud.pcd',
				type: 'pointcloud/txt',
				// in folders, from keys in metrics.json ?
				one_for_each: 'frames',
			},
		],
	},
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
	}
}



export const empty_batch = {
  valid_outputs: 0,
  running_outputs: 0,
  pending_outputs: 0,
  failed_outputs: 0,
  outputs: {},
};
