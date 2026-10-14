const default_metrics = {
	available_metrics: {},
	default_metric: undefined,
	summary_metrics: [],
	main_metrics: [],
	dashboard_metrics: []
};

const default_qatools_config = {
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
	git: {},
	// private milestones, saved in the browser
	milestones: {},
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
