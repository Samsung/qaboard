---
id: visualizations
title: Visualizing your algorithm's outputs
sidebar_label: Visualizations
---
import useBaseUrl from '@docusaurus/useBaseUrl';

The `run()`function wrapping your code receives an `output_directory` where it can create all kinds of files. Usually, you only want to look at a few of those files, the rest being debug data. **Visualizations** help you declare pre-sets of relevant files. 

Here is a simple example, assuming your code an image named *output.jpg*.

```yaml title="qaboard.yaml"
outputs:
    visualizations:
    - path: output.jpg
```

:::note
For now, to debug your visualizations, you have to commit and push your new *qaboard.yaml*.
We plan on letting you edit simply *qaboard.yaml* locally, and update the visualizations when you use `qa --share`.
:::

You can provide multiple relevant files, and hide debug visualizations by default: 

```yaml {5-6} title="qaboard.yaml"
outputs:
    visualizations:
    - path: output.jpg
    - path: debug.jpg
      default_hidden: true
      # type: image/jpg # auto-guessed
```

Users will get switches to toggle debug visualizations:

<img alt="toggle visualizations" src={useBaseUrl('img/hidden_by_default_switches.png')} />


## Available file viewers
QA-Board tries to guess the right image viewer depending on the file extension or a `type`

File                                                | Viewer Type  | Viewer                                       |
----------------------------------------------------|--------------|----------------------------------------------|
`*.jpg*`, `*.png*`, `*.bmp*`, `*.tif*`, `*.pdf*`... |  `image/*`   | **Image**                                    |
`*.plotly.json`                                     | `plotly/json`| **Plot.ly**                                  |
`*.flame.json`                                      | `flame/json` | **[Flame Graph](http://www.brendangregg.com/flamegraphs.html)**, [diffable](http://www.brendangregg.com/blog/2014-11-09/differential-flame-graphs.html)          |
`*.html`                                            | `plain/html` | **HTML** (assumes trusted input..!)          |
`*.mp4`                                             | `video/*`    | **Video** (synced)                           |
`*.txt`, unidentified                               | `text/plain*`| **Text** (diffs, with VSCode's [Monaco Editor](https://microsoft.github.io/monaco-editor/))|
                                                    | `pointcloud/txt` | **pointcloud** viewer (needs to be refactored, coupled to a specific internal project...) |
                                                    | `6dof/txt`       | **6DoF** viewer (needs to be refactored, coupled to a specific internal project...)      |


### Image viewer
  * Supports all common image formats.
  * Fast and smooth zoom & pan, synced. Fast image streaming via [IIIF](https://iiif.io).
  * Perceptual color difference.
  * Color tooltip.
  * Image filters (exposure, contrast, gamma...).
  * Histograms per channel.
  * Automatic regions of interest.


<!-- <img alt="Image viewer" src={useBaseUrl('img/image-viewer.gif')} /> -->
<!-- <img alt="Image viewer" src={useBaseUrl('img/image-perceptural-diff.png')} /> -->

<img alt="Image viewer" src={useBaseUrl('img/image-viewer-autoroi.png')} />

:::tip
If your configurations or [input metadata](metadata-integration-external-databases) contain `roi: [{x, y, w, h, label}]`, those "regions of interest" will be displayed and easily selectable.
:::


<!-- http://qa:3000/CDE-Users/HW_ALG/CIS/tests/products/HM3/commit/051ee752a3aafa817b735bf34f7779dec9920387?reference=a4222720d3101049b3e43b458e2b8cd02470e65b&controls=%7B%22show%22%3A%7B%22Debug%20Image%22%3Afalse%2C%22CDE%20config%22%3Afalse%2C%22Video%22%3Afalse%2C%22BPC%20Directions%22%3Afalse%2C%22Remosaic%20RGB%22%3Afalse%2C%22HDR%20Merger%20LMS%20Weights%20Map%22%3Afalse%7D%2C%22diff%22%3Atrue%7D&batch=foveon_full&filter=Foveon_AFIT%2F61_SDQH_3_Nona_OutD_Person_FAR_1of800s_ISO100_5184x3792_GR.he&batch_ref=foveon_full&filter_ref= -->

### Plot.ly viewer
[The Plotly library](https://plot.ly/graphing-libraries/) has everything you need from bar charts to 3d plots.
- huge variety of plots
- interactive plots
- easy-ish to use with binding to [python](https://plot.ly/python/getting-started/)/JS/matlab...
- web-based
- open-source and popular
- performant

<img alt="plotly gallery" src={useBaseUrl('img/plotly-1.png')} />

<!-- <img alt="plotly gallery" src={useBaseUrl('img/plotly-2.png')} /> -->

<img alt="3d plot with plotly for LSF/Calibration" src={useBaseUrl('img/plotly-3d-example.png')} />

All you need is to save your plot data as JSON. 

```python
import plotly.graph_objects as go
fig = go.Figure(data=go.Bar(y=[2, 3, 1]))
with open('graph.plotly.json', 'w') as f:
  spec = fig.to_json() # '{"layout": {...}, "data": [{...}, {...}, ...]}'
  f.write()
```

### Text Viewer
<img alt="Text/diff viewer" src={useBaseUrl('img/text-viewer.jpg')} />

### Flame Graphs
We love Brendan Gregg's [flame charts](http://www.brendangregg.com/flamegraphs.html) and integrated Martin Spier's [`d3-flame-graph`](https://github.com/spiermar/d3-flame-graph). At a glance, you can check where you code spends its CPU cycles, and use [differential flame graphs]((http://www.brendangregg.com/blog/2014-11-09/differential-flame-graphs.html)) to debug regressions.

<img alt="Text/diff viewer" src={useBaseUrl('img/slides/flame-graphs.jpg')} />

> We have a draft of a tutorial explaining how to use [`perf`](http://www.brendangregg.com/perf.html), [`FlameGraph`](https://github.com/brendangregg/FlameGraph) and [`burn`](https://github.com/spiermar/burn#getting-started) to create the _json_ file expected by the visualization. Contact us and we'll publish it or show it to you.

### More Viewers?
Tell us what you need! The next we'll implement is likely [**vega**](https://vega.github.io/vega/) specs. It would notably allow us to display `altair` visualizations. We could also have a minimal integration with notebooks, [visdom](https://github.com/facebookresearch/visdom), [webiz](https://webviz.io/)...


## Dynamic visualizations
You can use a [special syntax](https://github.com/pillarjs/path-to-regexp) to create dynamic visualizations at display-time. Users will we able to choose what to display using sliders / select options:

<img alt="Viewing each frame of a movie" src={useBaseUrl('img/dynamic-outputs.gif')} />

```yaml {5,7} title="qaboard.yaml"
outputs:
    visualizations:
    - name: Movie Frames
      # you can use the `/user/:name` syntax to match part of filenames
      path: ":frame/output.jpg"
      # you can match part of filenames (experimental)
      path: ":frame/frame_:number.jpg"

      # For more examples, the full syntax is available at:
      # https://github.com/pillarjs/path-to-regexp

```

You can also use regular expressions **(inside parentheses!)** to match which output files you want to view:

```yaml {4,6,8}
outputs:
    visualizations:
      # A common use case is matching file extensions
      path: "(.*\.jpg)"
      # ... or parts of filenames
      path: "(debug_.*\.jpg)"
      # you can mix with the previous syntax
      path: ":frame/(.*\.txt)"

      # If you use regular expressions, we aware that:
      # - You MUST use "( )" aka "capture groups" !
      # - While you can often get away "(.*)/output.jpg", in many cases you'd want "([^/]*)/output.jpg"
      # - Parts of paths matched via regular expressions are not synced with other outputs. Prefer the ":name" syntax
      #   Eg if you ask also to visualize "(.*)/debug_output.jpg" and "(.*)/output.jpg"
      #   you will get two select inputs for the frame.
```

By default, only one viewer/path is shown at a time, and you get sliders/select to decide what to show:

<img alt="Everything is synced" src={useBaseUrl('img/dynamic-outputs-select.gif')} />

If you want, you can visualize all matching files:

```yaml {5-7}
   # --snip--
    - name: KPI reports
      path: "reports/:report"
      type: plotly/json
      display: single  # (default): will list views one after the other
             # all     # will render all matching paths/views
             # viewer  # let the viewer decide what to do... (EXPERIMENTAL)
```


## Advanced Options [EXPERIMENTAL] 
### Custom Styles
You can style your visualizations:

```yaml {3-7,10-12}
outputs:
    # define global or per-view styles
    style:
        # use any CSS properties
        width: 500px
        # the style will be applied to the outer-container
        # and passed down to the viewers
    detailed_views:
    - name: My debug visualization
      style:
        width: 400px   
```

### Viewer Configuration
Some viewers can read extra configuration parameters from their configuration: 

```yaml {5}
outputs:
    detailed_views:
    - name: My SLAM plot
      type: 6dof/txt
      show_3d: true
```

You can specify those parameters at "display-time" by defining controls:

```yaml {2-7}
outputs:
  controls:
    - type: toggle
      label: Debug
      name: show_debug
      default: false
```

