import React from "react";
import { connect } from "react-redux";
import { get, CancelToken, isCancel } from "axios"
import {
  Classes,
  Colors,
  Intent,
  Tag,
  Icon,
  Tooltip,
  Popover,
  MultiSlider,
  Menu,
  MenuItem,
} from "@blueprintjs/core";
import Plot from 'react-plotly.js';
import pixelmatch from './pixelmatch';
// import { lossFunctionFromString } from "./jeri/src/layers/Layer.ts"
// import ImageLayer from "./jeri/src/layers/ImageLayer.ts"

import { Tooltips } from './tooltip';
import "./image-canvas.css";
import { histogram_traces } from './histogram';
import { CropSelection } from "./crops";
import { iiif_url } from "./utils";

import { RoiViewer } from './roi_viewer'

import { unregister_filter_sync } from "./filters"
import { toaster } from "../../toaster"

import { is_same_data, copyElementToClipboard } from "../../utils"
var OpenSeadragon = require('openseadragon')
require('./selection')
require('./rgb')
require('./filters')

// Fix for https://github.com/openseadragon/openseadragon/issues/1683
// ...but it disables transparency!
OpenSeadragon.Tile.prototype._hasTransparencyChannel = () => false


const openseadragon_config = {
  visibilityRatio: 1,
  preserveViewport: true,

  springStiffness: 15,
  animationTime: 0,

  defaultZoomLevel: 1,
  minZoomLevel: 1,
  // maxZoomLevel: 10,
  maxZoomPixelRatio: 50,
  minZoomImageRatio: 50,

  imageSmoothingEnabled: false,
  smoothTileEdgesMinZoom: 1000000,

  controlsFadeDelay: 0,
  controlsFadeLength: 200,
  showNavigator: true,
  prefixUrl: "/openseadragon/",
  showFullPageControl: false,

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


const make_cross = () => {
  const color = "white"; // red is OKish too
  const size = "20px"
  const thickness = "2px"
  // const color = "rgba(255, 0, 0, 0.5)";  // Semi-transparent red
  const crossElement = document.createElement("div");
  crossElement.className = "viewer-cross"
  crossElement.style.position = "absolute";
  crossElement.style.width = size;
  crossElement.style.height = size;
  crossElement.style.pointerEvents = "none";

  const horizontalLine = document.createElement("div");
  horizontalLine.style.position = "absolute";
  horizontalLine.style.width = "100%";
  horizontalLine.style.height = thickness;
  horizontalLine.style.backgroundColor = color
  horizontalLine.style.top = "50%";  // Center the horizontal line
  horizontalLine.style.transform = "translateY(-50%)";

  const verticalLine = document.createElement("div");
  verticalLine.style.position = "absolute";
  verticalLine.style.height = "100%";
  verticalLine.style.width = thickness;
  verticalLine.style.backgroundColor = color
  verticalLine.style.left = "50%";  // Center the vertical line
  verticalLine.style.transform = "translateX(-50%)";

  crossElement.appendChild(horizontalLine);
  crossElement.appendChild(verticalLine);
  return crossElement
}


function maintain_zoom() {
  // console.log("[maintain_zoom]")
  Object.values(synced_viewers).forEach(sync_group => {
    if (Object.values(sync_group.viewers).some(v => v === null || v === undefined))
      return;
    sync_group.leading = "resize";
    try { // we should try to find how to identify when an image is not loaed...
      sync_group.viewers.forEach(v => {
        const size = new OpenSeadragon.Point(v.container.clientWidth ?? 1, v.container.clientHeight ?? 1);
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
      ready: false, // viewer mounted
      fullyLoaded: {}, // e.g. 'new': true
      cancel_source: CancelToken.source(),
      first_image: "new",
      width: Math.floor(parseFloat((this.props.style?.width ?? '390px').replace(/[^\d]+/, ''))),
      height: 217, // default 4/3 ratio
      hide_labels: false,
      diff_threshold: 0.05,
      color: {}, // rgb values as displayed on the screen
      x: null, // hover xy from in real image coordinates
      y: null,
      has_reference: false,
      x_ref: null, // hover xy from in real image coordinates
      y_ref: null,
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
      this.InitMouseSync();
      this.InitFilters();
      this.InitSelectionTool();
      this.InitDiff();
      window.addEventListener("keypress", this.keyboard, { passive: true });
    }).catch(error => { console.log("Init Error:", JSON.stringify(error)) })
  }

  InitZoomSync() {
    if (!!this.UnregisterZoomSync)
      this.UnregisterZoomSync()

    // console.log("[InitZoomSync]")
    // Implemement synced zoom
    // https://codepen.io/iangilman/pen/BWKKxQ
    const { viewer_new, viewer_ref, canvas_diff } = this;
    const { image_width, image_height } = this.state;
    // const sync_key = `${this.props.output_new.test_input_path}-${image_height}x${image_width}`;
    const sync_key = `${this.props.output_new.test_input_path}-${(image_height/image_width).toFixed(3)}`;
    // console.log("sync_key", sync_key)

    if (synced_viewers[sync_key] === undefined) {
      // console.log("init synced viewers", sync_key)
      synced_viewers[sync_key] = {
        viewers: [viewer_new, viewer_ref],
        diff_canvases: [canvas_diff],
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
      if (synced_viewers[sync_key].diff_canvases.every(c => c !== canvas_diff))
        synced_viewers[sync_key].diff_canvases.push(canvas_diff)
    }


    var lead_viewer_sync = (sync_key, viewer) => () => {
      // console.log("[lead_viewer_sync]")
      let { leading } = synced_viewers[sync_key];
      if (!!leading && (leading !== viewer.id && leading !== 'resize'))
        return;
      // synced_viewers[sync_key].height = viewer.source.height
      // synced_viewers[sync_key].width = viewer.source.width
      synced_viewers[sync_key].zoom = viewer.viewport.getZoom();
      synced_viewers[sync_key].center = viewer.viewport.getCenter();
      // console.log(`leading with ${viewer.id} to ${synced_viewers[sync_key].zoom} / ${synced_viewers[sync_key].center} (${viewer.source.height}:${viewer.source.height})`)      
      if (synced_viewers[sync_key].center === undefined || synced_viewers[sync_key].center === null)
        return
      synced_viewers[sync_key].leading = viewer.id;
      synced_viewers[sync_key].viewers.filter(v => v.id !== viewer.id).forEach(v => {
        // console.log(`  follow for ${v.id} (${v.source.height}:${v.source.width})`)
        // console.log(v.source.width)
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
        synced_viewers[sync_key].diff_canvases = synced_viewers[sync_key].diff_canvases.filter(
          c => c !== canvas_diff
        )
      }
      this.UnregisterZoomSync = null;
    }

  }


  InitMouseSync() {
    // relies on InitZoomSync already being done
    const { viewer_new, viewer_ref } = this;
    const { image_width, image_height } = this.state;
    const sync_key = `${this.props.output_new.test_input_path}-${(image_height/image_width).toFixed(3)}`;
    try {
      [viewer_new, viewer_ref]
      .forEach(viewer => {
        viewer.mouse_tracker = new OpenSeadragon.MouseTracker({
          element: viewer.container,
          // startDisabled: true,
          moveHandler: event => {
            // console.log("moveHandler")
            const webPoint = event.position; // Mouse position in web coordinates (relative to the viewer1 DOM element)
            const viewportPoint = viewer.viewport.pointFromPixel(webPoint);
            synced_viewers[sync_key].viewers.forEach(synced_viewer => {
              synced_viewer.clearOverlays()              
              const element = make_cross()
              synced_viewer.addOverlay({
                element,
                location: viewportPoint,
                placement: OpenSeadragon.Placement.CENTER,
                checkResize: false,
              });    
            })
            synced_viewers[sync_key].diff_canvases.forEach(synced_canvas => {
              if (synced_canvas.current)
              addOverlayToCanvas(synced_canvas.current, webPoint);
            })
          }
        })
        viewer.addHandler('canvas-enter', (event) => {
          viewer.mouse_tracker.setTracking(true);
          // console.log("istracking", viewer.mouse_tracker.isTracking())
        });
        viewer.addHandler('canvas-exit', (event) => {
          // console.log("canvas-exit")
          // TODO: Ideally we'd stop tracking but for some reason tracking won't ever restart (!?)
          // viewer.mouse_tracker.setTracking(false);
          synced_viewers[sync_key].viewers.forEach(synced_viewer => {
            synced_viewer.clearOverlays();
          })
          synced_viewers[sync_key].diff_canvases.forEach(synced_canvas => {
            if (synced_canvas.current)
              clearOverlay(synced_canvas.current);
          })
        });
    })
    } catch (error) {
      console.error("ERROR: while setting up mouse move:", error);
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
      let { path_ref=this.props.path } = this.props
 
      let has_reference = !!output_ref && !output_ref.deleted && !!output_ref.output_dir_url && this.props.manifests.reference[path_ref] !== undefined;
      this.setState({has_reference})

      const { imageServers } = this.props;
      let requests = [get(`${iiif_url(output_new.output_dir_url, path, imageServers)}/info.json`, { cancelToken: this.state.cancel_source.token })]
      if (has_reference)
        requests.push(get(`${iiif_url(output_ref.output_dir_url, path_ref, imageServers)}/info.json`, { cancelToken: this.state.cancel_source.token }))
      Promise.all(requests).then( ([res_new, res_ref]) => {
        this.setState({ loaded: true })
        // https://Openseadragon.github.io/examples/tilesource-iiif/
        // image dimensions
        const { height, width, profile=[] } = res_new.data;
        let format = 'jpg';
        if (profile[1] !== undefined) {
          const { formats } = profile[1];
          if (formats === undefined || formats.includes('png')) {
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
          image_height_ref: res_ref?.data?.height,
          image_width_ref: res_ref?.data?.width,
          error: null,
        }, () => resolve())

        viewer_new.world.addHandler('add-item', addItemEvent => {
          var tiledImage = addItemEvent.item;
          tiledImage.addHandler('fully-loaded-change', e => {
              this.setState({ fullyLoaded: {...this.state.fullyLoaded, 'new': e.fullyLoaded} })
          });
        });
        viewer_new.world.addHandler('add-item', addItemEvent => {
          var tiledImage = addItemEvent.item;
          tiledImage.addHandler('fully-loaded-change', e => {
              this.setState({ fullyLoaded: {...this.state.fullyLoaded, 'ref': e.fullyLoaded} })
          });
        });

        viewer_new.addHandler('tile-load-failed', ({tile, message}) => {
          this.setState({ error: {
            message: `Could not load at least one part of the image (${tile}): ${message}`,
          }})
        });
        if (has_reference) {
          viewer_ref.addHandler('tile-load-failed', ({tile, message}) => {
            this.setState({ error: {
              message: `Could not load at least one part of the image (${tile}): ${message}`,
            }})
          });
        }

        // Trying to replace images using `viewer.open` first closes the image, so there is a blank if one change the image path...
        // https://github.com/openseadragon/openseadragon/issues/1428
        // let viewer_new_is_open = viewer_new.isOpen()
        viewer_new.addTiledImage({
          tileSource: { ...source_config, "@id": iiif_url(output_new.output_dir_url, path, imageServers) },
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
            tileSource: {
              ...source_config,
              width: res_ref?.data?.width,
              height: res_ref?.data?.height,
              "@id": iiif_url(output_ref.output_dir_url, path_ref, imageServers),
            },
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
      this.InitDiff();
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
    if (canvas_diff_element) {
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


  InitDiff = () => {
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
    if (diff) {
      viewer_new.addOnceHandler('update-viewport', this.update_diff, {}, 3);
      viewer_ref.addOnceHandler('update-viewport', this.update_diff, {}, 3);
      viewer_new.addHandler('animation-finish', this.update_diff);
      this.update_diff()

        const canvas_el = this.canvas_diff.current;
      if (canvas_el) {
        // console.log("redirecting events of", canvas_el)
        canvas_el.addEventListener('click', () => {console.log("click")})
        canvas_el.onClick = () => {console.log("onClick")}
        canvas_el.onclick = () => {console.log("onclick")}
        const redirectEvent = eventType => {
          // return
        canvas_el.addEventListener(eventType, function (event) {
            console.log("event@", eventType)
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
      }
    }
  }


  update_histogram = () => {
    if (!this.show_histogram)
      return
    this.histo_new = histogram_traces(this.viewer_new, this.canvasCoords, 'new')
    if (this.state.has_reference)
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
        if (this.state.has_reference) {
          const color_ref = rgb_ref.getValueAt(color_new.viewportCoordinates.x, color_new.viewportCoordinates.y)
          this.setState({
            color_ref,
            // best effort, will fails if images don't have the right image ratios...
            x_ref: color_new.imageCoordinates?.x * this.state.image_width_ref / this.state.image_width,
            y_ref: color_new.imageCoordinates?.y * this.state.image_height_ref / this.state.image_height,
          })
        }
        this.setState({
          x: color_new.imageCoordinates?.x,
          y: color_new.imageCoordinates?.y,
          color_new,
        })
      }
    });
    var rgb_ref = viewer_ref.rgb({
      onCanvasHover: color_ref => {
        if (!!!color_ref.viewportCoordinates)
          return
        const color_new = rgb_new.getValueAt(color_ref.viewportCoordinates.x, color_ref.viewportCoordinates.y)
        this.setState({
          x_ref: color_ref.imageCoordinates?.x,
          y_ref: color_ref.imageCoordinates?.y,
          x: color_ref.imageCoordinates?.x * this.state.image_width / this.state.image_width_ref,
          y: color_ref.imageCoordinates?.y * this.state.image_height / this.state.image_height_ref,
          color_new,
          color_ref,
        })
      }
    });
  }

  render() {
    const { output_new, output_ref, diff, label, path, manifests } = this.props;
    let { path_ref=this.props.path } = this.props
    const {
      first_image,
      width,
      image_height, image_width, image_height_ref, image_width_ref,
      error, hide_labels, has_reference
    } = this.state;
    
    const has_same_data = is_same_data(path, manifests?.new?.[path], manifests?.reference?.[path_ref])

    const has_error = !!error && Object.keys(error).length > 0;
    const error_messages = !has_error ? <span/> : <>
      {manifests?.new?.[path]?.st_size == 0 && <Tag style={{marginRight: "5px"}} intent={Intent.DANGER}>Empty Image</Tag>}
      <Popover inheritDarkTheme popoverClassName={Classes.DARK} hoverCloseDelay={500} interactionKind={"hover"} content={
          <div style={{ padding: '5px' }}>
            {!!error.message && <p>{JSON.stringify(error.message)}</p>}
            {!!error.request && <p>You may <a href={error.config.url}>find why here</a>.</p>}
            {!!error.response && !!error.response.data && <p>response.data: {JSON.stringify(error.response.data)}</p>}
            {!!error.data && <p>data: {JSON.stringify(error.data)}</p>}
          </div>}
      >
          <Tag intent={Intent.DANGER}>Image Dowload Error</Tag>
      </Popover>
    </>;

    const vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0)
    const available_width = this.props.fullscreen ? (has_reference ? vw : 2*vw) : width

    const single_image_width = Math.floor((available_width - 10) / ((diff && has_reference) ? 3 : 2));
    const single_image_height = !!image_height ? Math.floor(image_height / image_width * single_image_width) : 0
    const flex = { flex: '0 0 auto' }
    const single_image_size = {
      width: `${single_image_width}px`,
      height: `${single_image_height}px`,
    }
    const histogram_size_tight = {
      width: `${(available_width - 10) / 2 * 0.9}px`,
      height: `${image_height / image_width * (available_width - 10) / 2}px`,
    }

    const switch_label = <Tag interactive rightIcon="exchange" onClick={this.switch_images}>Switch</Tag>;
    const switch_help_label = <span>Switch New/Reference with the keyboard shortcut <kbd>t</kbd>. Hide labels with <kbd>h</kbd></span>

    const are_different_sizes = has_reference && (image_width !== image_width_ref || image_height !== image_height_ref)    
    image_height_ref
    image_width_ref

    const image_new = <div style={flex} key="new">
      {has_reference && <div style={{ minHeight: (diff ? '40px' : undefined) }}>
        {!hide_labels ? <Tooltip content={switch_help_label}><Tag
          interactive
          style={{backgroundColor: Colors.CERULEAN4}}
          rightIcon="exchange"
          onClick={this.switch_images}
        >new {path !== path_ref && path} <code>{image_width}x{image_height}</code></Tag></Tooltip> : switch_label}
      </div>}
      <div style={single_image_size} id={this.viewer_new.id} key={this.viewer_new.id} />
    </div>
    const image_ref = <div style={flex} key="ref">
      {has_reference && <div style={{ minHeight: (diff ? '40px' : undefined) }}>
        {!hide_labels ? <Tooltip content={switch_help_label}><Tag
          interactive
          rightIcon="exchange"
          title="Switch New/Reference with the keyboard shortcut <code>t</code>. Hide labels with <h>"
          onClick={this.switch_images}
        >{!has_same_data ? <span>reference {path !== path_ref && path_ref} <code>{image_width_ref}x{image_height_ref}</code></span> : 'reference (same-image)'}</Tag></Tooltip> : switch_label}
      </div>}
      <div style={single_image_size} id={this.viewer_ref.id} key={this.viewer_ref.id} hidden={!has_reference || has_same_data} />
    </div>


    const histo_layout = {
      width: (available_width - 10) / 2 * 0.9,
      height: (image_height / image_width * (available_width - 10) / 2) * 0.9,
      autosize: false,
      traceorder: 'reversed+grouped',
      barmode: 'overlay',
      yaxis: {
        tickformat: '.1%',
      }
    }
    let data_histograms = []
    if (this.show_histogram) {
      if (this.histo_ref && !has_same_data) {
        data_histograms.push(...this.histo_ref)
      }
      if (this.histo_new) {
        data_histograms.push(...this.histo_new)
      }  
    }
    const hist_info = this.show_histogram ? <div style={flex}>
      <Plot
        data={data_histograms}
        layout={histo_layout}
        style={histogram_size_tight}
      />
    </div> : <></>

    const diff_info = !has_same_data && single_image_height > 0 ? <div hidden={!diff || !has_reference} style={flex}>
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
        <div>
          <div className="canvas-container" style={{"position": "relative", "display": "inline-block"}}>
          <canvas hidden={!diff || !has_reference} ref={this.canvas_diff} />
            <div
              className="canvas-overlays-container"
              style={{position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none"}}
            ></div>
          </div>
        </div>
      </div>
      <br />
      <Tooltip hoverCloseDelay={500} content={<ul>
          <li>The color difference is computed according to the paper "Measuring perceived color difference using YIQ NTSC transmission color space in mobile applications" by Y. Kotsarenko and F. Ramos</li>
          <li>The colorscale shows the color difference ~linearly until selected saturation threshold.</li>
          <li>Until 5% of the threshold, a greyed-out source image is shown</li>
          <li>Anti-aliased pixels are shown as yellow at most.</li>
      </ul>}>
        <p><Icon icon="info-sign" style={{ color: Colors.GRAY2 }} /></p>
      </Tooltip>
    </div> : <></>
    //       {/* <canvas hidden={!diff || !has_reference} ref={this.canvas_diff_ssim} /> */}

    // const empty_image = <canvas key="empty-image" {...single_image_size} />
    let current_roi = {
      x: 0,
      y: 0,
      width: this.viewer_new?.source?.width,
      height: this.viewer_new?.source?.height,
    } 
    if (!!this.viewer_new && !!this.viewer_new.viewport && this.viewer_new.world.getItemCount() > 0) {
      var viewportBounds = this.viewer_new.viewport.getBounds();
      let top_left = viewportBounds.getTopLeft()
      let bottom_right = viewportBounds.getBottomRight()
      const tiledImage = this.viewer_new.world.getItemAt(this.viewer_new.world.getItemCount() - 1);
      top_left = tiledImage.viewportToImageCoordinates(top_left.x, top_left.y);
      bottom_right = tiledImage.viewportToImageCoordinates(bottom_right.x, bottom_right.y);
      // Below is "not accurate with multi-images"
      // top_left = this.viewer_new.viewport.viewportToImageCoordinates(top_left.x, top_left.y)
      // bottom_right = this.viewer_new.viewport.viewportToImageCoordinates(top_left.x, top_left.y)
      current_roi.x = top_left.x
      current_roi.y = top_left.y
      current_roi.w = bottom_right.x - top_left.x
      current_roi.h = bottom_right.y - top_left.y
    }

    return <div style={{dispay: "inline"}}>
      {error_messages}
      {!has_error && <>
        {this.state.ready && <>
        <Popover placement="top" hoverCloseDelay={200} interactionKind={"hover"} content={
          <Menu>
              <MenuItem
                  text="Copy new image to the clipboard"
                  minimal
                  onClick={() => {
                    copyElementToClipboard(
                      this.viewer_new.canvas,
                      "new image",
                      message=>toaster.show({message, intent: Intent.SUCCESS})
                    )
                  }}
              />
              {has_reference && <MenuItem
                  text="Copy reference image to the clipboard"
                  minimal
                  onClick={() => {
                    copyElementToClipboard(
                      this.viewer_ref.canvas,
                      "ref image",
                      message=>toaster.show({message, intent: Intent.SUCCESS})
                    )
                  }}
              />}
              {has_reference && diff && <MenuItem
                  text="Copy diff image to the clipboard"
                  minimal
                  onClick={() => {
                    copyElementToClipboard(
                      this.canvas_diff.current,
                      "diff image",
                      message=>toaster.show({message, intent: Intent.SUCCESS})
                    )
                  }}
              />}
          </Menu>
          }>
              <Tag
                interactive
                minimal
                icon="duplicate"
                style={{ marginRight: "10px" }}
                onClick={() => {
                  copyElementToClipboard(
                    this.viewer_new.canvas,
                    "new image",
                    message=>toaster.show({message, intent: Intent.SUCCESS})
                  )
                }}
              >Copy</Tag>
          </Popover>
          <RoiViewer
            output_new={output_new}
            output_ref={!has_same_data ? output_ref : undefined}
            path={path}
            viewer={this.viewer_new}
            current_roi={current_roi}
            fullyLoaded={this.state.fullyLoaded.new && this.state.fullyLoaded.ref}
         />
        </>}
        <span>
          {this.show_histogram && <Tooltip content={<ul><li>Histograms (RGB+Y) are computed on the rendered low-resolution image.</li></ul>}>
            <Icon icon="info-sign" style={{ color: Colors.GRAY2 }} />
          </Tooltip>}
          <Tooltips
            x={this.state.x}
            y={this.state.y}
            x_ref={this.state.x_ref}
            y_ref={this.state.y_ref}
            color_new={this.state.color_new}
            color_ref={this.state.color_ref}
            image_url_new={`${this.props.output_new.output_dir_url}/${this.props.path}`}
            image_url_ref={`${this.props.output_ref?.output_dir_url}/${this.props.path_ref}`}
            has_reference={has_reference}
            first_image={first_image}
          />
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
    </div>
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


function clearOverlay(canvas) {
  const canvasContainer = canvas.parentElement;
  const overlaysContainer = canvasContainer.querySelector('.canvas-overlays-container');
  if (overlaysContainer) {
  overlaysContainer.innerHTML = '';
  }
}
function addOverlayToCanvas(canvas, position) {
  const canvasContainer = canvas.parentElement;
  const overlaysContainer = canvasContainer.querySelector('.canvas-overlays-container');
  if (overlaysContainer) {
  overlaysContainer.innerHTML = ''; // Clear previous overlays if needed
  }
  const cross = make_cross(); // Use your existing `make_cross` function
  cross.style.position = 'absolute';
  cross.style.transform = 'translate(-50%, -50%)';
  cross.style.left = `${position.x}px`;
  cross.style.top = `${position.y}px`;
  if (overlaysContainer) {
  overlaysContainer.appendChild(cross);
  }
}

const mapStateToProps = state => ({
  imageServers: state.siteConfig?.image_servers,
});

export default connect(mapStateToProps)(ImgViewer);
