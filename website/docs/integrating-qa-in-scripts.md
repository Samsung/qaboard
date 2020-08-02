---
id: apis
sidebar_label: APIs
title: QA-Board's API
---

## CLI API
If you run batches, it can be useful to know where results where saved.

```bash
qa batch my-batch –-list-output-dirs
##=> prints to STDOUT each output directory on a line
#> $some/where/place
#> $some/other/place
#> ...

qa batch my-batch –-list
##=> prints to STDOUT an array with info on each run
# [
#   {
#      "absolute_input_path": "some/file"
#      "configurations": ["my-config"],
#      "output_directory": "some/place"
#   }
# ]
```

For specific needs, you can also use `qa get` to output internal variables:

```bash
qa --input my/input get output_directory
qa get commit_id
# etc
```

## HTTP API
> **TODO:** Formalize with an [openapi/swagger spec](https://editor.swagger.io/).

It's not documented yet, but quite stable and there are no surprises.

```bash
curl -k "https://qa/api/v1/commits?project=my/project"
```

```js
[
  // --snip--
  {
    "id": "af9370b9246657e74e8e7fbd28c180b5cca7d3a7",
    "type": "git",
    "branch": "origin/my-branch",
    "parents": [
      "c976adc9020683f90d51d25c39d9e177c621dc95"
    ],
    "message": "add dynamic min subtract\n",
    "committer_name": "Rivka E",
    "committer_avatar_url": "http://gitlab-srv/uploads/-/system/user/avatar/164/avatar.png",
    "authored_datetime": "2019-04-30T09:05:09+00:00",
    "authored_date": "2019-04-30",
    "data": null,
    "repo_artifacts_url": "/s/commit/dir/url",
    "artifacts_url": "/s/commit/dir/url/maybe/subproject", //placeholder...
    "batches": {
      "default": {
        "id": 19172,
        "commit_id": "af9370b9246657e74e8e7fbd28c180b5cca7d3a7",
        "label": "default",
        "created_date": "2019-04-30T09:08:59.962664",
        "data": {
          "type": "ci"
        },
        "batch_dir_url": "/s/some/directory/output",
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
curl -k "$base_url/commit/01c27dfc4ffbf93ce95639b4dfbc126da4c53053?project=my/project" | jq
```

```js
{
  "id": "2032a39564281de429e667260d1def3d16980e01",
  "type": "git",
  "branch": "origin/InvestigateCompression",
  "parents": [
    "93b0a95d0ceaa78d24be33bea67a4aa333491c23"
  ],
  "message": "1. PARAMETERIZE compression\n2. add XX package\n",
  "committer_name": "Rivka E",
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
  "repo_artifacts_url": "/s/commit/dir/url",
  "artifacts_url": "/s/commit/dir/url/maybe/subproject", //placeholder...
  "batches": {
    "default": {
      "id": 19071,
      "commit_id": "2032a39564281de429e667260d1def3d16980e01",
      "label": "default",
      "created_date": "2019-04-28T13:27:28.119816",
      "data": {
        "type": "ci"
      },
      "batch_dir_url": "/s/some/directory/output",
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
          "configuration": "base_XXX",
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
          "batch_dir_url": "/s/some/directory/output",
          "test_input_database": "/db/XX",
          "test_input_path": "LSC/M01",
          "test_input_tags": []
        },
        // --snip--
      }
    }
  },
  "time_of_last_batch": "2019-04-28T12:55:51+00:00"
}

```

