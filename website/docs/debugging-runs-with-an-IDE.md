---
id: debugging-runs-with-an-IDE
title: Debugging QA-Board' runs in an IDE
sidebar_label: Debugging with IDEs
---
import useBaseUrl from '@docusaurus/useBaseUrl';

## Debugging with PyCharm
Edit your "debug configurations" like this:

- **Module name:** `qaboard` *(make sure you select "module" not "script" in the dropdown menu).*
- **Parameters:** CLI parameters for `qa`: **`run -i images/A.jpg`**.
- **Working directory:** Check it’s defined as the directory with *qaboard.yaml*. If this directory happens to have a subfolder named "qaboard", use it.

<img alt="pyCharm setup" src={useBaseUrl('img/pycharm-debugg.png')} />

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

```json
{
  "--",
  "--database",
  ".",
  "run",
  "--input",
  "tv/tv_GW1_9296x256_REMOSAIC_V1_FULL_X_HP_PDA1",
}
```

Here is a more in-depth review of your options at https://code.visualstudio.com/docs/python/debugging
