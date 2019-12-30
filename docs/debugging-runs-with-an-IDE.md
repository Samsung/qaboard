---
id: debugging-runs-with-an-IDE
title: Debugging qatools' runs in an IDE
sidebar_label: Debugging with IDEs
---

## Debugging with PyCharm
Edit your "debug configurations" like this:

- **Module name:** qatools (not script name)
- **Parameters:** CLI parameters for qa
- **Working directory:** check it’s defined as your project's. (**If the working directory happens to have a subfolder named "qatools", use instead that "qatools" subfolder as working directory to avoid confusion)

![pyCharm setup](http://gitlab-srv/common-infrastructure/qatools/uploads/e799a84559ca42b5b8da0bb609245721/pycharm-debugg.png)

> In some cases you'll also need to define as environment variables `LC_ALL=en_US.utf8 LANG=en_US.utf8`

## Debugging with VSCode
To configure debugging, the editor opens a file called *launch.json*. You want to add configurations that look like those:

```json
{
  "name": "qatools",
  "type": "python",
  "request": "launch",
  "module": "qatools",
  "args": [
    "--", // needed...
    "--help",
  ]
},
```

```json
{
  "--",
  "--inputs-database",
  ".",
  "run",
  "--input-path",
  "tv/tv_GW1_9296x256_REMOSAIC_V1_FULL_X_HP_PDA1",
}
```

Here is a more in-depth review of your options at https://code.visualstudio.com/docs/python/debugging
