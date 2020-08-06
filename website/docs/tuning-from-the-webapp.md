---
id: tuning-from-the-webapp
sidebar_label: Tuning from QA-Board
title: Starting tuning experiments from QA-Board
---
import useBaseUrl from '@docusaurus/useBaseUrl';


## How to do tuning or trigger extra runs from QA-Board
When doing QA or during development, you often want to run the code/configs from a given commit on new tests. QA-Board lets you define and runs batches of tests with extra tuning parameters:

<img alt="Tuning from the UI" src={useBaseUrl('img/tuning-from-the-ui.jpg')} />

## Enabling tuning from QA-Board
### 1. Build artifacts
You must have defined and be using [artifacts](/storage/artifacts)

### 2. Distributed task queue
You need to configure a task runner, that will execute tuning runs asynchronously. We recommend getting started with Celery. All the details are on the [next page](celery-integration)!
