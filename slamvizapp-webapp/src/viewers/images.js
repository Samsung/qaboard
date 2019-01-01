import React, { PureComponent } from "react";
import { get } from "axios"
import { Tag } from "@blueprintjs/core";
// import { OpenSeadragon } from 'openseadragon';
import pixelmatch from 'pixelmatch';
// import { Hotkey, Hotkeys, HotkeysTarget } from "@blueprintjs/core";

// https://stackoverflow.com/questions/7615009/disable-interpolation-when-scaling-a-canvas
import "./image-canvas.css";

var OpenSeadragon = require('openseadragon')

console.log(OpenSeadragon)

// https://github.com/picturae/Openseadragonrgb/blob/master/src/rgb.js

// http://Openseadragon.github.io/docs/Openseadragon.html#.Options
// http://Openseadragon.github.io/docs/Openseadragon.Viewer.html
// http://Openseadragon.github.io/docs/Openseadragon.Viewport.html
// http://Openseadragon.github.io/#examples-and-features
const openseadragon_config = {
  visibilityRatio: 1,

  preserveViewport: true,
  defaultZoomLevel: 1,
  minZoomLevel: 1,
  maxZoomPixelRatio: 50,
  minZoomImageRatio: 50,
  smoothTileEdgesMinZoom: 1000000,
  imageSmoothingEnabled: false,

  springStiffness: 15,

  showNavigator: true,
  // sequenceMode: true,

  // for now, manually: cp -r node_modules/Openseadragon/build/Openseadragon /stage/algo_data/ci/
  prefixUrl: "/s/stage/algo_data/ci/openseadragon/images/",
  crossOriginPolicy: 'Anonymous',
  ajaxWithCredentials: false,
  // debugMode: true,
  // showReferenceStrip: false,
  // visibilityRatio: 1.0,
  // constrainDuringPan: false,
  // defaultZoomLevel: 1,
  // minZoomLevel: 1,
  // maxZoomLevel: 10,
  // zoomInButton: 'zoom-in',
  // zoomOutButton: 'zoom-out',
  // homeButton: 'reset',
  // fullPageButton: 'full-page',
  // previousButton: 'sidebar-previous',
  // nextButton: 'sidebar-next',
}


const iiif_url = (output_dir_url, path) => {
  // we only serve data from there
  let identifier = output_dir_url.replace("/stage/algo_data", "")
  // remove the URL' leading "/s"
  identifier = identifier.replace(/\/*?s\//, "")
  identifier = `${identifier}/${path}`;
  // console.log(identifier)
  // IIIF specs require encoding the slashes inside the identifier
  identifier = encodeURIComponent(identifier)
  let url = `http://planet31:8182/iiif/2/${identifier}`  
  return url
}

// https://blueprintjs.com/docs/#core/components/hotkeys
// viewer.goToPage() 
// @HotkeysTarget
class ImgViewer extends PureComponent {
  constructor(props) {
    super(props);
    this.canvas_diff = React.createRef();
    this.state = {
      shown_image: "New",
      width: this.props.style.width || '390px',
      height: '217.5px', // default 4/3 ratio
      diff_threshold: 0.1,
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
      this.InitZoomSync();
      this.InitDiff();
    })
  }

  componentWillUnmount() {
      window.removeEventListener('resize', this.state.maintainZoom);
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
    }
    window.addEventListener('resize', maintainZoom);
    this.setState({maintainZoom});
  }

  Init() {
    const { path, output_new, output_ref } = this.props;
    const has_reference = !!output_new && !!output_new.output_dir_url;

    get(`${iiif_url(output_new.output_dir_url, path)}/info.json`).then(res => {
      // https://Openseadragon.github.io/examples/tilesource-iiif/
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
        width: this.state.width,
        height: `${parseFloat(this.state.width.replace(/[^\d]+/, '')) * height / width}px`,
      })

      const { viewer_new, viewer_ref } = this.state;

      viewer_new.open([{
            ...source_config,
            "@id": iiif_url(output_new.output_dir_url, path),
      }])
      if (has_reference) {
        this.state.viewer_ref.open([{
              ...source_config,
              "@id": iiif_url(output_ref.output_dir_url, path),
        }])
      }

      // console.log(viewer_new.drawer.context.imageSmoothingEnabled)
      viewer_new.drawer.setImageSmoothingEnabled(false);
      viewer_ref.drawer.setImageSmoothingEnabled(false);
      // viewer_new.drawer.context.imageSmoothingEnabled = false;
      // viewer_ref.drawer.context.imageSmoothingEnabled = false;

      // const context = v => v.drawer.canvas.getContext("2d")
      // context(viewer_new).imageSmoothingEnabled = false;
      // context(viewer_new).ImageSmoothingEnabled = false;
      // context(viewer_new).webkitImageSmoothingEnabled = false;
      // context(viewer_new).mozImageSmoothingEnabled = false;
      // context(viewer_new).msImageSmoothingEnabled = false;

      // context(viewer_ref).imageSmoothingEnabled = false;
      // context(viewer_ref).ImageSmoothingEnabled = false;
      // context(viewer_ref).webkitImageSmoothingEnabled = false;
      // context(viewer_ref).mozImageSmoothingEnabled = false;
      // context(viewer_ref).msImageSmoothingEnabled = false;

      // let canvas_new = viewer_new.canvas.childNodes[0];
      // let ctx_new = canvas_new.getContext('2d');
      // ctx_new.mozImageSmoothingEnabled = false;
      // ctx_new.webkitImageSmoothingEnabled = false;
      // ctx_new.msImageSmoothingEnabled = false;
      // ctx_new.imageSmoothingEnabled = false;

      // let canvas_ref = viewer_ref.canvas.childNodes[0];
      // let ctx_ref = canvas_ref.getContext('2d');
      // ctx_ref.mozImageSmoothingEnabled = false;
      // ctx_ref.webkitImageSmoothingEnabled = false;
      // ctx_ref.msImageSmoothingEnabled = false;
      // ctx_ref.imageSmoothingEnabled = false;



    }).catch(err => console.log(err));
  }

  render() {
    const { output_new, output_ref, diff, label, path } = this.props;
    const { shown_image, height, width } = this.state;
    let no_reference = !!!output_ref || !!!output_ref.output_dir_url;
    return <>
      <span>
        <Tag intent={shown_image === "Reference" ? "primary" : "warning"} id="current_image">{shown_image}</Tag>
        {label && (label || path)}
      </span>
      <div style={{width, height}} id={`osd-new-${output_new.output_dir_url}`} />
      <div hidden={no_reference} style={{width, height}} id={`osd-ref-${output_new.output_dir_url}`} />
      <div hidden={!diff || no_reference} style={{width, height}}>
        <canvas hidden={!diff || no_reference} ref={this.canvas_diff} width={width} height={height} />
      </div>
    </>
  }

  // renderHotkeys() {
  //   return <Hotkeys>
  //     <Hotkey
  //         global={true}
  //         combo="t"
  //         label="Toogle new/referne"
  //         onKeyDown={() => console.log("Awesome!")}
  //     />
  //     <Hotkey
  //         group="Fancy shortcuts"
  //         combo="shift + f"
  //         label="Be fancy only when focused"
  //         onKeyDown={() => console.log("So fancy!")}
  //     />
  //   </Hotkeys>;
  //   }
}

// class ImgViewer extends PureComponent {
//   render() {
//     const { path, output_new, output_ref } = this.props;
//     let new_url = `${output_new.output_dir_url}/${path}`
//     let ref_url = `${output_ref.output_dir_url}/${path}`
//     return <div>
//       <a href={new_url}>
//         <img
//           alt="New"
//           src={new_url}
//           width={400}
//         />
//       </a>
//       <a href={ref_url}>
//         <img
//           alt="Reference"
//           src={ref_url}
//           width={400}
//         />
//       </a>
//     </div>
//   }
// }




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
