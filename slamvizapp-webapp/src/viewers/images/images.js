import React, { PureComponent } from "react";
import { get } from "axios"
import {
  Colors,
  Tag,
  Slider,
  Icon,
  Tooltip,
  // itamar persi
  MenuItem,
  // end
} from "@blueprintjs/core";
import pixelmatch from 'pixelmatch';
import Plot from 'react-plotly.js';

import { ColorTooltip, CoordTooltip } from './tooltip';
import "./image-canvas.css";
import { histogram_traces } from './histogram';

// itamar persi
import { MultiSelect } from "@blueprintjs/select";
import { updateSelected } from "../../actions/selected";
import TagForm from "./tag_form";
//end

var OpenSeadragon = require('openseadragon')
require('./rgb')
require('./filters')
require('./selection')

const slugify = s => s.replace(/[^a-zA-Z0-9]/g, '-')

// TODO:
// add plugings
// - https://github.com/picturae/Openseadragonrgb/blob/master/src/rgb.js
// - http://Openseadragon.github.io/docs/Openseadragon.html#.Options
// - http://Openseadragon.github.io/docs/Openseadragon.Viewer.html
// - http://Openseadragon.github.io/docs/Openseadragon.Viewport.html
// - https://github.com/cuberis/openseadragon-curtain-sync/
// - http://Openseadragon.github.io/#examples-and-features
const openseadragon_config = {
  visibilityRatio: 1,
  preserveViewport: true,
  springStiffness: 15,

  defaultZoomLevel: 1,
  minZoomLevel: 1,
  // maxZoomLevel: 10,
  maxZoomPixelRatio: 50,
  minZoomImageRatio: 50,

  imageSmoothingEnabled: false,
  smoothTileEdgesMinZoom: 1000000,

  showNavigator: true,
  // for now, manually: cp -r node_modules/Openseadragon/build/Openseadragon /stage/algo_data/ci/
  prefixUrl: "/s/stage/algo_data/ci/openseadragon/images/",

  crossOriginPolicy: 'Anonymous',
  ajaxWithCredentials: false,

  // constrainDuringPan: false,
}


const iiif_url = (output_dir_url, path) => {
  // we only serve data from there
  let identifier = output_dir_url.replace("/stage/algo_data", "")
  // remove the URL' leading "/s"
  identifier = identifier.replace(/\/*?s\//, "")
  identifier = `${identifier}/${path}`;
  // IIIF specs require encoding the slashes inside the identifier
  let is_cde_file = identifier.endsWith('dng') || identifier.endsWith('raw') || identifier.endsWith('hex')
  let endpoint = is_cde_file ? 'https://qa:8186/fcgi-bin/iipsrv.fcgi?IIIF='
    : 'https://qa:8183/iiif/2/'
  identifier = encodeURIComponent(identifier)
  let url = `${endpoint}${identifier}`
  return url
}

class ImgViewer extends PureComponent {
  constructor(props) {
    super(props);
    // itamar persi
    this.show_add_tag = false
    this.AddTag = this.add_tag.bind(this);
    this.HandleTagClick = this.handle_tag_click.bind(this);
    //end
    this.show_histogram = false
    this.canvas_diff = React.createRef();
    this.state = {
      first_image: "new",
      width: parseFloat(((this.props.style || {}).width || '390px').replace(/[^\d]+/, '')),
      height: 217, // default 4/3 ratio
      diff_threshold: 0.1,
      color: {},
      hide_labels: false,
      // itamar persi
      fileds: [{ key: "BPC", label: "bpc" }, { key: "HM1", label: "hm1" }],
      items: [],
      createdItems: [],
      tags: [],
      // end
    }
  }

  componentDidMount() {
    const { output_new, id, path } = this.props;
    this.viewer_new = OpenSeadragon({
      ...openseadragon_config,
      id: `osd-new-${slugify(output_new.output_dir_url)}-${id || path}`,
    });
    this.viewer_ref = OpenSeadragon({
      ...openseadragon_config,
      id: `osd-ref-${slugify(output_new.output_dir_url)}-${id || path}`,
    });

    this.Init().then(() => {
      this.InitMouseTracker(this.props);
      this.InitZoomSync();
      this.InitFilters();
      this.InitSelection();
      this.InitDiff();
      window.addEventListener("keypress", this.keyboard, { passive: true });
    })
  }

  componentWillUnmount() {
    if (!!this.viewer_new) {
      // this.viewer_new.imageLoader.clear()  
      // this.viewer_new.destroy();
      // this.viewer_new = null;
    }
    if (!!this.viewer_new) {
      // this.viewer_new.imageLoader.clear()  
      // this.viewer_ref.destroy();
      // this.viewer_ref = null;
    }
    window.removeEventListener('keypress', this.keypress);
  }


  Init() {
    return new Promise((resolve, reject) => {
      const { path, output_new, output_ref } = this.props;
      const has_reference = !!output_ref && !!output_ref.output_dir_url;

      get(`${iiif_url(output_new.output_dir_url, path)}/info.json`).then(res => {
        this.setState({ loaded: true })
        // https://Openseadragon.github.io/examples/tilesource-iiif/
        // image dimensions
        const { height, width } = res.data;
        let source_config = {
          "@context": "http://iiif.io/api/image/2/context.json",
          protocol: "http://iiif.io/api/image",
          profile: ["http://iiif.io/api/image/2/level2.json"],
          // formats: ["png"],
          fitBounds: true,
          height,
          width,
        }
        this.setState({
          image_width: width,
          image_height: height,
        }, () => resolve())

        const { viewer_new, viewer_ref } = this;
        // Trying to replace images using `viewer.open` first closes the image, so there is a blank if one change the image path...
        // https://github.com/openseadragon/openseadragon/issues/1428
        // let viewer_new_is_open = viewer_new.isOpen()
        viewer_new.addTiledImage({
          tileSource: { ...source_config, "@id": iiif_url(output_new.output_dir_url, path) },
          success: () => {
            // To avoid leaking tile sources, we should remove the previous tile
            // however, it causes a blink-to-white transition... so until we find a fix...
            // We may also not want to remove old source, eg cache them. But it's a small gain, and
            // we already have the browser's cache, the IIIF server's, so...
            // if (viewer_new.world.getItemCount() > 1)
            //   viewer_new.world.removeItem(viewer_new.world.getItemAt(1))
          },
          // We would like to do this, there is still a white flicker... 
          // index: viewer_new_is_open ? 0 : undefined,
          // replace: viewer_new_is_open ? true : undefined,
        })

        if (has_reference) {
          viewer_ref.addTiledImage({
            tileSource: { ...source_config, "@id": iiif_url(output_ref.output_dir_url, path) },
            success: () => { },
          })
        }
      }).catch(error => {
        this.setState({ error })
        reject({ error })
      });
    })
  }

  componentDidUpdate(prevProps, prevState) {
    let updated_new =
      prevProps.output_new !== undefined && prevProps.output_new !== null &&
      (this.props.output_new === null || this.props.output_new === undefined ||
        prevProps.output_new.id !== this.props.output_new.id);
    let updated_ref =
      prevProps.output_ref !== undefined && prevProps.output_ref !== null &&
      (this.props.output_ref === null || this.props.output_ref === undefined ||
        prevProps.output_ref.id !== this.props.output_ref.id);
    const has_path = this.props.path !== undefined && this.props.path !== null;
    let updated_path = has_path && (prevProps.path === null || prevProps.path === undefined || prevProps.path !== this.props.path);
    if (updated_new || updated_ref || updated_path) {
      if (this.props.id === undefined)
        console.log('If you update the image path, you have to provide a `props.id`, otherwise the component will crash because the viewers IDs depend on it')
      this.Init();
    }

    let updated_diff = prevProps.diff !== this.props.diff;
    if (updated_diff) {
      this.InitDiff(this.props);
    }
  }

  update_diff = () => {
    const { viewer_new, viewer_ref } = this;
    let size = new OpenSeadragon.Point(viewer_new.container.clientWidth || 1, viewer_new.container.clientHeight || 1);
    let data_new = viewer_new.drawer.context.getImageData(0, 0, size.x, size.y);
    let data_ref = viewer_ref.drawer.context.getImageData(0, 0, size.x, size.y);
    var canvas_diff_element = this.canvas_diff.current;
    if (!!canvas_diff_element) {
      var diff_data = canvas_diff_element.getContext("2d").createImageData(size.x, size.y);
      pixelmatch(data_new.data, data_ref.data, diff_data.data, size.x, size.y, { threshold: this.state.diff_threshold, includeAA: true });
      canvas_diff_element.getContext("2d").putImageData(diff_data, 0, 0);
    }
  }


  InitDiff(props) {
    // Implemement perceptual differences
    const { viewer_new, viewer_ref } = this;
    const { diff } = this.props;
    if (diff) {
      viewer_new.addOnceHandler('update-viewport', this.update_diff, {}, 3);
      viewer_ref.addOnceHandler('update-viewport', this.update_diff, {}, 3);
      viewer_new.addHandler('animation-finish', this.update_diff);
      this.update_diff()
    }
  }


  update_histogram = () => {
    if (!this.show_histogram)
      return
    this.histo_new = histogram_traces(this.viewer_new, this.canvasCoords, 'new')
    let has_reference = !!this.props.output_ref && !!this.props.output_ref.output_dir_url;
    if (has_reference)
      this.histo_ref = histogram_traces(this.viewer_ref, this.canvasCoords, 'ref')
  }

  // itamar persi
  add_tag(tag_name) {
    //return this.viewer_new.selection.rect
    const { viewer_new } = this;
    const newItem = {
      text: tag_name,
      id: Date.now(),
      rect: this.canvasCoords
    };

    //alert(newItem.canvasCoords);



    this.setState(state => ({
      tags: state.tags.concat(newItem)
    }));
    /*

    //this.props.handleSubmit(event);
    //event.preventDefault();
 
    */
  }

  handle_tag_click(tag) {
    // Implemement synced zoom
    // https://codepen.io/iangilman/pen/BWKKxQ
    const { viewer_new, viewer_ref } = this;
    var masterZoom;
    var masterCenter;
    var viewer_newLeading = false;
    var viewer_refLeading = false;
    /*
    var viewer_newHandler = function () {
      if (viewer_refLeading)
        return;
        */
    masterZoom = viewer_new.viewport.getZoom();
    masterCenter = viewer_new.viewport.getCenter();
    //lert("masterZoom:" + masterZoom + "\nmasterCenter:" + masterCenter);
    /*
            if (masterCenter === undefined || masterCenter === null) return

      viewer_newLeading = true;
      viewer_ref.viewport.zoomTo(masterZoom);
      viewer_ref.viewport.panTo(masterCenter);
      viewer_newLeading = false;
    };

    var viewer_refHandler = function () {
      if (viewer_newLeading)
        return;
      masterZoom = viewer_ref.viewport.getZoom();
      masterCenter = viewer_ref.viewport.getCenter();
      if (masterCenter === undefined || masterCenter === null) return

      viewer_refLeading = true;
      viewer_new.viewport.zoomTo(masterZoom);
      viewer_new.viewport.panTo(masterCenter);
      viewer_refLeading = false;
    };
    viewer_new.addHandler('zoom', viewer_newHandler);
    viewer_ref.addHandler('zoom', viewer_refHandler);
    viewer_new.addHandler('pan', viewer_newHandler);
    viewer_ref.addHandler('pan', viewer_refHandler);

    function maintainZoom() {
      if (viewer_new === null || viewer_new === undefined || viewer_ref === null || viewer_ref === undefined)
        return;
      var size1 = new OpenSeadragon.Point(viewer_new.container.clientWidth || 1, viewer_new.container.clientHeight || 1);
      var size2 = new OpenSeadragon.Point(viewer_ref.container.clientWidth || 1, viewer_ref.container.clientHeight || 1);
      viewer_newLeading = true;
      viewer_refLeading = true;
      try { // we should try to find how to identify when an image is not loaed...
        viewer_new.viewport.resize(size1, true);
        viewer_ref.viewport.resize(size2, true);

        viewer_ref.viewport.zoomTo(masterZoom, null, true);
        viewer_ref.viewport.panTo(masterCenter, true);

        viewer_new.viewport.zoomTo(masterZoom, null, true);
        viewer_new.viewport.panTo(masterCenter, true);

        viewer_newLeading = false;
        viewer_refLeading = false;

        viewer_new.forceRedraw();
        viewer_ref.forceRedraw();
      } catch {

      }
    }
    window.addEventListener('resize', maintainZoom, { passive: true });
    this.setState({ maintainZoom });
  */
  }
  //end

  InitSelection(props) {
    const { viewer_new } = this;
    const selection_options = {
      onSelection: rect => { console.log(rect) },

      onSelectionChange: ({ canvasCoords }) => {
        this.show_histogram = true;
        // itamar persi
        this.show_add_tag = true;
        // end
        this.canvasCoords = canvasCoords;
        this.update_histogram();
      },
      showConfirmDenyButtons: false,
      restrictToImage: true,
      allowRotation: false,
    }
    viewer_new.selection(selection_options);
    viewer_new.addHandler('update-viewport', this.update_histogram);
    viewer_new.addHandler('selection_cancel', () => {
      this.show_histogram = false;
      // itamar persi
      this.show_add_tag = false
      // end
    });
    viewer_new.addHandler('selection_toggle', ({ enabled }) => {
      this.show_histogram = enabled;
      this.update_histogram();
      // itamar persi
      this.show_add_tag = enabled
      // end
    });
  }


  InitZoomSync() {
    // Implemement synced zoom
    // https://codepen.io/iangilman/pen/BWKKxQ
    const { viewer_new, viewer_ref } = this;
    var masterZoom;
    var masterCenter;
    var viewer_newLeading = false;
    var viewer_refLeading = false;
    var viewer_newHandler = function () {
      if (viewer_refLeading)
        return;
      masterZoom = viewer_new.viewport.getZoom();
      masterCenter = viewer_new.viewport.getCenter();
      if (masterCenter === undefined || masterCenter === null) return

      viewer_newLeading = true;
      viewer_ref.viewport.zoomTo(masterZoom);
      viewer_ref.viewport.panTo(masterCenter);
      viewer_newLeading = false;
    };

    var viewer_refHandler = function () {
      if (viewer_newLeading)
        return;
      masterZoom = viewer_ref.viewport.getZoom();
      masterCenter = viewer_ref.viewport.getCenter();
      if (masterCenter === undefined || masterCenter === null) return

      viewer_refLeading = true;
      viewer_new.viewport.zoomTo(masterZoom);
      viewer_new.viewport.panTo(masterCenter);
      viewer_refLeading = false;
    };
    viewer_new.addHandler('zoom', viewer_newHandler);
    viewer_ref.addHandler('zoom', viewer_refHandler);
    viewer_new.addHandler('pan', viewer_newHandler);
    viewer_ref.addHandler('pan', viewer_refHandler);

    function maintainZoom() {
      if (viewer_new === null || viewer_new === undefined || viewer_ref === null || viewer_ref === undefined)
        return;
      var size1 = new OpenSeadragon.Point(viewer_new.container.clientWidth || 1, viewer_new.container.clientHeight || 1);
      var size2 = new OpenSeadragon.Point(viewer_ref.container.clientWidth || 1, viewer_ref.container.clientHeight || 1);
      viewer_newLeading = true;
      viewer_refLeading = true;
      try { // we should try to find how to identify when an image is not loaed...
        viewer_new.viewport.resize(size1, true);
        viewer_ref.viewport.resize(size2, true);

        viewer_ref.viewport.zoomTo(masterZoom, null, true);
        viewer_ref.viewport.panTo(masterCenter, true);

        viewer_new.viewport.zoomTo(masterZoom, null, true);
        viewer_new.viewport.panTo(masterCenter, true);

        viewer_newLeading = false;
        viewer_refLeading = false;

        viewer_new.forceRedraw();
        viewer_ref.forceRedraw();
      } catch {

      }
    }
    window.addEventListener('resize', maintainZoom, { passive: true });
    this.setState({ maintainZoom });
  }

  InitFilters() {
    const { viewer_new, viewer_ref } = this;
    viewer_new.imagefilters({});
    viewer_ref.imagefilters({});
  }

  InitMouseTracker() {
    const { viewer_new, viewer_ref } = this;
    var rgb_new = viewer_new.rgb({
      onCanvasHover: color_new => {
        if (!!!color_new.viewportCoordinates)
          return
        const { x, y } = color_new.viewportCoordinates
        let has_reference = !!this.props.output_ref && !!this.props.output_ref.output_dir_url;
        if (has_reference) {
          const color_ref = rgb_ref.getValueAt(x, y)
          this.setState({ color_ref })
        }
        this.setState({ color_new })
      }
    });
    var rgb_ref = viewer_ref.rgb({
      onCanvasHover: color_ref => {
        if (!!!color_ref.viewportCoordinates)
          return
        const { x, y } = color_ref.viewportCoordinates
        const color_new = rgb_new.getValueAt(x, y)
        this.setState({ color_new, color_ref })
      }
    });

  }

  // itamar persi
  // these members help us define the metric selector
  arrayContainsFilm(films, filmToFind) {
    return films.some((film) => film.title === filmToFind.title);
  }

  addFilmToArray(films, filmToAdd) {
    return [...films, filmToAdd];
  }

  deleteFilmFromArray(films, filmToDelete) {
    return films.filter(film => film !== filmToDelete);
  }

  maybeAddCreatedFilmToArrays(items, createdItems, film, ) {
    const isNewlyCreatedItem = !arrayContainsFilm(items, film);
    return {
      createdItems: isNewlyCreatedItem ? addFilmToArray(createdItems, film) : createdItems,
      // Add a created film to `items` so that the film can be deselected.
      items: isNewlyCreatedItem ? addFilmToArray(items, film) : items,
    };
  }

  maybeDeleteCreatedFilmFromArrays(items, createdItems, film, ) {
    const wasItemCreatedByUser = arrayContainsFilm(createdItems, film);

    // Delete the item if the user manually created it.
    return {
      createdItems: wasItemCreatedByUser ? deleteFilmFromArray(createdItems, film) : createdItems,
      items: wasItemCreatedByUser ? deleteFilmFromArray(items, film) : items,
    };
  }

  getSelectedMetricIndex = metric => {
    return this.state.fileds.indexOf(metric);
  };

  isMetricSelected(metric) {
    return this.getSelectedMetricIndex(metric) !== -1;
  }

  selectMetric(metric) {
    this.selectMetrices([metric]);
  }

  selectMetrices(filedsToSelect) {
    const { createdItems, fileds, items } = this.state;

    let nextCreatedItems = createdItems.slice();
    let nextfileds = fileds.slice();
    let nextItems = items.slice();

    filedsToSelect.forEach(filed => {
      const results = maybeAddCreatedfiledToArrays(nextItems, nextCreatedItems, filed);
      nextItems = results.items;
      nextCreatedItems = results.createdItems;
      // Avoid re-creating an item that is already selected (the "Create
      // Item" option will be shown even if it matches an already selected
      // item).
      nextfileds = !arrayContainsfiled(nextfileds, filed) ? [...nextfileds, filed] : nextfileds;
    });

    this.setState({
      createdItems: nextCreatedItems,
      fileds: nextfileds,
      items: nextItems,
    });
  }

  handleMetricSelect = metric => {
    if (!this.isMetricSelected(metric)) {
      this.selectMetric(metric);
    } else {
      this.deselectMetric(this.getSelectedMetricIndex(metric));
    }
  };

  deselectMetric = index => {/*
    this.props.dispatch(updateSelected(
      this.props.project, {
        selected_metrics: this.props.selected_metrics.filter((metric, i) => i !== index)
      }))*/

    const { fileds } = this.state;

    const field = fileds[index];

    // Delete the item if the user manually created it.
    this.setState({
      fields: fields.filter((_field, i) => i !== index),
    });
  }

  renderMetric = (metric, { handleClick, modifiers, query }) => {
    if (!modifiers.matchesPredicate) {
      return null;
    }
    return (
      <MenuItem
        active={modifiers.active}
        icon={this.isMetricSelected(metric) ? "tick" : "blank"}
        key={metric.key}
        label={metric.key}
        text={`${metric.label}`}
        onClick={handleClick}
        shouldDismissPopover={false}
      />
    );
  };

  //end

  render() {
    const { output_new, output_ref, diff, label, path, id } = this.props;
    const { first_image, width, image_height, image_width, error, hide_labels } = this.state;

    let no_reference = !!!output_ref || !!!output_ref.output_dir_url;
    if (!!error && Object.keys(error).length > 0)
      return <span />;

    const single_image_width = (width - 10) / 2
    const single_image_height = !!image_height ? image_height / image_width * single_image_width : 0
    const flex = { flex: '0 0 auto' }
    const single_image_size = {
      width: `${single_image_width}px`,
      height: `${single_image_height}px`,
    }

    const switch_label = <Tag rightIcon="exchange" onClick={this.switch_images}>Switch</Tag>;
    let images = [
      <div style={flex} key="new">
        <Tooltip>
          {!hide_labels ? <Tag interactive intent="warning" rightIcon="exchange" onClick={this.switch_images}>new</Tag> : switch_label}
          <span>Switch New/Reference with the keyboard shortcut <code>t</code>. Hide labels with <code>h</code></span>
        </Tooltip>
        <div style={single_image_size} id={`osd-new-${slugify(output_new.output_dir_url)}-${id || path}`} key={`osd-new-${slugify(output_new.output_dir_url)}-${id || path}`} />
      </div>,
      <div style={flex} key="ref">
        <Tooltip>
          {!hide_labels ? <Tag interactive intent="primary" rightIcon="exchange" onClick={this.switch_images}>reference</Tag> : switch_label}
          <span>Switch New/Reference with the keyboard shortcut <code>t</code>. Hide labels with <code>h</code></span>
        </Tooltip>
        <div style={single_image_size} id={`osd-ref-${slugify(output_new.output_dir_url)}-${id || path}`} key={`osd-ref-${slugify(output_new.output_dir_url)}-${id || path}`} hidden={no_reference} />
      </div>
    ]

    let colors = [
      <ColorTooltip color={this.state.color_new} key="new" />,
      <ColorTooltip color={this.state.color_ref} key="reference" />,
    ]

    if (first_image === 'reference') {
      images = images.reverse();
      colors = colors.reverse();
    }

    const histo_layout = {
      width: single_image_width,
      height: single_image_height,
      autosize: false,
      traceorder: 'reversed+grouped',
      barmode: 'overlay',
      yaxis: {
        tickformat: '.1%',
      }
    }

    return <>
      <span>
        <Tooltip>
          <Icon icon="info-sign" style={{ color: Colors.GRAY2 }} />
          <ul>
            <li>This image is not the real image! It's JPEG compressed (100-quality).</li>
            <li>Histograms (RGB+Y) are computed on the rendered low-resolution image.</li>
          </ul>
        </Tooltip>
        <CoordTooltip color={this.state.color_new} />
        {colors}
        {label && (label || path)}
      </span>

      <span>Hello World!</span>

      {/* itamar persi */}
      <div className="Container">
        <p>Add crops using the crop tool</p>
        <ul>
          {this.state.tags.map(tag => (
            <ul key={tag.id} >
              <button type="button" onClick={this.HandleTagClick(tag)}>
                {tag.text}
              </button>
            </ul>
          ))}
        </ul>
        <MultiSelect
          items={this.state.fileds}
          itemRenderer={this.renderMetric}
          onItemSelect={this.handleMetricSelect}
          tagRenderer={m => m.label}
        />

        {this.show_add_tag &&
          <TagForm handleSubmit={this.AddTag} />
        }
      </div>
      {/* end */}

      <div style={{ display: 'flex', flexWrap: 'wrap', alignContent: 'center', paddingBottom: 5 }}>

        {images}

        {single_image_height > 0 && <div hidden={!diff || no_reference} style={flex}>
          <Slider
            style={{ width: single_image_size.width }}
            min={0} max={1}
            labelStepSize={0.1}
            stepSize={0.01}
            initialValue={this.state.diff_threshold}
            value={this.state.diff_threshold}
            showTrackFill
            onChange={diff_threshold => {
              this.setState({ diff_threshold }, () => this.update_diff())
            }}
          />
          <canvas hidden={!diff || no_reference} ref={this.canvas_diff} {...single_image_size} />
          <br />
          <Tooltip hoverCloseDelay={500}>
            <p><Icon icon="info-sign" style={{ color: Colors.GRAY2 }} /></p>
            <ul>
              <li>Color difference according to the paper "Measuring perceived color difference using YIQ NTSC transmission color space in mobile applications" by Y. Kotsarenko and F. Ramos</li>
              <li>Maximum squared difference = 35215 * threshold^2.</li>
              <li>Anti-aliased pixels are shown as yellow at most.</li>
              <li><a href="https://github.com/mapbox/pixelmatch/blob/master/index.js">Read the code</a> for more.</li>
            </ul>
          </Tooltip>
        </div>}

        {this.show_histogram && <div style={flex}>
          <Plot data={[...(this.histo_ref || []), ...(this.histo_new || [])]} layout={histo_layout} style={single_image_size} />
        </div>}

      </div>
    </>
  }

  switch_images = () => {
    let first_image = this.state.first_image === 'reference' ? 'new' : 'reference';
    this.setState({ first_image })
  }

  keyboard = ev => {
    if (ev.target.nodeName === 'INPUT')
      return;
    switch (ev.id || String.fromCharCode(ev.keyCode || ev.charCode)) {
      case "t":
        this.switch_images()
        break
      case "h":
        this.setState({ hide_labels: !this.state.hide_labels })
        break
      default:
        return;
    }
  }








}




// https://github.com/Openseadragon/Openseadragon/issues/1376
// var tileLoadedHandler = function(eventSource, item, user) {
//     viewer_new.removeHandler('tile-loaded', tileLoadedHandler);
//     var imageBounds =viewer_new.world.getItemAt(0).getBounds();
//     viewer_new.viewport.fitBounds(imageBounds, true);
// };
// viewer_new.addHandler('tile-loaded', tileLoadedHandler);
// viewer_new.addHandler('full-screen', function(a){
//     console.log('full-screen-new')
//     console.log(a)
//     if(a.fullScreen == true) {
//         viewer_new.autoResize = true;
//     } else {
//         setTimeout(function () {
//             window.addEventListener('resize', maintainZoom);
//             viewer_new.autoResize = false;
//         }, 400);
//     }
// });
// viewer_ref.addHandler('full-screen',function(a){
//     if(a.fullScreen == true){
//         viewer_ref.autoResize = true;
//     } else {
//         setTimeout(function () {
//             window.addEventListener('resize', maintainZoom);
//             viewer_ref.autoResize = false;
//         }, 400);
//     }
// })

// viewer.addHandler("page", data => {
//   this.setState({shown_image: data.page===0 ? "New" : "Reference"})
// });

export default ImgViewer;
