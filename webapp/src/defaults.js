import { matchPath } from 'react-router'
import { DateTime } from 'luxon';


// TODO: import from ./routes without triggering cyclic imports... 
const route_paths = [
	"/:project_id+/committer/:committer+",
	"/:project_id+/commits/:branch+",
	"/:project_id+/commits",
	"/:project_id+/commit/:commit+",
	"/:project_id+/commit",
	"/:project_id+/history/:branch+",
	"/:project_id+/history",
	"/:project_id+",
];

const params = new URLSearchParams(window.location.search);
const default_from_url = (attribute) => {
    // eslint thinks `path` is not used (?) 
    // eslint-disable-next-line
	for (const path of route_paths) {
		const match = matchPath(window.location.pathname, { path })
		if (!!match && !!match.params[attribute]) {
			return match.params[attribute];
		}
	}
	return params.get(attribute)
}

export const default_project_id = default_from_url('project_id') || params.get("project");


export const default_metrics = {
	available_metrics: {},
	default_metric: undefined,
	summary_metrics: [],
	main_metrics: [],
	dashboard_metrics: []
};

export const default_date_range = () => {
	let from_date = new Date(`${default_from_url('from')}T00:00:00`)
	let to_date = new Date(`${default_from_url('to')}T00:00:00`)
	if (from_date === undefined || from_date.toString() == "Invalid Date")
		from_date = DateTime.now().minus({ days: 3 }).startOf('day').toJSDate()
	if (to_date === undefined || to_date.toString() == "Invalid Date")
		to_date = DateTime.now().endOf('day').toJSDate()
	return [from_date, to_date]
}


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
		user: 'root',
	},
	storage: {
		linux: '/mnt/qaboard',
	},
	inputs: {
		configuration: 'base',
		database: {
			linux: null,
			windows: null,
		}
	},
	outputs: {
		visualizations: [],
		style: {
			width: '350px',
		},
	}
}


export const default_project = {
	// what is stored as json metadata in the database, with default values
	data: {
		qatools_metrics: default_metrics,
		qatools_config: default_qatools_config
	},
	// for each reference (branch, tag...), we keep a list of relevant commits
	commits: {

	},
	git: {},
	// we will fetch a list of that project's branches
	branches: [],
	branches_loading: false,
}

// FIXME: get the /commit/X part...

export const default_selected = project => {
	var params = new URLSearchParams(window.location.search);
	const selected = {
		// This decides what is shows on the project page
		// Do we show all the latests commits? a single branch? commits from a given committer?
		branch: default_from_url('branch') || params.get("branch") || null,
		committer: default_from_url('committer') || params.get("committer") || null,

		// User can override the project used to display the results of the selected commit...
		new_project: params.get("new_project") || project,
		ref_project: params.get("ref_project") || project,

		// What commits should we show results for?
		new_commit_id: default_from_url('commit') || null,
		ref_commit_id: params.get("reference") || params.get("commit_ref_folder") || null,

		// What batch of results should we show, with what filters?
		selected_batch_new: params.get("batch") || params.get("batch_new") || "default",
		selected_batch_ref: params.get("batch_ref") || "default",

		filter_batch_new: params.get("filter") || "",
		filter_batch_ref: params.get("filter_ref") || "",

        // filter the list of commits / batches
        search: params.get("search") || "",
		sort_order: params.get("sort_order") || -1,
		sort_by: params.get("sort_by") || undefined, // undefined to be overriden by the default metric,
	}
	if (!!params.get("selected_views")) {
		selected.selected_views = [params.get("selected_views")]
	}
	return selected;
}



export const empty_batch = {
    label: '',
	valid_outputs: 0,
	running_outputs: 0,
	pending_outputs: 0,
	failed_outputs: 0,
	outputs: {},
};
