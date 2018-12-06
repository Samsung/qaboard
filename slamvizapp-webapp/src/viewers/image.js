import React, { PureComponent } from "react";
import { get } from "axios"
import { Tag } from "@blueprintjs/core";
// import { Hotkey, Hotkeys, HotkeysTarget } from "@blueprintjs/core";
import OpenSeaDragon from 'openseadragon';


// http://openseadragon.github.io/docs/OpenSeadragon.html#.Options
// http://openseadragon.github.io/docs/OpenSeadragon.Viewer.html
// http://openseadragon.github.io/docs/OpenSeadragon.Viewport.html
// http://openseadragon.github.io/#examples-and-features
const openseadragon_config = {
  visibilityRatio: 1,
  minZoomLevel: 1,
  defaultZoomLevel: 1,
  preserveViewport: true,
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
  let identifier_prefix = output_dir_url.replace("/stage/algo_data", "")
  // remove the URL' leading "/s"
  let identifier = `${identifier_prefix}/${path}`.slice(4);
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
    this.state = {
      shown_image: "New",
      width: this.props.style.width || '390px',
      height: '217.5px', // default 4/3 ratio
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
          fitBounds: true,
          height,
          width,
      }
      this.setState({
        width: this.state.width,
        height: `${parseFloat(this.state.width.replace(/^[\d]+/, '')) * height / width}px`,
      })
      let viewer = OpenSeaDragon({
        ...openseadragon_config,
        id: output_new.output_dir_url,
        tileSources: [
          {
            ...source_config,
            "@id": iiif_url(output_new.output_dir_url, path),
          },
          !!output_ref && output_ref.output_dir_url && {
            ...source_config,
            "@id": iiif_url(output_ref.output_dir_url, path),
          },
        ],
      });
      viewer.addHandler("page", data => {
        this.setState({shown_image: data.page===0 ? "New" : "Reference"})
      });
    }).catch(err => console.log(err));
  }

  render() {
    const { output_new } = this.props;
    const { shown_image, height, width } = this.state;
    return <div >
      <Tag intent={shown_image === "Reference" ? "primary" : "warning"} id="current_image">{shown_image}</Tag>
      <div style={{width, height}} id={output_new.output_dir_url} />
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
