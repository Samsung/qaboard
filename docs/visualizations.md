---
id: visualizations
title: Visualizing your algorithm's outputs
sidebar_label: Visualizations
---

With you run your algorithm with `qa run`, you get an `output_directory` in which you can create any file you want. To display visualizations in the web application, you have to *declare* what visualizations you expect.

:::tip
If you don't have a [CI infrastructure](ci-integration) to run qatools on each new commit, you can still view your results in the web application by using `qa --ci run`.

*Note: It will only work with commits that were pushed to gitlab!*
:::

The *list* of your visualizations is defined in your project's [*qatools.yaml*](http://gitlab-srv/common-infrastructure/qatools/blob/master/qatools/sample_project/qatools.yaml#L42) under `outputs.visualizations`. Here is a simple example, assuming your code creates a few images.

```yaml
outputs:
    visualizations:
    - path: output.jpg
      type: image/jpg
    - path: debug.bmp
      type: image/bmp
```

> To debug your qatools visualizations, commit and push your *qatools.yaml*.
> 
> To get a real editing tool, contact [Arthur Flam](mailto:arthur.flam@samsung.com).



## Supported viewers
The type of each visualization determines which viewer renders it:

- `image/*`: image viewers:
  * Pretty much all image formats are supported (jpg, bmp, tiff, jp2, pdf, dng, hex, raw+imgprops...)
  * Smooth zoom, scrolling
  * Histograms per channel
  * Perceptual color difference
  * Fast image streaming via [IIIF](https://iiif.io)

![Image viewer](https://qa/s/qatools/img/image-viewer.gif)

- `plotly/json`: [The Plotly library](https://plot.ly/python) has everything from bar charts to 3d plots. Save your plotly data as JSON:

```javascript
{ 
  layout: {...},        // usual plotly "layout"
  data: [{...}, {...}]  // array of usual plotly "traces"
} 
```
![3d plot with plotly for LSF/Calibration](https://qa/s/qatools/img/plotly-3d-example.png)

- `text/plain`: Text/diff viewer.

![Text/diff viewer](https://qa/s/qatools/img/text-viewer.jpg)

- `video/*`: Video viewer
- `plain/html`: Embedded HTML viewer
- `pointcloud/txt`: performant pointcloud viewer (coupled to the *tof/swip_tof* project...)
- `6dof/txt`: SLAM 6dof plots + optionnal 3d plots and debug info (coupled to the *dvs/psp_swip* project...)

## Hidden-by default visualizations
Some visualization are heavy, or mostly useful for debugging. If you want, a toggle button will let you switch them on/off:
 
```yaml
outputs:
    detailed_views:
    - name: Registers
      type: text/plain
      path: output_registers.txt
      default_hidden: true
```

![](https://qa/s/qatools/img/hidden_by_default_switches.png)

## Dynamic visualizations
You can use regular expressions to create dynamic visualizations at display-time. Users choose what to display using sliders / select options.

```yaml
outputs:
    visualizations:
    - name: Movie Frames
      # The syntax is regex with capture groups or named parameters. More info:
      # https://github.com/pillarjs/path-to-regexp
      path: ":frame/output.jpg" # prefered
      # path: "(.*)/output.jpg" # works also. Note the "( )" !
      type: image/jpg
```

![Viewing each frame of a movie](https://qa/s/qatools/img/dynamic-outputs.gif)

```yaml
    - name: All text files
      # For "advanced" matches, you are forced to use unnamed capture groups:
      # Warning: if you have multiple unnamed capture groups, and multiple views,
      #          don't change the order of those groups.
      path: ':frame/(.*.txt)'   # capture the whole filename, but match the extension
```

![Everything is synced](https://qa/s/qatools/img/dynamic-outputs-select.gif)

```yaml
   # By default, only one viewer/path is shown at a time:
   # you get sliders/select to decide what to show
    - name: KPI reports
      path: "reports/:report"
      type: plotly/json
      display: single  # (default): will list views one after the other
             # all     # will render all matching paths/views
             # viewer  # let the viewer decide what to do... (experimental)
```

## Creating custom visualizations
> You'll have to write some `javascript` that downloads results and displays them. It's not that hard 👍👽

- **[Arthur Flam](mailto:arthur.flam@samsung.com) can advise you along the way**.
- You can setup a nice interactive dev environment in 15 minutes and start coding / adapting existing visualization:

```bash
# download and install nodejs
# https://nodejs.org/en/download/
npm install
npm start
#=> dev server listening on http://localhost:3000 
```

- We use the simple [`reactjs`](https://reactjs.org) framework.
- Existing visualizations are varied so you never start from a blank page
  * existing viewers are [implemented here](http://gitlab-srv/dvs/slamvizapp/tree/master/slamvizapp-webapp/src/viewers)
  * the mapping from visualization-type <-> viewer are [defined here](http://gitlab-srv/dvs/slamvizapp/tree/master/slamvizapp-webapp/src/viewers/OutputCard.js)


## Advanced Options [EXPERIMENTAL]
### Viewer extra configuration
Some viewers can read extra configuration parameters from their configuration: 

```yaml
outputs:
    detailed_views:
    - name: My SLAM plot
      type: 6dof/txt
      show_3d: true
```

You can specify those parameters at "display-time" by defining controls:

```yaml
outputs:
  controls:
    - type: toggle
      label: Debug
      name: show_debug
      default: false
```

### Custom styles
You can style your visualizations:

```yaml
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
