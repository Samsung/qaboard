---
id: debugging-runs-with-an-IDE
title: Debugging QA-Board' runs in an IDE
sidebar_label: Debugging with IDEs
---
import useBaseUrl from '@docusaurus/useBaseUrl';

## How to debug runs
In most cases you want to debug code and set breakpoints inside your `run()` function. That means you want to debug individual **runs**, not a whole batch.

:::tip
If you try to debug the `qa batch` command, your debugger will not be able to attach to the runs. Those at best will happen in a different subprocess (if using `qa batch --runner=local`), and at worst on a different computer (if using distributed job schedulers).
:::

To know what `qa run` command you need to debug, you can:
- Look at the logs of your run in the web UI: it's at the top.
- Run `qa --dryrun batch xxxx` to just print the individual `qa run` commands executed in a batch.

## Debugging with PyCharm
Edit your "debug configurations" like this:

- **Module name:** `qaboard` *(make sure you select "module" not "script" in the dropdown menu).*
- **Parameters:** CLI parameters for `qa`: **`run -i images/A.jpg`**. Don't write `qa`, and make sure you debug a `run` command, not a batch.
- **Working directory:** Check it’s defined as the directory with *qaboard.yaml*. If this directory happens to have a subfolder named "qaboard", use it.

<img alt="pyCharm setup" src={useBaseUrl('img/pycharm-debugging-setup.png')} />

> In some cases you'll also need to define as environment variables `LC_ALL=en_US.utf8 LANG=en_US.utf8`

## Debugging with VSCode
To configure debugging, the editor opens a file called *launch.json*. You want to add configurations that look like those:

```json
{
  "name": "qaboard",
  "type": "python",
  "request": "launch",
  "module": "qaboard",
  "args": [
    "--", // needed...
    "--help",
  ]
},
```

To debug `qa run`, for instance:
```json
  "args": [
    "--",
    "--database",
    ".",
    "run", // don't debug "qa batch" command
    "--input",
    "tv/tv_GW1_9296x256_REMOSAIC_V1_FULL_X_HP_PDA1",
  ]
```

Here is a more in-depth review of your options at https://code.visualstudio.com/docs/python/debugging
