---
title: Introducing QA-Board
author: Arthur Flam
author_url: https://shapescience.xyz/
author_title: Algo engineering at Samsung
author_image_url: https://media-exp1.licdn.com/dms/image/C4D03AQFO_tBlzPZ4ug/profile-displayphoto-shrink_400_400/0?e=1602720000&v=beta&t=35CS2a0jRg32mhVbwpqbddP8HJsFp75hLeQJjAHQHCw
tags: [qualityOps, engineering]
# description: Some description
# image: https://example.com/image.png
---

We are happy to introduce [QA-Board](samsung.github.io/qaboard), a run-tracker with advanced visualizations for algorithm and software engineers.

<!--truncate-->


<p align="center">
  <img alt="QA-Board logo" width={400} src="https://user-images.githubusercontent.com/2649055/86829138-bb6aef00-c09c-11ea-8b59-78b7fc44ebcf.png"/>
</p>


## Tracking quality is hard
_Tests are not enough_ when the focus is quality and performance. Whether you need to improve algorithms or make performance-sensitive code more efficient, all sorts of metrics and visualizations are required. Engineers usually start this evaluation process by writing scripts or notebooks that test their solution on limited samples. They then look at the results and iterate.

While it's very convenient at first, very soon keeping track of versions or comparing features gets challenging. There are a lot of "logistics" to get right:
- How to share results?
- What about source control and CI integration?
- How to start distributed tuning experiments?
- How to identify regressions?

> We wanted to solve those recurrent issues with a simple solution adaptable to many projects.


## QA-Board's story
Our business unit develops IP for image sensors. What was a closely-knit 15 person team became a 250-person organization. The complexity and pace of our projects kept growing. As you may know, Samsung is now working on image sensors with groundbreaking resolution (over 108MP!), capable of AI and packed with innovative features.

> [We're hiring](https://samsung-careers.co.il/) - our goal is to become the 1st image sensor manufacturer worldwide.

As we were experiencing growing pains in our development processes, we set up a team to change the way we work. What we emphasized were software-engineering best practices, infrastructure, reproducibility, and our mission to improve cross-team collaboration.

As part of our work on algorithms for our [innovative DVS sensor](http://rpg.ifi.uzh.ch/docs/CVPR19workshop/CVPRW19_Eric_Ryu_Samsung.pdf), I had created what became QA-Board. When I joined this new team we expanded QA-Board's scope.

## Use-Cases
QA-Board has become a key collaborative tool. Our main use-cases are:
- **Sharing** links with all the info (command, output files, logs...).
- **Work-from-home**: engineers can share 108MP+ images thanks to the [IIIF protocol](https://github.com/IIIF/awesome-iiif).
- **Performance engineering**: save [`rr`](https://rr-project.org/)/[`perf`](http://www.brendangregg.com/perf.html) recordings, view [flame graphs](http://www.brendangregg.com/flamegraphs.html) and track metrics for regressions.
- **Integration**: links to and from git repositories and their Continuous Integration. From QA-Board, users can [directly access](https://samsung.github.io/qaboard/docs/triggering-third-party-tools) build artifacts, trigger automated jobs, and when needed they can build dashboards or scripts they query QA-Board's API.
- **Visualizations**: everything can be compared, and thanks to the [many different types of visualizations](https://samsung.github.io/qaboard/docs/visualizations) (images/plots/text/html/video...), users can easily create the reports they need.
- **Tuning**: QA-Board distributes runs to our cluster. Users can easily start tuning experiments that enable feature flags or tweak parameters. We've integrated [scikit-optimize](https://scikit-optimize.github.io/) for black-box optimization.
- **Regression**: users can check the progress on various metrics, and when needed, identify which commit caused a regression.

> If you are looking for screenshots, go to the [home page](https://samsung.github.io/qaboard/), or read this presentation:

> TODO SLIDESHARE

## What's next?
Our goal is to make QA-Board the best general-purpose run-tracker. We want to see it used for performance optimization, algorithm development, model comparaisons in operational research, web page performance tracking...

To achieve those goals, we'll need:
- **User feedback**, issues and feature requests. 
- **Community contributions**, for instance integrating more file viewers: e.g. support for common plot formats like vega or highcharts...

:::note How to get in touch?
Join our [issue tracker](https://github.com/Samsung/qaboard/issues) to report bugs or suggest features, or feel free to [start a chat](https://spectrum.chat/qaboard) with [the maintainers](mailto:arthur.flam@samsung.com).
:::

## How to get started using QA-Board?
[Head over to the docs](https://samsung.github.io/qaboard/docs/installation). If you run into issues contact us: we'll help you.
