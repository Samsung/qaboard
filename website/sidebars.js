// "monorepos-subprojects",
// "docker-integration",
// "remote-platforms",

//   "Admin Guides": [
// 	  "starting-server",
// 	  "server-maintenance"
//   ]
// },
// "docs-other": {
// "A Category": ["doc4", "doc5"]
// }

module.exports = {
  "docs": {
    "QA-Board": [
		"introduction",
		"alternatives-and-missing-features"
	],
  	"Getting Started": [
      "installation",
      "project-init",
	  "identifying-inputs-files",
	  "running-your-code",
	  "creating-and-viewing-outputs-files",
	  "computing-quantitative-metrics",
	  "specifying-configurations"
  	],
	"Guides": [
		"using-the-qa-cli",
		"references-and-milestones",
		"visualizations",
		"batches-running-on-multiple-inputs",
		"lsf-integration",
        "triggering-third-party-tools",
		"debugging-runs-with-an-IDE",
		"bit-accuracy",
		"metadata-integration-external-databases",
		"apis",
		"tuning-workflows",
		"ci-integration",
		"faq"
	]
  }
}
