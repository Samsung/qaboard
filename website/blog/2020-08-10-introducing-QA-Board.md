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

We are happy to introduce [QA-Board](samsung.github.io/qaboard) ([source](https://github.com/samsung/qaboard)), a run-tracker with advanced visualizations for algorithm and software engineers.

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
Our business unit develops IP for image sensors. What was a closely-knit 15 person team became an over-300-person organization. The complexity and pace of our projects kept growing. As you may know, Samsung is now working on image sensors with groundbreaking resolution (200MP and beyond), capable of AI and packed with innovative features, including cutting-edge image processing IPs.

> [We're hiring at Samsung's Israel R&D Center](https://samsung-careers.co.il/?coref=1.10.rA7_407&t=1597396535199) - our goal is to become the 1st image sensor manufacturer worldwide.

As we were experiencing growing pains in our development processes, we set up an infrastructure team to change the way we work. What we emphasized were software-engineering best practices, tooling, reproducibility, and our mission to improve cross-team collaboration.

As part of our work on algorithms for our [innovative DVS sensor](http://rpg.ifi.uzh.ch/docs/CVPR19workshop/CVPRW19_Eric_Ryu_Samsung.pdf), I had created what became QA-Board. When I joined this new infrastructure team we expanded QA-Board's scope.

## Use-Cases
QA-Board has become a key collaborative tool. Our main use-cases are:
- **Sharing** links with all the info (command, output files, logs...).
- **Work-from-home**: engineers can share 108MP+ images thanks to the [IIIF protocol](https://github.com/IIIF/awesome-iiif).
- **Integration**: links to and from git repositories and their Continuous Integration. From QA-Board, users can [directly access](https://samsung.github.io/qaboard/docs/triggering-third-party-tools) build artifacts, trigger automated jobs, and when needed they can build dashboards or scripts they query QA-Board's API.
- **Visualizations**: everything can be compared, and thanks to the [many different types of visualizations](https://samsung.github.io/qaboard/docs/visualizations) (images/plots/text/html/video...), users can easily create the reports they need.
- **Tuning**: QA-Board [distributes runs](https://samsung.github.io/qaboard/docs/celery-integration) to our cluster. Users can easily start tuning experiments that enable feature flags or tweak parameters. We've integrated [scikit-optimize](https://scikit-optimize.github.io/) for black-box optimization.
- **Regression**: users can check the progress on various metrics, and when needed, identify which commit caused a regression.
- **Performance engineering**: save [`rr`](https://rr-project.org/)/[`perf`](http://www.brendangregg.com/perf.html) recordings, view [flame graphs](http://www.brendangregg.com/flamegraphs.html), [benchmark drivers](https://github.com/arthur-flam/sysbench-qaboard), and track metrics for regressions.

> Here are some screenshots:

<figure class="video-container">
  <iframe src="//www.slideshare.net/slideshow/embed_code/key/C3QrOdYHrRyB7d?startSlide=7" width="595" height="485" frameborder="0" marginwidth="0" marginheight="0" scrolling="no" style={{border: "1px solid #CCC", borderWidth: "1px", marginBottom: "5px", maxWidth: "100%"}} allowfullscreen></iframe>
</figure>


## What's next?
Our goal is to make QA-Board the best general-purpose run-tracker. We want to see it used for performance optimization, algorithm development, model comparaisons in operational research, web page performance tracking...

To achieve those goals, we'll need:
- **User feedback**, issues and feature requests. 
- **Community contributions**, for instance integrating more file viewers: e.g. support for common plot formats like vega or highcharts...

:::note How to get in touch?
Join our [issue tracker](https://github.com/Samsung/qaboard/issues) to report bugs or suggest features, or feel free to [start a chat](https://spectrum.chat/qaboard) with [the maintainers](mailto:arthur.flam@samsung.com).
:::

## How to get started using QA-Board?
[Head over to the docs](https://samsung.github.io/qaboard/docs/deploy). If you run into issues contact us: we'll help you.
