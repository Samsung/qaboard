<p align="center">
  <img src="website/static/img/qaboard-logo.svg" alt="" width="88">
</p>
<h1 align="center">QA-Board</h1>
<p align="center">

  <div align="center"><b>Tests tell you it runs. QA-Board shows you it's better.</b></div>

  <div align="center">Self-hosted quality tracking for people and agents: every commit's outputs and metrics next to the reference's.</div>
</p>

<p align="center">
  <a href="https://pypi.org/project/qaboard/"><img src="https://img.shields.io/pypi/v/qaboard" alt="PyPI"/></a>
  <a href="https://samsung.github.io/qaboard"><img src="https://img.shields.io/badge/docs-master-steelblue.svg?style=flat-square" alt="Docs"/></a>
  <a href="https://github.com/samsung/qaboard/actions?query=workflow%3ACI"><img src="https://github.com/samsung/qaboard/workflows/CI/badge.svg" alt="CI"/></a>
</p>

Every change runs on your test set, whether a person or a coding agent wrote it. QA-Board puts its outputs and metrics
next to the reference's (images, videos, point clouds, plots, flame graphs, test reports and logs) so everyone sees
what changed, agrees it's better, and ships it. For camera and imaging pipelines, ML models, robotics, embedded code,
performance, test suites and LLM agents: anything whose quality you measure.

<p align="center">
  <a href="https://samsung.github.io/qaboard">
    <img src="https://samsung.github.io/qaboard/media/shots/landing/hero/593a3d9e7ed953dc.webp" width="820"
      alt="The Metrics Diff of a new denoiser, PSNR up and edge overshoot up, above its image and the reference's with their difference between them.">
  </a>
</p>
<p align="center">
  <i>A new denoiser wins PSNR, and the images show the halos it adds.
  <a href="https://samsung.github.io/qaboard">Clips and use cases on the website</a>.</i>
</p>

## Set it up one step at a time
Start with a server on your computer. Add your project next, then your team.

1. **A server on your computer**, in a few commands: one Compose file, or a kind cluster, starts QA-Board with demo
   projects to explore. Most of the time goes to downloading about 2 GB of images.
   See [the quickstart](https://samsung.github.io/qaboard/docs/get-started/quickstart).
2. **Your project, one step at a time:** `qa init`, then your inputs, your code, its metrics, its files. Most steps take
   5 to 30 minutes, and each shows something new in the web app. Runners and CI come when you want them.
   See [the steps](https://samsung.github.io/qaboard/docs/introduction#steps) and
   [the tutorial](https://samsung.github.io/qaboard/docs/get-started/tutorial).
3. **A server for your team:** the same Compose files, or the Helm chart, on your machines. Add single sign-on, project
   roles, backups and monitoring when you need them.
   See [Start a server](https://samsung.github.io/qaboard/docs/deploy).

**Or ask your coding agent.** Coding agents such as Claude Code are good at this setup. Point yours at the quickstart
to start a server, and give it the [integration skill](skills/qaboard-integration) to add your project: see
[Coding agents](https://samsung.github.io/qaboard/docs/agents).

What it needs: Docker or Kubernetes for the server, and a folder that the server and your runs both see: a local
folder on one computer, a shared one (NFS, SMB...) for a team.

## What you get
- **Compare every commit with a reference:** the reference branch, a release or a milestone, metric by metric, with
  regressions in red.
- **Look at the outputs themselves:** images down to the pixel with synced zoom and diffs, videos, point clouds and
  trajectories, plots, flame graphs, test reports, logs.
- **Performance, from the files you have:** flame graph diffs from what profilers write, and benchmark results from
  pytest-benchmark, Google Benchmark, hyperfine, Criterion, JMH and `go test`, each against the reference's.
- **Find the commit that changed it:** History follows a metric across commits, input by input.
- **Tune from the browser:** parameter sweeps and automated tuning (`qa optimize`, with Optuna).
- **People and agents together:** coding agents read the same results as people (`qaboard.runs(url)`, `qa runs`, the
  [HTTP API](https://samsung.github.io/qaboard/docs/http-api)), and `qa gate` (experimental) fails CI when quality
  regresses, whoever wrote the change.
- **Fits your stack:** wraps any executable, runs locally, on LSF, Dask, Celery or Kubernetes, or in CI (GitHub
  Actions, GitLab CI, Jenkins...). Open source (Apache 2.0) and self-hosted: your results stay on your network.

## In production at scale
QA-Board has been Samsung's central quality platform since 2018: about 50 projects and more than 40 million runs.
Running it is documented and tested in CI: zero-downtime upgrades and rollbacks, backups, and a Helm chart for
Kubernetes. Users sign in with single sign-on or LDAP, project roles control access, and errors go to Sentry.

## We help you get started
We're looking for teams who track quality, and we help them get started: setting up a self-hosted server, integrating
the first projects, planning upgrades and storage as results grow. Write to **arthur@fl.am**, or
[open an issue](https://github.com/Samsung/qaboard/issues).

## Contributing
To learn about the code's organization, or how to contribute, read [CONTRIBUTING.md](CONTRIBUTING.md). Found a bug?
[Submit an issue](https://github.com/Samsung/qaboard/issues), and feel free to send pull requests to `master`.

## Contributors
QA-Board was started at [Samsung](https://www.linkedin.com/company/samsung-israel-r-d-center-sirc/) by [Arthur Flam](https://shapescience.xyz).

Thanks to the following people for their contributions, testing, feedback or bug reports: Amir Fruchtman, Avi Schori, Yochay Doutsh, Itamar Persi, Amichay Amitay, Lena Grechikhin, Gal Hai, Rivka Emmanuel, Nadav Ofer. Thanks also to Sebastien Derhy, Elad Rozin, Nathan Levy, Shahaf Duenyas, Asaf Jazcilevich and Yoel Yaffe for supporting the project.

> You don't see your name? Get in touch to be added to the list!
