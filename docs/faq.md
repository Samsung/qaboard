---
id: faq
sidebar_label: FAQ
title: Frequently Asked Questions
---

## There is a bug I'd like you to know about
[Arthur Flam](mailto:arthur.flam@samsung.com), `054-706-2015`.

## What is qatools written with?
- **CLI tool** (wraps your code): `python`
- **Frontend:** views with `reactjs`, state with `reduxjs`, design with `blueprintjs`, plots with `plotly` and `threejs`, images with `openseadragon`.
- **Backend**: `postgreSQL` (to store metadata) via `flask`

## Why not use X instead?
- Most comparable tools focus on **training for machine learning** (`sacred`, `mlflow`, `tensorboard`, `polyaxon`, `cometML`). Our use cases revolve around qualitative outputs. It means we *need* flexible visualizations. This said, those tools are great too! They often have features that qatools is still missing (labelling and commenting outputs, live logs, better GUI in some respects).
- **Notebooks** are amazing for experimentation and r&d reporting, but are not easy to compare and manage. 
- **Tensorboard** has a lot of qualities, but it doesn't scale to many experiments, doesn't know about `git`, and is not persistent. We may integrate an "Open in Tensorboard" button, ask about it and stay tuned.

## Does qatools work with `python2.7`?
Yes, just wrapp a system call to your EOL python. 

## Where are results saved?
- **Local runs** are saved under the *output/* directory in the project.
- **During CI runs**, results are saved under the `ci_root` defined in [*qatools.yaml*](http://gitlab-srv/common-infrastructure/qatools/blob/master/qatools/sample_project/qatools.yaml#L119). To be honest, the exact naming conventions is complicated... **Export the data using the UI's export utilities, or ask qatools' simple API.** 

## Can I export the data or use a third-party viewer?
**Yes!** All the outputs are saved as files, and qatools provides multiple ways to get them out.

:::caution
At the moment nothing prevents your from modifying/destroying files created from the CI.
:::

1. **In the "Visualization" tab, an export utility** lets you copy-to-clipboard a path with filtered/nicely-renamed results/files: 
![Export batch outputs](https://qa/s/qatools/img/export-files-viz.jpg)

2. **Next to each output**, there is always a button to copy-to-clipboard the path to the files it created.

![Export batch outputs](https://qa/s/qatools/img/export-files-output.jpg)

3. **From the Navigation bar**, you can copy-to-clipboard the windows-ish path where each commit saves its results:
![Export batch outputs](https://qa/s/qatools/img/export-files-commit.jpg)

4. You can also **programmatically access qatools's data** by querying its API. While it's not documented (yet), it's not complicated:

```bash
curl -k "https://qa/api/v1/commits?project=tof/swip_tof" | jq
```

```js
[
  // --snip--
  {
    "id": "af9370b9246657e74e8e7fbd28c180b5cca7d3a7",
    "type": "git",
    "branch": "origin/HM1_develop",
    "parents": [
      "c976adc9020683f90d51d25c39d9e177c621dc95"
    ],
    "message": "add dynamic min subtract\n",
    "committer_name": "Rivka Emanuel",
    "committer_avatar_url": "http://gitlab-srv/uploads/-/system/user/avatar/164/avatar.png",
    "authored_datetime": "2019-04-30T09:05:09+00:00",
    "authored_date": "2019-04-30",
    "data": null,
    "commit_dir_url": "/s//stage/algo_data/ci/LSC/Calibration/commits/1556615109__Rivka Emanuel__af9370b9",
    "repo_commit_dir_url": "/s//stage/algo_data/ci/LSC/Calibration/commits/1556615109__Rivka Emanuel__af9370b9",
    "batches": {
      "default": {
        "id": 19172,
        "commit_id": "af9370b9246657e74e8e7fbd28c180b5cca7d3a7",
        "label": "default",
        "created_date": "2019-04-30T09:08:59.962664",
        "data": {
          "type": "ci"
        },
        "output_dir_url": "/s/stage/algo_data/ci/LSC/Calibration/commits/1556615109__Rivka Emanuel__af9370b9/output",
        "aggregated_metrics": {},
        "valid_outputs": 0,
        "pending_outputs": 0,
        "running_outputs": 0,
        "failed_outputs": 2
      }
    },
    "time_of_last_batch": "2019-04-30T09:05:09+00:00"
  },
  // --snip--
]
```

```bash
curl -k "$base_url/commit/01c27dfc4ffbf93ce95639b4dfbc126da4c53053?project=tof/swip_tof" | jq
```

```js
{
  "id": "2032a39564281de429e667260d1def3d16980e01",
  "type": "git",
  "branch": "origin/InvestigateCompressionGW1",
  "parents": [
    "93b0a95d0ceaa78d24be33bea67a4aa333491c23"
  ],
  "message": "1. PARAMETERIZE compression\n2. add gw1 package\n",
  "committer_name": "Rivka Emanuel",
  "committer_avatar_url": "http://gitlab-srv/uploads/-/system/user/avatar/164/avatar.png",
  "authored_datetime": "2019-04-28T12:55:51+00:00",
  "authored_date": "2019-04-28",
  "data": {
    "qatools_config": {
      // --snip
     },
    "qatools_metrics": {
      // --snip
     }
  }
  "commit_dir_url": "/s//stage/algo_data/ci/LSC/Calibration/commits/1556456151__Rivka Emanuel__2032a395",
  "repo_commit_dir_url": "/s//stage/algo_data/ci/LSC/Calibration/commits/1556456151__Rivka Emanuel__2032a395",
  "batches": {
    "default": {
      "id": 19071,
      "commit_id": "2032a39564281de429e667260d1def3d16980e01",
      "label": "default",
      "created_date": "2019-04-28T13:27:28.119816",
      "data": {
        "type": "ci"
      },
      "output_dir_url": "/s/stage/algo_data/ci/LSC/Calibration/commits/1556456151__Rivka Emanuel__2032a395/output",
      "aggregated_metrics": {},
      "valid_outputs": 1,
      "pending_outputs": 2,
      "running_outputs": 1,
      "failed_outputs": 2,
      "outputs": {
        "350582": {
          "id": 350582,
          "output_type": "",
          "platform": "windows",
          "configuration": "base_2X5",
          "extra_parameters": {},
          "metrics": {
            "is_failed": false,
            "compute_time": 30.1366302967
            "OTP_size_CrossTalk": 1040,
            "OTP_size_DayLight50": 464,
            // --snip
          },
          "is_failed": false,
          "is_pending": false,
          "is_running": false,
          "data": {
            "ci": true
          },
          "output_dir_url": "/s//stage/algo_data/ci/LSC/Calibration/commits/1556456151__Rivka Emanuel__2032a395/output/windows/base-2x5/Truly_LSC_DB/M01",
          "test_input_database": "\\\\netapp\\QA-Data\\2X5",
          "test_input_path": "Truly_LSC_DB\\M01",
          "test_input_tags": []
        },
        // --snip--
      }
    }
  },
  "time_of_last_batch": "2019-04-28T12:55:51+00:00"
}

```

