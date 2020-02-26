
module.exports = {
  docs: {
    "QA-Board": [
		"introduction",
		"alternatives-and-missing-features",
	],
  	"Getting Started": [
	  "installation",
	  "start-server",
      "project-init",
	  "inputs",
	  "running-your-code",
	  "creating-and-viewing-outputs-files",
	  "computing-quantitative-metrics",
	  "specifying-configurations",
  	],
	"Guides": [
		"using-the-qa-cli",
		"references-and-milestones",
		"visualizations",
		"batches-running-on-multiple-inputs",
		{
			type: 'category',
			label: 'Tuning & Async Task Queues',
			items: [
				"tuning-from-the-webapp",
				"celery-integration",
				"lsf-integration",		
			],
		},
        "triggering-third-party-tools",
		"debugging-runs-with-an-IDE",
		"bit-accuracy",
		"metadata-integration-external-databases",
		"apis",
		"tuning-workflows",
		"ci-integration",
		"deleting-old-data",
		"dag-pipelines",
		"faq",
		// "history"
		// "monorepos-subprojects",
		// "docker-integration",
		// "remote-platforms",
	],
	// "Parameter Tuning": [
	// 	"Tuning Workflows",
	// 	"Enabling Tuning from QA-Board", // Save artifacts..
	// 	"Tuning runners", // setup LSF and != LSF///
	//   "Auto-Tuning"
	// ],
	//      ""
	//   "Admin Guides": [
	// 	  "starting-server",
	// 	  "server-maintenance"
	//   ]
	"Backend Admin": [
		"backend-admin/troubleshooting",
		"backend-admin/host-upgrades",
	]
}
}
