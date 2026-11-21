const default_metrics = {
	available_metrics: {},
	default_metric: undefined,
	summary_metrics: [],
	main_metrics: [],
	dashboard_metrics: []
};

const default_qatools_config = {
	project: {
		// like the backend and `qa`
		reference_branch: 'master',
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
		// no style: cards take the whole row, see OutputCard
		visualizations: [],
	}
}


export const default_project = {
	// what is stored as json metadata in the database, with default values
	data: {
		qatools_metrics: default_metrics,
		qatools_config: default_qatools_config
	},
	git: {},
	is_favorite: false,
}

export const empty_batch = {
    label: '',
	valid_outputs: 0,
	running_outputs: 0,
	pending_outputs: 0,
	failed_outputs: 0,
	outputs: {},
};


// The project's reference branch, like the backend (backend/reference_branch.py): its qaboard.yaml's, else, for
// projects whose runs sent no qaboard.yaml (qaboard.start_run(), qa upload), their repository's default branch.
// Configurations sent by `qa` always have project.name: the defaults above don't.
// `fallback`: when nothing says, e.g. null to tell
export const reference_branch_of = (project_data, fallback = 'master') => {
  const project_config = project_data?.data?.qatools_config?.project;
  if (project_config?.name)
    return project_config.reference_branch ?? fallback;
  return project_data?.data?.git?.default_branch ?? fallback;
};

// Whether the project's runs never sent a qaboard.yaml: created by qaboard.start_run() or `qa upload`
export const without_qaboard_yaml = project_data => !project_data?.data?.qatools_config?.project?.name;
