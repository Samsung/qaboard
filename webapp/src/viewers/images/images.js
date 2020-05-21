import React from "react";
import { get, CancelToken } from "axios"
import {
  Classes,
  Colors,
  Intent,
  Tag,
  Icon,
  Tooltip,
  Popover,
  MultiSlider,
} from "@blueprintjs/core";
import Plot from 'react-plotly.js';
import pixelmatch from './pixelmatch';
// import { lossFunctionFromString } from "./jeri/src/layers/Layer.ts"
// import ImageLayer from "./jeri/src/layers/ImageLayer.ts"

import { ColorTooltip, CoordTooltip } from './tooltip';
import "./image-canvas.css";
import { histogram_traces } from './histogram';
import { CropSelection } from "./crops";
import { iiif_url } from "./utils";
import MultiSelectTags from './MultiselectCrops'

import { unregister_filter_sync } from "./filters"

var OpenSeadragon = require('openseadragon')
require('./selection')
require('./rgb')
require('./filters')



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

  // debugMode: true,
  // constrainDuringPan: false,
}


// We sync the viewer viewport of all viewers of the same size for a given output
var synced_viewers = {}



// we create unique ids to identify openseadragon viewers as outputs change
// it's handy for smooth transitions, eg with videos, or when the list of viewers is updated/filtered
// https://stackoverflow.com/questions/29420835/how-to-generate-unique-ids-for-form-labels-in-react
let last_viewer_id = 0;
const make_viewer_id = () => {
  last_viewer_id += 1;
  return `image-viewer-${last_viewer_id}`;
}


function maintain_zoom() {
  // console.log("[maintain_zoom]")
  Object.values(synced_viewers).forEach(sync_group => {
    if (Object.values(sync_group.viewers).some(v => v === null || v === undefined))
      return;
    sync_group.leading = "resize";
    try { // we should try to find how to identify when an image is not loaed...
      sync_group.viewers.forEach(v => {
        const size = new OpenSeadragon.Point(v.container.clientWidth || 1, v.container.clientHeight || 1);
        v.viewport.resize(size, true);
        v.viewport.zoomTo(sync_group.zoom, null, true);
        v.viewport.panTo(sync_group.center, true);
      })
      sync_group.leading = null;
      sync_group.viewers.forEach(v => v.forceRedraw())
    } catch { }
  })
}
window.addEventListener('resize', maintain_zoom, { passive: true });


class ImgViewer extends React.PureComponent {
  constructor(props) {
    super(props);
    // avoid issues in the first render
    this.viewer_new = { id: make_viewer_id() }
    this.viewer_ref = { id: make_viewer_id() }

    this.show_histogram = false;
    this.canvas_diff = React.createRef();
    // this.canvas_diff_ssim = React.createRef();

    this.state = {
      ready: false,
      first_image: "new",
      width: Math.floor(parseFloat(((this.props.style || {}).width || '390px').replace(/[^\d]+/, ''))),
      height: 217, // default 4/3 ratio
      diff_threshold: 0.05,
      color: {},
      hide_labels: false,
      cancel_source: CancelToken.source(),
    }
  }

  componentDidMount() {
    this.viewer_new = OpenSeadragon({
      ...openseadragon_config,
      ...this.viewer_new, // todo: use react refs instead
    });
    this.viewer_ref = OpenSeadragon({
      ...openseadragon_config,
      ...this.viewer_ref,
    });
    this.Init().then(() => {
      this.viewer_new.addOnceHandler('update-viewport', () => this.setState({ ready: true }), {}, 3);
      this.InitMouseTracker(this.props);
      this.InitZoomSync();
      this.InitFilters();
      this.InitSelectionTool();
      this.InitDiff();
      window.addEventListener("keypress", this.keyboard, { passive: true });
    }).catch(error => { console.log("Init Error:", error) })
  }



  InitZoomSync() {
    if (!!this.UnregisterZoomSync)
      this.UnregisterZoomSync()

    // console.log("[InitZoomSync]")
    // Implemement synced zoom
    // https://codepen.io/iangilman/pen/BWKKxQ
    const { viewer_new, viewer_ref } = this;
    const { image_width, image_height } = this.state;
    const sync_key = `${this.props.output_new.test_input_path}-${image_height}x${image_width}`;
    // console.log("sync_key", sync_key)

    if (synced_viewers[sync_key] === undefined) {
      // console.log("init synced viewers", sync_key)
      synced_viewers[sync_key] = {
        viewers: [viewer_new, viewer_ref],
        // all the viewers are syncronized to
        zoom: null,
        center: null,
        // When the user moves a viewer, it leads the others
        // whose pan/zoom events we ignore.
        // Values: the id of a viewer, null, or "all"
        leading: null,
      }
    } else {
      if (synced_viewers[sync_key].viewers.every(v => v.id !== viewer_new.id))
        synced_viewers[sync_key].viewers.push(viewer_new)
      if (synced_viewers[sync_key].viewers.every(v => v.id !== viewer_ref.id))
        synced_viewers[sync_key].viewers.push(viewer_ref)
    }


    var lead_viewer_sync = (sync_key, viewer) => () => {
      // console.log("[lead_viewer_sync]")
      let { leading } = synced_viewers[sync_key];
      if (!!leading && (leading !== viewer.id && leading !== 'resize'))
        return;
      synced_viewers[sync_key].zoom = viewer.viewport.getZoom();
      synced_viewers[sync_key].center = viewer.viewport.getCenter();
      // console.log(`leading with ${viewer.id} to ${zoom} / ${center}`)      
      if (synced_viewers[sync_key].center === undefined || synced_viewers[sync_key].center === null)
        return
      synced_viewers[sync_key].leading = viewer.id;
      synced_viewers[sync_key].viewers.filter(v => v.id !== viewer.id).forEach(v => {
        // console.log(`  follow for ${v.id}`)
        v.viewport.zoomTo(synced_viewers[sync_key].zoom);
        v.viewport.panTo(synced_viewers[sync_key].center);
      })
      synced_viewers[sync_key].leading = null;
    };

    viewer_new.addHandler('zoom', lead_viewer_sync(sync_key, viewer_new));
    viewer_ref.addHandler('zoom', lead_viewer_sync(sync_key, viewer_ref));
    viewer_new.addHandler('pan', lead_viewer_sync(sync_key, viewer_new));
    viewer_ref.addHandler('pan', lead_viewer_sync(sync_key, viewer_ref));

    this.UnregisterZoomSync = () => {
      viewer_new.removeHandler('zoom', lead_viewer_sync(sync_key, viewer_new));
      viewer_ref.removeHandler('zoom', lead_viewer_sync(sync_key, viewer_ref));
      viewer_new.removeHandler('pan', lead_viewer_sync(sync_key, viewer_new));
      viewer_ref.removeHandler('pan', lead_viewer_sync(sync_key, viewer_ref));
      if (synced_viewers[sync_key] !== undefined) {
        synced_viewers[sync_key].viewers = synced_viewers[sync_key].viewers.filter(
          v => v.id !== viewer_new.id && v.id !== viewer_ref.id
        )
      }
      this.UnregisterZoomSync = null;
    }

  }


  componentWillUnmount() {
    if (!!this.state.cancel_source.token)
      this.state.cancel_source.cancel();
    if (!!this.UnregisterZoomSync)
      this.UnregisterZoomSync()
    if (!!this.UnregisterZoomSync)
      this.UnregisterZoomSync()

    if (!!this.viewer_new) {
      unregister_filter_sync(this.viewer_new)
      // this.viewer_new.imageLoader.clear()  
      // this.viewer_new.destroy();
      // this.viewer_new = null;
    }
    if (!!this.viewer_ref) {
      unregister_filter_sync(this.viewer_ref)
      // this.viewer_new.imageLoader.clear()  
      // this.viewer_ref.destroy();
      // this.viewer_ref = null;
    }
    // remove viewers from output_viewers
    window.removeEventListener('keypress', this.keypress);
  }


  Init = () => {
    return new Promise((resolve, reject) => {
      const { viewer_new, viewer_ref } = this;
      const { path, output_new, output_ref } = this.props;

      const has_reference = !!output_ref && !!output_ref.output_dir_url;

      get(`${iiif_url(output_new.output_dir_url, path)}/info.json`, { cancelToken: this.state.cancel_source.image })
        .then(res => {
          this.setState({ loaded: true })
          // https://Openseadragon.github.io/examples/tilesource-iiif/
          // image dimensions
          const { height, width, profile=[] } = res.data;
          let format = 'jpg';
          if (profile[1] !== undefined) {
            const { formats } = profile[1];
            if (formats.includes('png')) {
              format = "png";
            } 
          }
          let source_config = {
            "@context": "http://iiif.io/api/image/2/context.json",
            protocol: "http://iiif.io/api/image",
            profile: ["http://iiif.io/api/image/2/level2.json"],
            preferredFormats: [format],
            fitBounds: true,
            height,
            width,
          }

          // As explained below, we stack images on top of the other instead of calling `viewer.open`
          // So if the viewer receives images of varying sizes, old images risk overflowing....
          const changed_image_dimension = (!!this.state.image_width && !!this.state.image_height) && (this.state.image_width !== width || this.state.image_height !== height)
          if (changed_image_dimension) {
            if (viewer_new.world.getItemCount() > 0) // todo: in a while-loop?
              viewer_new.world.removeItem(viewer_new.world.getItemAt(0))
            if (viewer_ref.world.getItemCount() > 0)
              viewer_ref.world.removeItem(viewer_ref.world.getItemAt(0))
          }

          this.setState({
            image_width: width,
            image_height: height,
            error: null,
          }, () => resolve())


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
            // console.log('[Init] loading meta for ref')
            viewer_ref.addTiledImage({
              tileSource: { ...source_config, "@id": iiif_url(output_ref.output_dir_url, path) },
              success: () => { },
            })
          }
        })
        .catch(error => {
          console.log(error)
          // If there is an error we don't want to show a previous image successfully loaded... 
          if (viewer_new.world.getItemCount() > 0)
            viewer_new.world.removeItem(viewer_new.world.getItemAt(0))
          if (viewer_ref.world.getItemCount() > 0)
            viewer_ref.world.removeItem(viewer_ref.world.getItemAt(0))
          this.setState({ error })
          reject({ error })
        });
    })
  }

  componentDidUpdate(prevProps, prevState) {
    const has_new = this.props.output_new !== undefined && this.props.output_new !== null;
    const has_ref = this.props.output_ref !== undefined && this.props.output_ref !== null;
    let updated_new = has_new && (prevProps.output_new === null || prevProps.output_new === undefined || prevProps.output_new.id !== this.props.output_new.id);
    let updated_ref = has_ref && (prevProps.output_ref === null || prevProps.output_ref === undefined || prevProps.output_ref.id !== this.props.output_ref.id);

    const has_path = this.props.path !== undefined && this.props.path !== null;
    let updated_path = has_path && (prevProps.path === null || prevProps.path === undefined || prevProps.path !== this.props.path);

    // console.log('updated_new', updated_new, 'updated_ref', updated_ref)
    if (updated_new || updated_ref || updated_path) {
      // console.log('-> Init()')
      if (this.props.id === undefined)
        console.log('If you update the image path, you have to provide a `props.id`, otherwise the component will crash because the viewers IDs depend on it')
      this.Init().then(() => {
        this.InitDiff();
        this.InitZoomSync();
      }).catch(error => { });
    }

    let updated_diff = prevProps.diff !== this.props.diff;
    if (updated_diff) {
      this.InitDiff(this.props);
    }
  }

  update_diff = () => {
    const { viewer_new, viewer_ref } = this;

    let { width = 1, height = 1 } = viewer_new.drawer.canvas;
    // let data_new = viewer_new.drawer.canvas.getContext('2d').getImageData(0, 0, 1+width/2, 1+height/2);
    let data_new = viewer_new.drawer.canvas.getContext('2d').getImageData(0, 0, width, height);
    let data_ref = viewer_ref.drawer.canvas.getContext('2d').getImageData(0, 0, width, height);

    // this.imageLayer.invalidate()

    // console.log("width-height:", width, height)
    // let size = new OpenSeadragon.Point(viewer_new.container.clientWidth || 1, viewer_new.container.clientHeight || 1);
    // console.log("size:", size.x, size.y)
    // console.log(viewer_new)
    // let data_new = viewer_new.drawer.context.getImageData(0, 0, size.x, size.y);
    // let data_ref = viewer_ref.drawer.context.getImageData(0, 0, size.x, size.y);
    // console.log(data_new)

    var canvas_diff_element = this.canvas_diff.current;
    if (!!canvas_diff_element) {
      canvas_diff_element.style.cssText = viewer_new.drawer.canvas.style.cssText
      canvas_diff_element.width = width
      canvas_diff_element.height = height

      let div_diff = canvas_diff_element.parentNode
      div_diff.style.cssText = viewer_new.drawer.canvas.parentNode.style.cssText

      let div2_diff = div_diff.parentNode
      div2_diff.style.cssText = viewer_new.drawer.canvas.parentNode.parentNode.style.cssText

      var diff_data = canvas_diff_element.getContext("2d").createImageData(width, height);
      pixelmatch(data_new.data, data_ref.data, diff_data.data, width, height, {
        colorScale: true,
        threshold: this.state.diff_threshold,
        includeAA: true,
      });
      canvas_diff_element.getContext("2d").putImageData(diff_data, 0, 0);
      // canvas_diff_element.getContext("2d").putImageData(data_new, 0, 0);
    }
  }


  InitDiff(props) {
    const { viewer_new, viewer_ref } = this;
    // Implemement perceptual differences
    /*
    let { width = 1, height = 1 } = viewer_new.drawer.canvas;

    var canvas_diff_ssim_element = this.canvas_diff_ssim.current;
    const config_ssim = {
      type: 'Difference',
      imageA: {
        type: 'CanvasImage',
        // type: 'HdrImage',
        width,
        height,
        nChannels: 3,
        canvas: viewer_new.drawer.canvas,
        // data: data_new.buffer,
      },
      imageB: {
        type: 'CanvasImage',
        // type: 'HdrImage',
        width,
        height,
        nChannels: 3,
        canvas: viewer_ref.drawer.canvas,
        // data: data_ref.buffer,
      },
      width,
      height,
      nChannels: 3,
      lossFunction: lossFunctionFromString('SSIM'),
    }
    if (!!canvas_diff_ssim_element) {
      console.log("this.imageLayer = new ImageLayer(...)")
      this.imageLayer = new ImageLayer(canvas_diff_ssim_element, config_ssim);
    }
    */

    const { diff } = this.props;
    if (diff && this.canvas_diff.current) {
      const redirectEvent = eventType => {
        const canvas_el = this.canvas_diff.current;
        canvas_el.addEventListener(eventType, function (event) {
          // we cannot re-dispatch the event twice, we must copy it
          var new_event = new event.constructor(event.type, event)
          if (eventType.match(/(mouse|pointer)/)) {
            const rect_diff = canvas_el.getBoundingClientRect();
            const rect_new = viewer_new.drawer.canvas.getBoundingClientRect();
            new_event.delta_clientX = rect_new.left - rect_diff.left;
            new_event.delta_clientY = rect_new.top - rect_diff.top;
          }
          viewer_new.drawer.canvas.dispatchEvent(new_event);
          event.preventDefault();
          event.stopPropagation();
        });
      }
      redirectEvent('mouseover');
      redirectEvent('mousemove');

      redirectEvent('click');
      redirectEvent('dblclick');
      redirectEvent('keyup');
      redirectEvent('keydown');
      redirectEvent('keypress');

      redirectEvent('mousedown');
      redirectEvent('mouseup');

      redirectEvent('focus');
      redirectEvent('blur');
      redirectEvent('wheel');

      redirectEvent('pointercancel');
      redirectEvent('pointerdown');
      redirectEvent('pointermove');
      redirectEvent('pointerover');
      redirectEvent('pointerout');
      redirectEvent('pointerup');

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


  InitSelectionTool(props) {
    const { viewer_new } = this;
    const selection_options = {
      onSelection: rect => { console.log(rect) },

      onSelectionChange: ({ canvasCoords, imageCoords }) => {
        this.show_histogram = true;
        this.canvasCoords = canvasCoords;
        this.imageCoords = imageCoords;
        this.update_histogram();
      },
      showConfirmDenyButtons: false,
      restrictToImage: true,
      allowRotation: false,
    }

    this.selection = viewer_new.selection(selection_options);
    viewer_new.addHandler('update-viewport', this.update_histogram);
    viewer_new.addHandler('selection_cancel', () => { this.show_histogram = false; });
    viewer_new.addHandler('selection_toggle', ({ enabled }) => { this.show_histogram = enabled; this.update_histogram(); });
  }

  InitFilters() {
    const { viewer_new, viewer_ref } = this;
    // console.log('[InitFilters]')
    viewer_new.imagefilters({ sync_key: this.props.path });
    viewer_ref.imagefilters({ sync_key: this.props.path });
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

  render() {
    const { output_new, output_ref, diff, label, path } = this.props;
    const { first_image, width, image_height, image_width, error, hide_labels } = this.state;

    const has_reference = !!output_ref && !!output_ref.output_dir_url;
    const has_error = !!error && Object.keys(error).length > 0;
    const error_messages = !has_error ? <span/> : <Popover inheritDarkTheme portalClassName={Classes.DARK} hoverCloseDelay={500} interactionKind={"hover"}>
        <Tag intent={Intent.DANGER}>Image Dowload Error</Tag>
        <div style={{ padding: '5px' }}>
          {!!error.message && <p>{JSON.stringify(error.message)}</p>}
          {!!error.request && <p>You may <a href={error.config.url}>find why here</a>.</p>}
          {!!error.response && !!error.response.data && <p>response.data: {JSON.stringify(error.response.data)}</p>}
          {!!error.data && <p>data: {JSON.stringify(error.data)}</p>}
        </div>
    </Popover>;

    const single_image_width = Math.floor((width - 10) / (diff ? 3 : 2));
    const single_image_height = !!image_height ? Math.floor(image_height / image_width * single_image_width) : 0
    const flex = { flex: '0 0 auto' }
    const single_image_size = {
      width: `${single_image_width}px`,
      height: `${single_image_height}px`,
    }
    const histogram_size_tight = {
      width: `${(width - 10) / 2 * 0.9}px`,
      height: `${image_height / image_width * (width - 10) / 2}px`,
    }

    const switch_label = <Tag interactive rightIcon="exchange" onClick={this.switch_images}>Switch</Tag>;
    const switch_help_label = <span>Switch New/Reference with the keyboard shortcut <kbd>t</kbd>. Hide labels with <kbd>h</kbd></span>
    const image_new = <div style={flex} key="new">
      {has_reference && <div style={{ minHeight: (diff ? '40px' : undefined) }}>
        {!hide_labels ? <Tooltip><Tag
          interactive
          intent="warning"
          rightIcon="exchange"
          onClick={this.switch_images}
        >new</Tag>{switch_help_label}</Tooltip> : switch_label}
      </div>}
      <div style={single_image_size} id={this.viewer_new.id} key={this.viewer_new.id} />
    </div>
    const image_ref = <div style={flex} key="ref">
      {has_reference && <div style={{ minHeight: (diff ? '40px' : undefined) }}>
        {!hide_labels ? <Tooltip><Tag
          interactive
          intent="primary"
          rightIcon="exchange"
          title="Switch New/Reference with the keyboard shortcut <code>t</code>. Hide labels with <h>"
          onClick={this.switch_images}
        >reference</Tag>{switch_help_label}</Tooltip> : switch_label}
      </div>}
      <div style={single_image_size} id={this.viewer_ref.id} key={this.viewer_ref.id} hidden={!has_reference} />
    </div>


    const histo_layout = {
      width: (width - 10) / 2 * 0.9,
      height: (image_height / image_width * (width - 10) / 2) * 0.9,
      autosize: false,
      traceorder: 'reversed+grouped',
      barmode: 'overlay',
      yaxis: {
        tickformat: '.1%',
      }
    }
    const hist_info = this.show_histogram ? <div style={flex}>
      <Plot data={[...(this.histo_ref || []), ...(this.histo_new || [])]} layout={histo_layout} style={histogram_size_tight} />
    </div> : <></>

    const diff_info = single_image_height > 0 ? <div hidden={!diff || !has_reference} style={flex}>
      <div style={{ minHeight: '40px' }}>
        <MultiSlider
          defaultTrackIntent={Intent.WARNING}
          labelPrecision={2}
          labelRenderer={label => `${(100 * label).toFixed(0)}%`}
          labelStepSize={0.1}
          min={0}
          max={0.3}
          onChange={([diff_threshold]) => {
            this.setState({ diff_threshold }, () => this.update_diff())
          }}
          stepSize={0.01}
          showTrackFill
          style={{ width: single_image_size.width }}
        >
          <MultiSlider.Handle value={this.state.diff_threshold} intentAfter={Intent.NONE} />
        </MultiSlider>
      </div>
      <div style={single_image_size}>
        <div><div>
          <canvas hidden={!diff || !has_reference} ref={this.canvas_diff} />
        </div></div>
      </div>
      <br />
      <Tooltip hoverCloseDelay={500}>
        <p><Icon icon="info-sign" style={{ color: Colors.GRAY2 }} /></p>
        <ul>
          <li>The color difference is computed according to the paper "Measuring perceived color difference using YIQ NTSC transmission color space in mobile applications" by Y. Kotsarenko and F. Ramos</li>
          <li>The colorscale shows the color difference ~linearly until selected saturation threshold.</li>
          <li>Until 5% of the threshold, a greyed-out source image is shown</li>
          <li>Anti-aliased pixels are shown as yellow at most.</li>
        </ul>
      </Tooltip>
    </div> : <></>
    //       {/* <canvas hidden={!diff || !has_reference} ref={this.canvas_diff_ssim} /> */}

    // const empty_image = <canvas key="empty-image" {...single_image_size} />
    return <>
      {error_messages}
      {!has_error && <>
        {this.state.ready && has_reference &&
          <MultiSelectTags
            output_new={output_new}
            output_ref={output_ref}
            viewer_new={this.viewer_new}
            viewer_ref={this.viewer_ref}
            path={path}
            qatools_config={this.props.qatools_config}
          />}
        <span>
          <Tooltip>
            <Icon icon="info-sign" style={{ color: Colors.GRAY2 }} />
            <ul>
              <li>This image is not the real image! It's JPEG compressed (100-quality).</li>
              <li>Histograms (RGB+Y) are computed on the rendered low-resolution image.</li>
            </ul>
          </Tooltip>
          <CoordTooltip color={this.state.color_new} />
          {this.show_histogram && !!this.imageCoords && <CropSelection imageCoords={this.imageCoords} />}
          <ColorTooltip color={first_image === 'new' ? this.state.color_new : this.state.color_ref} />
          <ColorTooltip color={first_image === 'new' ? this.state.color_ref : this.state.color_new} />
          {label && (label || path)}
        </span>
      </>}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignContent: 'center', paddingBottom: 5 }} hidden={has_error}>
        {first_image === 'new' ? image_new : image_ref}
        {diff_info}
        {first_image === 'new' ? image_ref : image_new}
      </div>
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center"}} hidden={has_error}>
        {hist_info}
      </div>
    </>
  }

  switch_images = e => {
    let first_image = this.state.first_image === 'reference' ? 'new' : 'reference';

    // For some reason the scroll jumps arounds when react re-renders
    const x = window.scrollX
    const y = window.scrollY
    // The tentatives below don't help :|
    // if(!!e) {
    //   e.stopPropagation() 
    //   e.preventDefault() 
    // }
    // if (!!e && !!e.target)
    //   e.target.blur() 
    // document.activeElement.blur();
    this.setState({ first_image }, () => window.scrollTo(x, y))
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
