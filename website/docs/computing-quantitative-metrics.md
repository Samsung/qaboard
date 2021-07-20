---
id: computing-quantitative-metrics
sidebar_label: Metrics
title: Computing quantitative metrics
---
import useBaseUrl from '@docusaurus/useBaseUrl';

Algorithms are usually evaluated using KPIs / Objective Figures of Merit / metrics. To make sure QA-Board's web UI displays them:

1. `run()` should return a dict of metrics:
```python title="qa/main.py"
def run():
    # --snip--
    return {
        "loss": loss
    }
```

:::tip
Alternatively, you can also write your metrics as JSON in `ctx.obj['output_directory'] / metrics.json`.
:::

2. Describe your metrics in *qa/metrics.yaml*. Here is an example

```yaml title="qa/metrics.yaml (location from qaboard.yaml: outputs.metrics)"
available_metrics:
  loss:  # the fields below are all optionnal
    label: Loss function     # human-readable name
    short_label: Loss        # somes part of the UI are better with thin labels...
    smaller_is_better: true  # default: true
    target: 0.01             # plots in the UI will compare KPIs versus a target if given
    target_passfail: false   # the UI will render the metric as green/red depending on above/below the target
    # when displaying results in the UI, you often want to change units
    # suffix: ''   # e.g. "%"...
    # scale: 1     # e.g. 100 to convert [0-1] to percents...
    # by default we try to show 3 significant digits, but you can change it with
    # precision: 3
```

If it all goes well you get:

- Tables to compare KPIs per-input across versions:

<img alt="https://qa/tof/swip_tof/commit/42778afb1fea31e19c00291a2a52bf490e3acc2c?reference=a451dda9cfdd586702ead95f436e41c5b074ebfa&selected_views=summary&filter=old" src={useBaseUrl('img/quantitative-metrics.png')} />

- Summaries:

<img alt="https://qa/tof/swip_tof/commit/42778afb1fea31e19c00291a2a52bf490e3acc2c?reference=a451dda9cfdd586702ead95f436e41c5b074ebfa&selected_views=summary&filter=old" src={useBaseUrl('img/summary-metrics.png')} />

- Metrics integrated in the visualizations:
<img alt="https://qa/tof/swip_tof/commit/42778afb1fea31e19c00291a2a52bf490e3acc2c?reference=a451dda9cfdd586702ead95f436e41c5b074ebfa&selected_views=output-list&filter=old%20low%204ta" src={useBaseUrl('img/quantitative-metrics-on-viz.png')} />

- and evolution over time per branch...

:::note
We plan on not requiring you to define metrics ahead of time.
:::

## Special "metrics"
- `{"is_failed":True}` will have QA-Board consider the run as "failed". The main uses cases are:
  * simplifying the control flow, instead of raising an exception from `run()`
  * failing runs that don't achieve a target quality
  * remembering if the `run` was successful, when users split between `run/postprocess` stages
- `{"params": {...}}` makes it possible to display dynamic as "parameters" in the UI. The use-cases are:
  * taking as configuration a unique machine learning model ID, then make it easy to view/filter its hyperparameters

It is possible to **display badges** next to runs:

```python
return {
    "params": {
        "badges": [
            {
                "text": "link to training",
                # link to somewhere
                "href": "https://example.com",
                # must be selected from [blueprint's](https://blueprintjs.com/docs/#icons)
                "icon": "settings",
                # you can also tweak the [blueprint Tag](https://blueprintjs.com/docs/#core/components/tag) with `intent`, `style`, `large`, `minimal`
            }
        ]
    }
}
```

The main use case for badges is linking to the training log of a machine learning model from the inference results. It enables smooth workflows between QA-Boad and other run-trackers focused on deep learning.