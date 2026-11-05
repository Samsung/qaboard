<p align="center">
  <img src="https://user-images.githubusercontent.com/2649055/86829138-bb6aef00-c09c-11ea-8b59-78b7fc44ebcf.png" alt="QA-Board logo" width="260">

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

> Screenshots, clips and use cases: [samsung.github.io/qaboard](https://samsung.github.io/qaboard).

## In production at scale
QA-Board has been Samsung's central quality platform since 2018: about 50 projects, tens of millions of runs, and
workflows teams depend on to ship. Running it is documented and tested: zero-downtime upgrades and rollbacks (the CI
runs a rolling deploy), backups, a Helm chart that the CI installs on Kubernetes and runs a real batch against, single
sign-on, LDAP and project roles, and Sentry monitoring.

## What you get
- **Compare every commit with a reference:** the reference branch, a release or a milestone, metric by metric, with
  regressions in red.
- **Look at the outputs themselves:** images down to the pixel with synced zoom and diffs, videos, point clouds and
  trajectories, plots, flame graphs, test reports, logs.
- **Find the commit that changed it:** History follows a metric across commits, input by input.
- **Tune from the browser:** parameter sweeps and automated tuning (`qa optimize`, with Optuna).
- **People and agents together:** coding agents read the same results (`qaboard.runs(url)`, `qa runs`, the compare
  API) and learn the conventions from [skills](https://github.com/Samsung/qaboard/tree/master/skills). `qa gate` (experimental) fails CI when quality regresses,
  whoever wrote the change.
- **Fits your stack:** wraps any executable, runs locally, on LSF, Dask or Celery, or in CI (GitHub Actions, GitLab
  CI, Jenkins...). Open source (Apache 2.0) and self-hosted: your results stay on your network.

## Get started, with our help
We're looking for teams who track quality, and we help them get started: setting up a self-hosted server, integrating
the first projects, keeping it upgraded as results grow. Write to **arthur.flam@gmail.com**, or
[open an issue](https://github.com/Samsung/qaboard/issues).

- Try it on your computer: [the quickstart](https://samsung.github.io/qaboard/docs/get-started/quickstart).
- Put your project on it: [the tutorial](https://samsung.github.io/qaboard/docs/get-started/tutorial).
- Run it for your team: [Docker Compose or Kubernetes](https://samsung.github.io/qaboard/docs/deploy).

## Deployment

```bash
# Open-source, zero-downtime upgrades (see deployments/production.env)
deployments/deploy.py deployments/production.env up --build --init  # first time
deployments/deploy.py deployments/production.env up --build         # upgrades
# or plain docker compose
docker compose -f docker-compose.yml -f production.yml up -d

# With site-specific config (e.g. SIRC, DSK)
deployments/deploy.py deployments/sirc/production.env up
docker compose -f docker-compose.yml -f production.yml -f deployments/dsk/dsk.yml up -d
```

## Contributing
To learn about the code's organization, or how to contribute, read [CONTRIBUTING.md](CONTRIBUTING.md). Found a bug?
[Submit an issue](https://github.com/Samsung/qaboard/issues), and feel free to send pull requests to `master`.

## Contributors
QA-Board was started at [Samsung](https://www.linkedin.com/company/samsung-israel-r-d-center-sirc/) by [Arthur Flam](https://shapescience.xyz).

Thanks to the following people for their contributions, testing, feedback or bug reports: Amir Fruchtman, Avi Schori, Yochay Doutsh, Itamar Persi, Amichay Amitay, Lena Grechikhin, Gal Hai, Rivka Emmanuel, Nadav Ofer. Thanks also to Sebastien Derhy, Elad Rozin, Nathan Levy, Shahaf Duenyas, Asaf Jazcilevich and Yoel Yaffe for supporting the project.

> You don't see your name? Get in touch to be added to the list!

## Credits
- The logo is the Poodle [twemoji](https://twemoji.twitter.com/) 🐩, recolored in Samsung Blue 🔵. *Copyright 2019 Twitter, Inc and other contributors. Code licensed under the [MIT License](http://opensource.org/licenses/MIT). Graphics licensed under [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)*
