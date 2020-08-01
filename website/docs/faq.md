---
id: faq
sidebar_label: FAQ
title: Frequently Asked Questions
---
import useBaseUrl from '@docusaurus/useBaseUrl';

## There is a bug I'd like you to know about
Open an issue [here](https://github.com/Samsung/qaboard/issues), or even mail [Arthur Flam](mailto:arthur.flam@samsung.com).

## What is QA-Board written with?
- **CLI tool** (wraps your code): `python`
- **Frontend:** views with `reactjs`, state with `reduxjs`, design with `blueprintjs`, images with `openseadragon`, plots with `plotly`/`threejs`...
- **Backend**: `postgreSQL` (to store metadata) accessed via `flask`


## Does QA-Board work with `python2.7`?
Well enough! Just call `python2 your_code.py` as any other executable.

## Where are results saved?
- **Local runs** are saved under the *output/* directory in the project.
- **During CI runs**, results are saved under the `storage` defined in [*qaboard.yaml*](https://github.com/Samsung/qaboard/blob/master/qaboard/sample_project/qaboard.yaml#L119). To be honest, the exact naming conventions is complicated... **Export the data using the UI's export utilities, or ask QA-Board' simple API.** 

## Can I export the data or use a third-party viewer?
**Yes!** All the outputs are saved as files, and QA-Board provides multiple ways to get them out.

:::caution
At the moment nothing prevents your from modifying/destroying files created from the CI.
:::

1. **In the "Visualization" tab, an export utility** lets you copy-to-clipboard a path with filtered/nicely-renamed results/files: 
<img alt="Export batch outputs" src={useBaseUrl('img/export-files-viz.jpg')} />

2. **Next to each output**, there is always a button to copy-to-clipboard the path to the files it created.

<img alt="Export batch outputs" src={useBaseUrl('img/export-files-output.jpg')} />

3. **From the Navigation bar**, you can copy-to-clipboard the windows-ish path where each commit saves its results:
<img alt="Export batch outputs" src={useBaseUrl('img/export-files-commit.jpg')} />

4. You can also **programmatically access QA-Board's data** by [querying its API](api).
