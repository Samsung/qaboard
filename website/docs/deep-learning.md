---
id: deep-learning
sidebar_label: Deep Learning & MLOps
title: Deep Learning & MLOps Workflows
---
import useBaseUrl from '@docusaurus/useBaseUrl';

Amazing tools exist for the R&D/training phase (like [wandb.ai](https://wandb.ai/)). They let you create easily create experiments without worrying about version control, without to setup a projects, and they have features that QA-Board doesn't have (compare N training curves at the same time, early stopping, nice reports built-in...).

However, in our experience, tools built for _training_ usually lack important features to evaluate inference:
- going in depth into specific difficult inputs (in our case images...): the training loss doesn't tell the whole picture
- comparing versus reference/previous versions
- giving users tools to trigger runs on new inputs (e.g. test database supplied by client)
- integration with source control, CI systems, etc
- rich/custom visualization

For instance here is how users can compare runs in QA-Board:
<img alt="wand experiments" src={useBaseUrl('img/deep-learning/side-video.gif')} />
<img alt="wand experiments" src={useBaseUrl('img/deep-learning/side-frames.gif')} />

So how do we use QA-Board and deep learning tools? Well, we setup our projects to have them work well together.

## Workflows
Since training is best done with dedicated tools, our projects are setup to show in QA-Board:
- the evaluation metrics
- model parameters and training summary
- link to the training page

<img alt="wand experiments" src={useBaseUrl('img/deep-learning/qa-wand-infoa.png')} />

In practice:

<img alt="wand experiments" src={useBaseUrl('img/deep-learning/qa-link-wandb.gif')} />

Users get the best of both worlds: QA-Board, and the experiement/training-loss UI from `wandb`...

<img alt="wand experiments" src={useBaseUrl('img/deep-learning/wandb-experiments.png')} />
<img alt="wand experiments" src={useBaseUrl('img/deep-learning/wandb-metrics.png')} />

### What is needed to make this work?
Users will write a `run()` function that:
1. Reads from `context.params` some model ID (or defaults to the model that was trained for the commit)
2. Fetches details about that model from some API: hyper-params, link to the training page... It will return those [as badges](computing-quantitative-metrics#metrics-shown-as-a-run-time-configuration)
3. Runs the model on the `context.input_path`
4. Does postprocessing to compute various evaluation metrics/plots

<img alt="wand experiments" src={useBaseUrl('img/deep-learning/filter.gif')} />

:::tip
Some engineers have a script that filters/sort their recent models according to various hyperparams/metrics, and start evaluation with QA-Board... Ideally we should be able to trigger directly inferences from the training page but not all ML tools make it easy!
:::

## MLOps
When using MLops flows, users will have the CI:

1. **Train** a network
2. **Fail** if the training loss is too high
3. **Run inferences** on an evaluation batch using QA-Board
4. **Fail** if the evaluation metrics are bad
