import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

// One sidebar per audience, see the navbar in docusaurus.config.ts. The links between them, at the top of every
// sidebar, are in src/components/DocsSwitcher: add a sidebar there too.
// Each section answers one question: "I want to look at results my team produced" is the user guide, "I want to send my
// project's results" is Project integration, "I run the server" is Admin. Get started sends readers to the right one.
// A page with sub-pages (log from code, then its W&B and MLflow shims) is a category whose index is that page: grouping
// pages here keeps their URLs. A page that moves to another folder needs a redirect in docusaurus.config.ts.

// @ts-check
const sidebars: SidebarsConfig = {
  // Everyone's first stop: which section to read, try QA-Board, see what it's for. The navbar's "Docs" and "Use cases"
  start: [
    {
      type: 'category',
      label: 'Get started',
      collapsible: false,
      // Where to start, by what the reader wants to do: the DocsSwitcher's "Get started" opens it
      link: {type: 'doc', id: 'get-started/overview'},
      items: [
        'get-started/quickstart',
        'get-started/tutorial',
        'get-started/concepts',
        // The walkthrough of the web app on the demo projects lives in the user guide (it replaced the product tour)
        {type: 'link', label: 'Your first review (user guide)', href: '/docs/user-guide/first-review'},
        // Project integration's page for coding agents, which do most of an integration
        {type: 'link', label: 'With a coding agent', href: '/docs/agents'},
      ],
    },
    {
      type: 'category',
      label: 'Use cases',
      collapsible: false,
      // The overview (slug /use-cases) shows each use case's problem with a screenshot
      link: {type: 'doc', id: 'use-cases/overview'},
      items: [
        'use-cases/image-quality',
        'use-cases/detection-eval',
        'use-cases/serving-latency',
        'use-cases/robotics-3d',
        'use-cases/agent-evals',
        'use-cases/software-quality',
        // Where QA-Board fits next to experiment trackers, LLM eval platforms and test dashboards
        'alternatives',
      ],
    },
  ],

  // People who look at results in the web app: start with a walkthrough, then one page per task, viewers on their own
  userGuide: [
    'user-guide/overview',
    'user-guide/first-review',
    {
      type: 'category',
      label: 'Find and compare',
      collapsed: false,
      items: [
        'user-guide/finding-results',
        'user-guide/commit-page',
        'user-guide/metrics',
        {
          // Choosing the reference, then each run's reference run
          type: 'category',
          label: 'New and reference',
          link: {type: 'doc', id: 'user-guide/comparing-results'},
          items: ['user-guide/reference-runs'],
        },
        'user-guide/milestones',
        'user-guide/history-and-dashboards',
        'user-guide/local-changes',
      ],
    },
    {
      type: 'category',
      label: 'Look at outputs',
      collapsed: false,
      items: ['user-guide/image-viewer', 'user-guide/video-viewer', 'user-guide/other-viewers'],
    },
    {
      type: 'category',
      label: 'Run and tune',
      collapsed: false,
      items: [
        'user-guide/running-from-the-webapp',
        'user-guide/available-tests',
        {
          // Tuning by hand, then letting QA-Board search
          type: 'category',
          label: 'Tuning, step by step',
          link: {type: 'doc', id: 'user-guide/tuning'},
          items: ['user-guide/automated-tuning'],
        },
        'user-guide/logs',
        'user-guide/runs-activity',
      ],
    },
    {
      type: 'category',
      label: 'Share and manage files',
      collapsed: false,
      items: ['user-guide/sharing', 'user-guide/files', 'user-guide/storage-usage'],
    },
    {
      // A project's Admin pages (Access, Quality gate) and your own account
      type: 'category',
      label: 'Account and projects',
      collapsed: false,
      items: ['user-guide/account', 'user-guide/project-access', 'user-guide/project-gate', 'user-guide/project-audit-log'],
    },
    {
      type: 'category',
      label: 'Help',
      collapsed: false,
      items: ['user-guide/tips-and-faq', 'user-guide/whats-new'],
    },
  ],

  // Project integration: wrapping code with qa, qaboard.yaml, runners, CI. Grouped by what the integrator is doing.
  // The overview first (what an integration makes the web app show, and the steps), then coding agents, which do most
  // of an integration
  docs: [
    {type: 'doc', id: 'introduction', label: 'Start here'},
    {type: 'doc', id: 'agents', label: 'With a coding agent'},
    {
      type: 'category',
      label: 'Set up a project',
      collapsed: false,
      items: [
        'installation',
        'project-init',
        {
          type: 'category',
          label: 'Inputs',
          link: {type: 'doc', id: 'inputs'},
          items: ['metadata-integration-external-databases'],
        },
        'running-your-code',
        'specifying-configurations',
      ],
    },
    {
      // Runs that qa run doesn't start: code that starts by itself, and files other tools already wrote
      type: 'category',
      label: 'Other ways to create runs',
      collapsed: false,
      items: [
        {
          // Training loops, notebooks, then the same from code written for W&B or MLflow: shims, with their
          // compatibility matrices
          type: 'category',
          label: 'Log from your code',
          link: {type: 'doc', id: 'log-from-code'},
          items: [
            {type: 'doc', id: 'from-wandb', label: 'From W&B code'},
            {type: 'doc', id: 'from-mlflow', label: 'From MLflow code'},
          ],
        },
        // Results other tools already wrote: test reports, benchmarks, profiles
        'upload-results',
      ],
    },
    {
      type: 'category',
      label: 'Show results',
      collapsed: false,
      items: [
        'computing-quantitative-metrics',
        {
          // Which files the commit page shows, then what each viewer reads, then the performance formats
          type: 'category',
          label: 'Visualizations',
          link: {type: 'doc', id: 'visualizations'},
          items: ['viewers', 'benchmarks', 'flame-graphs'],
        },
        // What runs use of their machine: memory, CPU, GPUs
        'system-metrics',
        'references-and-milestones',
      ],
    },
    {
      type: 'category',
      label: 'Run batches',
      collapsed: false,
      items: [
        {
          type: 'category',
          label: 'Batches',
          link: {type: 'doc', id: 'batches-running-on-multiple-inputs'},
          items: ['batches-advanced'],
        },
        // Where runs execute: the overview picks a runner, then one page per runner, from a laptop to a cluster
        {
          type: 'category',
          label: 'Where runs execute',
          link: {type: 'doc', id: 'runners'},
          items: [
            'local-multiprocessing',
            'lsf-integration',
            'dask-integration',
            'kubernetes-runner',
            'celery-integration',
            'jenkins-integration',
            'doctor',
            // The compute of MLflow Projects, W&B Launch, ClearML, job arrays...: mapped to runners
            {type: 'doc', id: 'coming-from-other-tools', label: 'From MLflow, Slurm, Ray...'},
          ],
        },
        // What code local runs ran: their changes compared with their commit
        'local-changes',
        'using-the-qa-cli',
      ],
    },
    {
      type: 'category',
      label: 'CI and quality gate',
      items: [
        'ci-integration',
        {
          type: 'category',
          label: 'Quality gate',
          link: {type: 'doc', id: 'quality-gate'},
          items: ['quality-gate-pull-requests'],
        },
        'triggering-third-party-tools',
      ],
    },
    {
      type: 'category',
      label: 'Tuning',
      items: ['tuning-from-the-webapp', 'auto-optimization'],
    },
    {
      // Where runs' files go, then sending them over HTTP, the artifacts, and deleting old ones
      type: 'category',
      label: 'Storage & Artifacts',
      link: {type: 'doc', id: 'storage/where-is-the-data'},
      items: ['storage/uploads', 'storage/artifacts', 'storage/deleting-old-data'],
    },
    {
      // Results read from scripts, CI jobs and agents: Python and qa, then any language
      type: 'category',
      label: 'Results in scripts',
      link: {type: 'doc', id: 'apis'},
      items: ['http-api'],
    },
    {
      type: 'category',
      label: 'Recipes',
      items: ['deep-learning', 'bit-accuracy', 'monorepo-subprojects', 'debugging-runs-with-an-IDE'],
    },
    'faq',
  ],

  // Admins who run the QA-Board server: install it, let people in, choose what it runs and keeps, then operate it
  admin: [
    {
      type: 'category',
      label: 'Install and upgrade',
      collapsed: false,
      items: ['deploy', 'backend-admin/kubernetes', 'backend-admin/deployment', 'backend-admin/git-hosts', 'backend-admin/settings'],
    },
    {
      type: 'category',
      label: 'Users and access',
      collapsed: false,
      items: ['backend-admin/user-management', 'backend-admin/sign-in', 'backend-admin/project-access', 'backend-admin/audit-log'],
    },
    {
      type: 'category',
      label: 'Runs and storage',
      collapsed: false,
      items: ['backend-admin/runners', 'backend-admin/uploads', 'backend-admin/storage', 'backend-admin/annotations'],
    },
    {
      type: 'category',
      label: 'Operate',
      collapsed: false,
      items: ['backend-admin/monitoring', 'backend-admin/usage-analytics', 'backend-admin/troubleshooting', 'backend-admin/support'],
    },
  ],
};

module.exports = sidebars;
