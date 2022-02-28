---
id: tuning-from-the-webapp
sidebar_label: Tuning from QA-Board
title: Starting tuning experiments from QA-Board
---
import useBaseUrl from '@docusaurus/useBaseUrl';


## How to do tuning or trigger extra runs from QA-Board
When doing QA or during development, you often want to run the code/configs from a given commit on new tests. QA-Board lets you define and runs batches of tests with extra tuning parameters:

<iframe style={{maxWidth: "560px"}} height="315" src="https://www.youtube.com/embed/XN71PBr0Rvg" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>

<!-- <img alt="Tuning from the UI" src={useBaseUrl('img/tuning-from-the-ui.jpg')} /> -->

## Enabling tuning from QA-Board

:::note
Tuning parameters that will be merged into `context.params` and appended to `context.configs`: in most cases you don't have to do anything special
:::

### 1. Build artifacts
You must have defined and be using [artifacts](artifacts)

### 2. Distributed task queue
You need to configure a task runner, that will execute tuning runs asynchronously. QA-Board ships with a `celery` integration so you'll just have to register a "worker" to get started. [Read more here](celery-integration)!
