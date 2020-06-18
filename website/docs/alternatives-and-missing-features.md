---
id: alternatives-and-missing-features
sidebar_label: Alternatives
title: Alternatives and missing features
---


## Non-features
QA-Board works with other tools. It won't replace or provide:
- **Automation:** we're not a CI tool, and won't provide logic needed to create build pipelines, or decide when to run what. In a CI system, QA-Board is just a standard executable, `qa`. If you're looking for a CI plaform, consider [GitlabCI](https://docs.gitlab.com/ee/ci/) or [DroneCI](https://github.com/drone/drone).
- **Execution Environment:** if you need containers, install the QA-Board CLI as a dependency, or implement the logic needed within your code. As of now, the only help QA-Board gives is support for [*.envrc* files](https://direnv.net/). Implementing more types of `qa batch` "runners" might fill the gap here.
- **Monitoring & Deployement**: in this space solutions tend to be custom of industry specific. Get in touch if you see low-hanging fruits!
- **Data Versionning**

## Some planned features
- **Pipelines / DAG**, needed for calibration/training->evaluation pipelines. *But stay tuned, we're working on that!*
- **1 vs N comparaisons** versus only pairs of versions.
- **More Viewers**: [vega/altair](https://vega.github.io/vega/), links to open with notebooks, [visdom](https://github.com/facebookresearch/visdom), [webiz](https://webviz.io/)...
- **Users** for login, and commenting on results.
We also plan to introduct a number of smaller features

## Why not use X instead?
- Most comparable tools focus on **training for machine learning** (`sacred`, `nni`, `mlflow`, `tensorboard`, `polyaxon`...). Our use cases revolve around qualitative outputs for a wide range of algorithms. It means we *need* flexible visualizations. This said, those tools are great too! They often have features that QA-Board is still missing (labelling and commenting outputs, better GUI in some respects). Many of the commercial solutions (`cometML`, `convrg.io`, `netpune.ai`...) can provide a lot of value too, depending on your use-case  and the size/maturity of your organization.
- **Notebooks** are amazing for experimentation and r&d reporting, but are not easy to compare and manage. 
- [`tensorboard`](https://www.tensorflow.org/tensorboard) has a lot of qualities, but it doesn't scale to many experiments, doesn't know about `git`, and is not persistent. We may integrate an "Open in Tensorboard" button, ask about it and stay tuned. As for `visdom`, it's great for experimenting, less to store historical information.
