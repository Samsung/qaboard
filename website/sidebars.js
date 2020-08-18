
module.exports = {
    docs: {
        "Getting Started": [
            "introduction",
            "deploy",
            "installation",
            "project-init",
            "inputs",
            "running-your-code",
            "creating-and-viewing-outputs-files",
            "computing-quantitative-metrics",
            "specifying-configurations",
        ],
        "Guides": [
            "visualizations",
            "batches-running-on-multiple-inputs",
            "using-the-qa-cli",
            "references-and-milestones",
            "tuning-from-the-webapp",
            {
                type: 'category',
                label: 'Distributed Task Queues',
                items: [
                    "celery-integration",
                    "lsf-integration",
                    "local-multiprocessing",
                ],
            },
            {
                type: 'category',
                label: 'Storage & Artifacts',
                items: [
                    "storage/where-is-the-data",
                    "storage/artifacts",
                    "storage/deleting-old-data",
                ],
            },
            "triggering-third-party-tools",
            "ci-integration",
            "debugging-runs-with-an-IDE",
            "metadata-integration-external-databases",
            "apis",
            "tuning-workflows",
            "dag-pipelines",
            "bit-accuracy",
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
        // "alternatives",
        "Backend Admin": [
            "backend-admin/troubleshooting",
            "backend-admin/host-upgrades",
        ]
    }
}
