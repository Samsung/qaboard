# qatools
Qatools helps algorithm and QA engineers build great products with powerful quality evaluation tools:

- **Focus on improving and experimenting algorithms**, not worrying about the QA infrastructure.
- **Simple to Start** qatools is built to be easy to get up and running in as little time possible. We've built a sample configuration generator, examples for common use use cases. Helpful error messages guide you in case of errors.
- Make it easy to **compare** different algorithms, configurations, **tune/optimize**, and **share** results.
- **Visualizations**: qatools can display quantitative metrics, and also ships with an advanced image viewer, support for videos, plotly graphs, text, pointclouds, embedded HTML...
- **Integrated** with version control (`git`), CI tools (`GitlabCI`, `Jenkins`...) and SIRC's `lsf` cluster, but **Unopiniated**: it doesn't care about your algorithm framework, language, how you define your tests, or in what format your results should be.

> Take a look at [SIRC's qatools server](https://qa)

## Installation
> qatools is already installed on SIRC's vdi servers
> Install your own to easily use custom python packages.

Qatools is installable via `pip`:

```bash
pip install --upgrade git+ssh://git@gitlab-srv/common-infrastructure/qatools
# If you have SSL/certificates/trust errors, use --trusted-host pypi.python.org --trusted-host pypi.org --trusted-host files.pythonhosted.org
# If you have timeouts, not authorized, proxy errors, or "this is not a git repo error", use --proxy http://dlp2-wcg01:8080 # in case of proxy issues (TIMEOUT error) in case of SSL/proxy issues
```

## Getting Started
```bash
qa init
```

For the rest, [read the docs!](http://qa-docs).


## Contributing
> Merge requests are welcomed, and don't hesitate to create issues, or contact [Arthur Flam](mailto:arthur.flam@samsung.com)

qatools is split into:

1. the [CLI application](https://gitlab-srv/common-infrastructure/qatools) that wraps your code. To work on it:
```bash
git clone  git@gitlab-srv:common-infrastructure/qatools
cd qatools
pip install --editable .
```
2. the [web application](https://gitlab-srv/dvs/slamvizapp) that displays results.
3. the [API server](https://gitlab-srv/dvs/slamvizapp) that exposes a database with all the data.


## Why not X instead?
- Most comparable tools focus on **training for machine learning** (`sacred`, `mlflow`, `tensorboard`, `polyaxon`, `cometML`). Our use cases revolve around qualitative outputs. It means we *need* flexible visualizations. This said, those tools are great too! They often have features that qatools is still missing (labelling and commenting outputs, better GUI in some respects).
- **Notebooks** are amazing for experimentation and r&d reporting, but are not easy to compare and manage. 
- **Tensorboard** has a lot of qualities, but it doesn't scale to many experiments, doesn't know about `git`, and is not persistent. We may integrate an "Open in Tensorboard" button, ask about it and stay tuned.
