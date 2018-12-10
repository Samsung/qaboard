import React, { PureComponent } from "react";
import { get } from "axios"
import { Tag } from "@blueprintjs/core";
import OpenSeaDragon from 'openseadragon';
import pixelmatch from 'pixelmatch';
// import { Hotkey, Hotkeys, HotkeysTarget } from "@blueprintjs/core";

// https://stackoverflow.com/questions/7615009/disable-interpolation-when-scaling-a-canvas
import "./image-canvas.css";



// https://github.com/picturae/openseadragonrgb/blob/master/src/rgb.js

// http://openseadragon.github.io/docs/OpenSeadragon.html#.Options
// http://openseadragon.github.io/docs/OpenSeadragon.Viewer.html
// http://openseadragon.github.io/docs/OpenSeadragon.Viewport.html
// http://openseadragon.github.io/#examples-and-features
const openseadragon_config = {
  visibilityRatio: 1,

  minZoomLevel: 1,
  defaultZoomLevel: 1,
  preserveViewport: true,
  maxZoomPixelRatio: 50,
  // smoothTileEdgesMinZoom: 10000,

  showNavigator: true,
  sequenceMode: true,
  springStiffness: 15,

  // for now, manually: cp -r node_modules/openseadragon/build/openseadragon /stage/algo_data/ci/
  prefixUrl: "/s/stage/algo_data/ci/openseadragon/images/",

  crossOriginPolicy: 'Anonymous',
  ajaxWithCredentials: false,
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
  identifier = identifier.replace(/\/?s\//, "")
  identifier = `${identifier}/${path}`;
  // IIIF specs require encoding the slashes inside the identifier
  console.log(identifier)
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
    this.state = {
      shown_image: "New",
      width: this.props.style.width || '390px',
      height: '217.5px', // default 4/3 ratio
      diff_threshold: 0.1,
    }
  }
  componentDidMount() {
    const { path, output_new, output_ref } = this.props;
    get(`${iiif_url(output_new.output_dir_url, path)}/info.json`).then(res => {
      const { height, width } = res.data;
      // https://openseadragon.github.io/examples/tilesource-iiif/
      let source_config = {
          "@context": "http://iiif.io/api/image/2/context.json",
          protocol: "http://iiif.io/api/image",
          profile: ["http://iiif.io/api/image/2/level2.json"],
          formats: ["png"],
          fitBounds: true,
          height,
          width,
      }
      this.setState({
        width: this.state.width,
        height: `${parseFloat(this.state.width.replace(/^[\d]+/, '')) * height / width}px`,
      })
      let viewer_new = OpenSeaDragon({
        ...openseadragon_config,
        id: `osd-new-${output_new.output_dir_url}`,
        tileSources: [{
            ...source_config,
            "@id": iiif_url(output_new.output_dir_url, path),
        }],
      });

      let viewer_ref = OpenSeaDragon({
        ...openseadragon_config,
        id: `osd-ref-${output_new.output_dir_url}`,
        tileSources: [{
            ...source_config,
            "@id": iiif_url(output_ref.output_dir_url, path),
        }],
      });

      // https://codepen.io/iangilman/pen/BWKKxQ

      var masterZoom, masterCenter;
      var viewer_newLeading = false;
      var viewer_refLeading = false;


      var viewer_newHandler = function() {
        if (viewer_refLeading) {
          return;
        }
        masterZoom = viewer_new.viewport.getZoom();
        masterCenter = viewer_new.viewport.getCenter();

        viewer_newLeading = true;
        viewer_ref.viewport.zoomTo(masterZoom);
        viewer_ref.viewport.panTo(masterCenter);
        viewer_newLeading = false;
      };

      var viewer_refHandler = function() {
        if (viewer_newLeading) {
          return;
        }
        
        masterZoom = viewer_ref.viewport.getZoom();
        masterCenter = viewer_ref.viewport.getCenter();

        viewer_refLeading = true;
        viewer_new.viewport.zoomTo(masterZoom);
        viewer_new.viewport.panTo(masterCenter);
        viewer_refLeading = false;
      };

      viewer_new.addHandler('zoom', viewer_newHandler);
      viewer_ref.addHandler('zoom', viewer_refHandler);
      viewer_new.addHandler('pan', viewer_newHandler);
      viewer_ref.addHandler('pan', viewer_refHandler);


      var update_diff = () => {
        let size_new = new OpenSeaDragon.Point(viewer_new.container.clientWidth || 1, viewer_new.container.clientHeight || 1);
        let canvas_new = viewer_new.drawer.canvas
        let canvas_ref = viewer_ref.drawer.canvas
        let data_new = canvas_new.getContext("2d").getImageData(0, 0, size_new.x, size_new.y);
        let data_ref = canvas_ref.getContext("2d").getImageData(0, 0, size_new.x, size_new.y);
        var canvas_diff = document.getElementById(`osd-diff-${output_new.output_dir_url}`);
        if (!!canvas_diff) {
          var diff = canvas_diff.getContext("2d").createImageData(size_new.x, size_new.y);
          pixelmatch(data_new.data, data_ref.data, diff.data, size_new.x, size_new.y, {threshold: this.state.diff_threshold});
          canvas_diff.getContext("2d").putImageData(diff, 0, 0);          
        }
        // var point = new OpenSeaDragon.Point(0.5, 0.5)
        // viewer_ref.addOverlay(`osd-diff-${output_new.output_dir_url}`, point, OpenSeaDragon.Placement.CENTER)
      }
      if (this.props.diff) {
        viewer_ref.addHandler('animation-finish', update_diff);
        viewer_ref.addHandler('tile-drawn', update_diff);        
      }


      function maintainZoom() {
          var size1 = new OpenSeaDragon.Point(viewer_new.container.clientWidth || 1, viewer_new.container.clientHeight || 1);
          var size2 = new OpenSeaDragon.Point(viewer_ref.container.clientWidth || 1, viewer_ref.container.clientHeight || 1);
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

    // https://github.com/openseadragon/openseadragon/issues/1376
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
    }).catch(err => console.log(err));
  }

  render() {
    const { output_new, output_ref } = this.props;
    const { shown_image, height, width } = this.state;
    return <div >
      <Tag intent={shown_image === "Reference" ? "primary" : "warning"} id="current_image">{shown_image}</Tag>
      <div style={{width, height}} id={`osd-new-${output_new.output_dir_url}`} />
      {!!output_ref && !!output_ref.output_dir_url && <div style={{width, height}} id={`osd-ref-${output_new.output_dir_url}`} />}
      {this.props.diff && !!output_ref && !!output_ref.output_dir_url && <canvas style={{width, height}} id={`osd-diff-${output_new.output_dir_url}`} />}      
    </div>
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

export default ImgViewer;
