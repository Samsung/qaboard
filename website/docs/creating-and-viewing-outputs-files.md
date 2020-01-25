---
id: creating-and-viewing-outputs-files
sidebar_label: Outputs
title: Creating and viewing outputs files
---

1. Write anything in `ctx.obj["output_directory"]`: text, images, logs, pointclouds...
2. View in the web interface a list of all those files in the "Output Files" tab!
3. Click on a file to open it:

![https://qa/tof/swip_tof/commit/42778afb1fea31e19c00291a2a52bf490e3acc2c?reference=a451dda9cfdd586702ead95f436e41c5b074ebfa&selected_views=bit_accuracy](/img/output-files.png)

QA-Board will try to guess the right file viewer depending on the extension. Many are available, read the [Read the visualizations guide](visualizations) to learn more.

> **"Visualizations"** can help you declare pre-sets of relevant files. [Read the docs](visualizations) to learn more!

## Accessing output files
All the outputs are saved as files. To get them out and qatools provides multiple ways to get them out.

1. **Next to each output**, there is always a button to copy-to-clipboard the path to the files it created.

![Export batch outputs](/img/copy-windows-output-dir.png)

2. **From the Navigation bar**, you can copy-to-clipboard the windows-ish path where each commit saves its results:
![Export batch outputs](/img/export-commit-folder.png)

