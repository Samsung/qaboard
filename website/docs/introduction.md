---
id: introduction
title: What is QA-Board?
sidebar_label: What is QA-Board?
---

**QA-Board** is a run-tracker with advanced visualizations for algorithm and software engineers. It wraps your code then organizes and displays its results.

## Tracking quality is hard
_Tests are not enough_ when the focus is quality and performance. Whether you need to improve algorithms or make performance-sensitive code more efficient, all sorts of metrics and visualizations are required. Engineers usually start this evaluation process by writing scripts or notebooks that test their solution on limited samples. They then look at the results and iterate.

While it's very convenient at first, very soon keeping track of versions or comparing features gets challenging. There are a lot of "logistics" to get right:
- How to share results?
- What about source control and CI integration?
- How to start distributed tuning experiments?
- How to identify regressions?

> QA-Board meets those needs.


## Use-Cases
QA-Board has become a key collaborative tool at Samsung SIRC. Our main use-cases are:
- **Sharing** links with all the info (command, output files, logs...).
- **Work-from-home**: engineers can share 108MP+ images thanks to the [IIIF protocol](https://github.com/IIIF/awesome-iiif).
- **Integration**: links to and from git repositories and their Continuous Integration. From QA-Board, users can [directly access](https://samsung.github.io/qaboard/docs/triggering-third-party-tools) build artifacts, trigger automated jobs, and when needed they can build dashboards or scripts they query QA-Board's API.
- **Visualizations**: everything can be compared, and thanks to the [many different types of visualizations](https://samsung.github.io/qaboard/docs/visualizations) (images/plots/text/html/video...), users can easily create the reports they need.
- **Tuning**: QA-Board distributes runs to our cluster. Users can easily start tuning experiments that enable feature flags or tweak parameters. We've integrated [scikit-optimize](https://scikit-optimize.github.io/) for black-box optimization.
- **Regression**: users can check the progress on various metrics, and when needed, identify which commit caused a regression.
- **Performance engineering**: save [`rr`](https://rr-project.org/)/[`perf`](http://www.brendangregg.com/perf.html) recordings, view [flame graphs](http://www.brendangregg.com/flamegraphs.html) and track metrics for regressions.

> Here are some screenshots, from slide 7:

<figure class="video-container">
<iframe src="//www.slideshare.net/slideshow/embed_code/key/C3QrOdYHrRyB7d?startSlide=1" width="595" height="485" frameborder="0" marginwidth="0" marginheight="0" scrolling="no" style={{border: "1px solid #CCC", borderWidth: "1px", marginBottom: "5px", maxWidth: "100%"}} allowfullscreen>
</iframe>
</figure>
