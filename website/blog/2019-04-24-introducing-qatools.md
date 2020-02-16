---
title: "Introducing QA-Board: R&D Platform"
author: Arthur Flam
authorURL: https://shapescience.xyz/
authorFBID: 508446717
---

## What is qatools made of?
- a client library
- ..a web application that displays results.

Icon? Maybe ask samsung design. Chekc github how they do it....
- papillon (spent a lot of effort preparing), chrysalide
- diamond (too common?)
- bar char (too simple)
- boxplot (hard to recognize? geek? narrow)
- caniche (looking good?)
- colorful fish, bird.
- Etoile de mer?

Check: CometML docs, polyaxon, MLflow, NNI microsoft

![cool image](#)



We are very happy to introduce [qatools](#) to help algorithm enginneers build products with powerful QA tools.

We created [qatools](#) for the following reasons:

- Focus on experimenting algorithms, not worrying about the QA infrastructure.
- Most comparable tools focus on training for machine learning. Our use cases revolve around qualitative outputs. Hence, we feature advanced visualizations: out-of-the-box viewers for images, pointclouds, plotly, HTML, etc.
- Make it easy for engineers and QA to compare different algorithms, configurations, perform tuning, and share their results.
And, finally, to provide a consistent look and feel across QA for all of our algorithms projects.

## How does Docusaurus work?
https://docusaurus.io/blog/2017/12/14/introducing-docusaurus

## qatools may not be a great fit
- You want reporting, integraton with git

- Need 

- Shared and persistent database of results. Tensorboard is temporary
- Need to handle multiple projects
- Doing low-level optimization or hardware design: you need to worry about (1) bit-accuracy of the new code (2) tools to understand your tradeoffs 

## qatools may not be a great fit for you if
It is a step above notebooks
- you need to manage long training sessions, and need live training feedback
- you

# What you still need   to integrate with qatools
- task-runner infrastructure: internally we use X. TODO: sample Celery integration.
- deployment infrastructure
- model and database versionning
- CI: qatools doesn't do automation, triggers... Your CI should call it.


## Usage
Follow the [tutorial](http://gitlab-srv/common-infrastructure/qatools/wikis/step-by-step-tutorial).
How does it work, concretely?
- You need to write a `run()` python function that wraps your code. It gives you a CLI interface (eg `qa run --input my_input`) for local development.
- A configuration file, *qaboard.yaml*, describes metadata like how to find your inputs, what outputs and metrics you expect, etc.
- ... after init, print link to the project's integration page
- ? need to start server first ? (docker commands), qa init should get the URL, unless we default to the hosted version. Still need stuff like git permissions to clone, project namespace... (maybe provide a deploy key, or setup as a 2FA application? maybe offer inputs, with default...)
- API if no results, None, just 200 empty list...
- Results are automatically



## open source tech blocker
- rename dvs/backend => qatools/frontend + qatools/backend; common-infrastrcture/qatools => qatools/cli
- storage: need to review linux/windows: offer eg s8, make it clearer
- github integration, per-project repo host, permissions, integrations like user pictures...
- replace lsf with eg celery, make it pluggable (qatools[lsf]), so also need to carve it out of the server...
- grep arthurf, grep dvs, grep tof...
- unified devops: docker compose the 2 IIFS, the server, terminate https once...

## CI
```bash
ssh ispq@ispq-vdi
bash
export GITLAB_RUNNER=1
export GITLAB_PROJECT=qatools
export GITLAB_TOKEN="xxxxxxxx"
```


Getting Started
- Installation
- => readme
- qa init
CLI features
- `qa run`, how to find tests, `run()`
- recipies for the run function:
  * command, docker, direct python
  * platform, android...
- `qa batch`, groups of tests
- `qa check-bit-accuracy` 
- CI integration: `qa get --input output_directory`
Visualizations
Tuning from the web UI
- needed: artifacts, define and save
- tuning
- optimization
- custom env? docker?

Guides
- working with sub-projects
- bit-accuracy: custom inputs
- generating reports, exporting/re-using results: API
- inputs metadata: computing custom metrics per test
- Machine learning: working on whole databases
- Creating meta-benchmarks (TODO)

Admin Guides
- Starting a qatools server / restarting the server
- qatools's own CI
- database backups


- create sample docs structure with empty files
- add pages with the wiki
- serve docs on https://qa/docs
- remove wiki (point to docs)