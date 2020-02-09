# QA-Board
**QA-Board** helps Algorithms/QA engineers build great products with powerful *quality evaluation* and *collaboration* tools.

> QA-Board is the main collaborative tool for ~20 projects. [Take a look at SIRC's live server](https://qa) 😊👓

## Features
- **Organize, View and Compare Results**, **Tuning/Optimization**
- **Web-based:** sharable URLs, no install needed.
- **Visualizations:** support for quantitative metrics, and many file formats: advanced image viewer, support for videos, plotly graphs, text, pointclouds, embedded HTML...
- **Integrations:** direct access from Git/CI, easily exportable results, API, links to the code, trigger jobs...

## Achieved Benefits
- **Scale R&D:** enable engineers to achieve more and be more productive.
- **Faster Time-to-Market:** collaboration across teams, workflow integration..
- **Quality:** uncover issues earlier, KPIs, tuning, reporting...

## Getting Started
[Read the docs!](http://qa-docs/docs/installation) You will learn how to:
- install QA-Board's CLI wrapper
- run a QA-Board server
- wrap your code with QA-Board
- view output files and KPIs
- ...and improve your integration with many guides: bit-accuracy, tuning, etc.

## Code organization
Each section has its own README:
- [qatools](qatools): provides the `qa` CLI wrapper than runs your code, and the `import qatools` package.
- [qaboard-webapp](qaboard-webapp/) is the frontend that displays results.
- [qaboard-backend](qaboard-backend/) exposes an HTTP API used to read/write all the metadata on runs.
- [thirdparty](thirdparty/):
  * [Cantaloupe](https://medusa-project.github.io/cantaloupe/) IIIF server, used to "stream" large images to the users.

> **WIP:** we're merging multiple repos into one, expect those path to not be 100% accurate! 

## Contributing
> Merge requests are welcomed, and don't hesitate to create issues! For a quick chat do contact [Arthur Flam](mailto:arthur.flam@samsung.com)


## Licensing
- The logo is a the Poodle [twemoji](https://twemoji.twitter.com/) 🐩, recolored in Samsung Blue 🔵. *Copyright 2019 Twitter, Inc and other contributors. Code licensed under the [MIT License](http://opensource.org/licenses/MIT). Graphics licensed under [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)*