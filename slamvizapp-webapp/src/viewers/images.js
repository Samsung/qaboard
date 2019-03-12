import React, { PureComponent } from "react";
import { get } from "axios"
import { Tag } from "@blueprintjs/core";
import pixelmatch from 'pixelmatch';

import { ColorTooltip } from './images/tooltip';
import "./image-canvas.css";

var OpenSeadragon = require('openseadragon')
require('./images/rgb')

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
    this.canvas_diff = React.createRef();
    this.state = {
      first_image: "new",
      width: parseFloat(((this.props.style || {}).width || '390px').replace(/[^\d]+/, '')),
      height: 217, // default 4/3 ratio
      diff_threshold: 0.1,
      color: {},
    }
  }

  componentDidMount() {
    const { output_new } = this.props;
    let viewer_new = OpenSeadragon({
        ...openseadragon_config,
        id: `osd-new-${output_new.output_dir_url}`,
      });
    let viewer_ref = OpenSeadragon({
        ...openseadragon_config,
        id: `osd-ref-${output_new.output_dir_url}`,
    });

    this.setState({
      viewer_new,
      viewer_ref,
    }, () => {
      this.Init(this.props);
      this.InitMouseTracker(this.props);
      this.InitZoomSync();
      this.InitDiff();
    })

    window.addEventListener("keypress", this.keyboard);
  }

  componentWillUnmount() {
      window.removeEventListener('keypress', this.keypress);
  }

  keyboard = ev => {
    switch (ev.key || String.fromCharCode(ev.keyCode || ev.charCode)) {
      case "t":
    	let first_image = this.state.first_image === 'reference' ? 'new' : 'reference';
    	this.setState({first_image})
      default:
        return;
    }
  }

  componentDidUpdate(prevProps, prevState) {
      let updated_new =
        prevProps.output_new !== undefined &&
        prevProps.output_new !== null &&
        (this.props.output_new == null ||
          prevProps.output_new.id !== this.props.output_new.id);
      let updated_ref =
        prevProps.output_ref !== undefined &&
        prevProps.output_ref !== null &&
        (this.props.output_ref == null ||
          prevProps.output_ref.id !== this.props.output_ref.id);
      if (updated_new || updated_ref) {
        this.Init(this.props);
      }

      let updated_diff = prevProps.diff !== this.props.diff;
      if (updated_diff) {
        this.InitDiff(this.props);
      }
  }

  InitDiff(props) {
    // Implemement perceptual differences
    const { viewer_new, viewer_ref} = this.state;
    const { diff } = this.props;
    if (diff) {
      var update_diff = () => {
        let size_new = new OpenSeadragon.Point(viewer_new.container.clientWidth || 1, viewer_new.container.clientHeight || 1);
        let canvas_new = viewer_new.drawer.canvas
        let canvas_ref = viewer_ref.drawer.canvas
        let data_new = canvas_new.getContext("2d").getImageData(0, 0, size_new.x, size_new.y);
        let data_ref = canvas_ref.getContext("2d").getImageData(0, 0, size_new.x, size_new.y);
        var canvas_diff_element = this.canvas_diff.current;
        if (!!canvas_diff_element) {
          var diff_data = canvas_diff_element.getContext("2d").createImageData(size_new.x, size_new.y);
          pixelmatch(data_new.data, data_ref.data, diff.data, size_new.x, size_new.y, {threshold: this.state.diff_threshold});
          canvas_diff_element.getContext("2d").putImageData(diff_data, 0, 0);          
          // var point = new OpenSeadragon.Point(0.5, 0.5)
          // viewer_ref.addOverlay(`osd-diff-${output_new.output_dir_url}`, point, OpenSeadragon.Placement.CENTER)
        }
      }
      viewer_new.addHandler('animation-finish', update_diff);
      // viewer_new.addHandler('tile-drawn', update_diff);
      update_diff()
    }
  }

  InitZoomSync() {
    // Implemement synced zoom
    // https://codepen.io/iangilman/pen/BWKKxQ
    const { viewer_new, viewer_ref} = this.state;
    var masterZoom;
    var masterCenter;
    var viewer_newLeading = false;
    var viewer_refLeading = false;
    var viewer_newHandler = function() {
      if (viewer_refLeading)
        return;
      masterZoom = viewer_new.viewport.getZoom();
      masterCenter = viewer_new.viewport.getCenter();
      if (masterCenter===undefined || masterCenter===null) return 

      viewer_newLeading = true;
      viewer_ref.viewport.zoomTo(masterZoom);
      viewer_ref.viewport.panTo(masterCenter);
      viewer_newLeading = false;
    };

    var viewer_refHandler = function() {
      if (viewer_newLeading)
        return;
      masterZoom = viewer_ref.viewport.getZoom();
      masterCenter = viewer_ref.viewport.getCenter();
      if (masterCenter===undefined || masterCenter===null) return

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
    window.addEventListener('resize', maintainZoom);
    this.setState({maintainZoom});
  }

  Init() {
    const { path, output_new, output_ref } = this.props;
    const has_reference = !!output_new && !!output_new.output_dir_url;

    get(`${iiif_url(output_new.output_dir_url, path)}/info.json`).then(res => {
      this.setState({loaded: true})
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
      })

      const { viewer_new, viewer_ref } = this.state;

      viewer_new.open([{
        ...source_config,
        "@id": iiif_url(output_new.output_dir_url, path),
      }])
      if (has_reference) {
        viewer_ref.open([{
	        ...source_config,
	        "@id": iiif_url(output_ref.output_dir_url, path),
        }])
      }
    }).catch(error => {
      this.setState({error})
    });
  }

  InitMouseTracker() {
    const { viewer_new, viewer_ref} = this.state;
    var rgb_new = viewer_new.rgb({
      onCanvasHover: color_new => {
        const { x, y } = color_new.viewportCoordinates
        const color_ref = rgb_ref.getValueAt(x, y)
        this.setState({color_new, color_ref})
      }
    });
    var rgb_ref = viewer_ref.rgb({
      onCanvasHover: color_ref => {
        const { x, y } = color_ref.viewportCoordinates
        const color_new = rgb_new.getValueAt(x, y)
        this.setState({color_new, color_ref})
    }});

  }

  render() {
    const { output_new, output_ref, diff, label, path } = this.props;
    const { first_image, width, image_height, image_width } = this.state;
    let no_reference = !!!output_ref || !!!output_ref.output_dir_url;
    // if (!!error)
    //   return <span>{JSON.stringify(this.state.error)}</span>;

    const single_image_width = (width - 10) / 2
    const single_image_height = !!image_height ? image_height / image_width * single_image_width : 0
    const single_image = {
    	width: `${single_image_width}px`,
    	height: `${single_image_height}px`,
    	flex: '0 0 auto',
    }
    let images = [
	      <div style={single_image} id={`osd-new-${output_new.output_dir_url}`} key={`osd-new-${output_new.output_dir_url}`} />,
	      <div style={single_image} id={`osd-ref-${output_new.output_dir_url}`} key={`osd-ref-${output_new.output_dir_url}`} hidden={no_reference}/>,
    ]

    const colors = [
      <ColorTooltip color={this.state.color_new} key="new" />,
      <ColorTooltip color={this.state.color_ref} key="reference"/>,
    ]

    if (first_image === 'reference') {
      images = images.reverse();
      colors = colors.reverse();      
    }

    return <>
      <span>
        <Tag intent={first_image === "reference" ? "primary" : "warning"}>{first_image}</Tag>
        {colors}
        {label && (label || path)}
      </span>
      <div style={{display: 'flex'}}>
        {images}
	      {single_image_height && <div hidden={!diff || no_reference} style={single_image}>
          <canvas hidden={!diff || no_reference} ref={this.canvas_diff} width={single_image_width} height={single_image_height} />
        </div>}
      </div>
    </>
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
