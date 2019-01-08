import React, { Component } from "react";
import Plot from 'react-plotly.js';
import * as THREE from "three";
import { PCDLoader } from "./PCDLoader";
import { OrbitControls } from "./OrbitControls";

import { Classes, Colors, Button, RangeSlider, Slider } from "@blueprintjs/core";
import { get } from "axios";
import { parse_hex } from "./Sys_Tools"

const aspect_ratio = 4 / 3;
const width = 640; // full screen would be window.innerWidth;
const height = width / aspect_ratio; // full screen would be window.innerHeight;

const colors = {
  groundtruth: `${Colors.GREEN2}dd`,
  new: `${Colors.ORANGE2}dd`,
  reference: `${Colors.BLUE2}dd`
};

var make_traces = function(metrics_over_frames, label) {
  /*
  Parameters:
    metrics_over_frames: Map
    label: string
  */
  if (metrics_over_frames === undefined) return [];
  return {
    type: "scatter",
    mode: "lines+markers",
    x: Array.from(metrics_over_frames.keys()),
    y: Array.from(metrics_over_frames.values()).map(m => m.pcmd),
    line: {
      color: colors[label],
      width: label === "reference" ? 3 : 2, // ref wider to highlight bit accuracy
    },
    marker: {
      color: colors[label],
      size: label === 'reference' ? 12 : 10,
    },
    name: label,
    legendgroup: label,
    showlegend: true
  };
};

// References for the threejs integration:
// https://stackoverflow.com/questions/41248287/how-to-connect-threejs-to-react
// https://itnext.io/how-to-use-plain-three-js-in-your-react-apps-417a79d926e0

class TofOutputCard extends Component {
  constructor(props) {
    super(props);
    this.threeRoot = React.createRef();
    // we check that the results metric include per-frame information
    // if the tof crashed for instance, they won't be there
    let has_frames_info = props.output_new.metrics.frames !== undefined

    // we will first display the last frame of each recording
    let last_frame_id = has_frames_info ? props.output_new.metrics.frames[props.output_new.metrics.frames.length - 1].frame_path_idx : 0;

    this.state = {
      selected_frame: last_frame_id,
      sliderValue: last_frame_id,
      show_pointcloud: false,
      showHeatmap: false,
      output_type: "depth",
      focus: 'new',
      heatmapAxes: { xaxis: {autorange : true}, yaxis: {autorange : "reversed"}},
      heatmapZscale: {zmin: 0, zmax: 750},
      heatmapScaleMinMax: {zmin: 0, zmax: 750},
      pointclouds: {
        [last_frame_id]: {
          is_loaded: false,
          new: null,
          reference: null,
        }
      }
    };
  }

  // to access information about each frame and
  // keep information about the frame order, we turn frame.outputs_new.frames
  // into a Map (~ordered dict~)
  updateFrames(props) {
    const to_map = output => (output.metrics !== undefined && output.metrics.frames !== undefined)
                              ? new Map(output.metrics.frames.map(frame => [parseFloat(frame.frame_path_idx), frame]))
                              : new Map();
    this.setState({
        frames: {
            new: to_map(props.output_new),
            reference: to_map(props.output_ref),
        }
    })
  }

  componentDidMount() {
    window.addEventListener("keypress", this.keyboard);
    this.updateFrames(this.props);
  }

  componentDidUpdate(nextProps, prevState) {
    if (nextProps.output_new !== this.props.output_new || nextProps.output_ref !== this.props.output_ref || prevState.selected_frame !== this.state.selected_frame) {
        this.updateFrames(this.props)
    }
    if (prevState.selected_frame !== this.state.selected_frame || prevState.output_type !== this.state.output_type || (this.state.showHeatmap && prevState.newHexData === undefined)) {
        this.getHexData(this.props);
    }
    if (this.state.newHexData && this.state.newHexData.z && prevState.newHexData !== this.state.newHexData) {
        this.setState({heatmapZscale: this.getMinMax(this.state.newHexData.z.flat())});
        this.setState({heatmapScaleMinMax: this.getMinMax(this.state.newHexData.z.flat())});
    }
  }
  
  getMinMax(arr) {
    let len = arr.length;
    let max = -Infinity;
    let min = Infinity;

    while (len--) {
        max = arr[len] > max ? arr[len] : max;
        min = arr[len] < min ? arr[len] : min;
    }
    return {zmin: min, zmax: max};
  }
  
  getHexData(props) {
    const { output_new, output_ref } = props;
    const { selected_frame, output_type }  = this.state;

    get(`${output_new.output_dir_url}/Frame${selected_frame}/${output_type}.hex`)
    .then(response => {
	  this.setState({
	    newHexData: {
        type: 'heatmap',
        z: parse_hex(response.data).z,
        name: `${output_type}`,
        hoverinfo: "x+y+z+name",
        showscale: true,
        colorscale: 'Viridis',
      }
	  }) 
	})
    .catch(e => {console.log(e)});

    get(`${output_ref.output_dir_url}/Frame${selected_frame}/${output_type}.hex`)
    .then(response => {
    this.setState({
      refHexData: {
        type: 'heatmap',
        z: parse_hex(response.data).z,
        name: `${output_type}`,
        hoverinfo: "x+y+z+name",
        showscale: true,
        colorscale: 'Viridis',
      }
    }) 
  })
    .catch(e => {console.log(e)});
  }
  
  getPointcloud(frame_id, label) {
    var loader = new PCDLoader();
    if (label === "new") {
      var pointcloud_dir = this.props.output_new.output_dir_url;
    } else if (label === "reference") {
      if (this.props.output_ref.id === undefined) return;
      pointcloud_dir = this.props.output_ref.output_dir_url;
    } else if (label === "groundtruth") {
      pointcloud_dir = `/s/${this.props.output_new.test_input_database}/${this.props.output_new.test_input_path}`;
    }

    var url = `${pointcloud_dir}/Frame${frame_id}/pointcloud.pcd`;
    console.log(url)
    loader.load(url, pointcloud => {
      if (pointcloud !== null) {
        var previous_pointcloud = this.scene.getObjectByName(label);
        console.log(previous_pointcloud)
        if (previous_pointcloud) 
          this.scene.remove(previous_pointcloud);

        pointcloud.name = label;
        if (label === "reference") {
          pointcloud.visible = false;
        }
        else if (label === "new") {
          var center = pointcloud.geometry.boundingSphere.center;
          this.camera.position.z = center.y;
          this.controls.target.set(center.x, center.y, center.z);
          this.controls.update();
        }
        else if (label === "groundtruth") {
          pointcloud.visible = false;
          pointcloud.material.vertexColors = false;
          pointcloud.material.color.setHex(0xff0000);
          pointcloud.material.opacity = 0.5;
          pointcloud.material.transparent = true;
        }
        this.scene.add(pointcloud);
      }
      this.setState((previousState, props) => ({
        pointclouds: {
          ...previousState.pointclouds,
          [frame_id]: {
            ...previousState.pointclouds[frame_id],
            is_loaded: true,
            [label]: pointcloud
          }
        }
      }));
    });
  }


  componentWillUnmount() {
    if (this.state.show_pointcloud) {
      this.stopPointCloud();
      this.threeRoot.removeChild(this.renderer.domElement);      
      // window.removeEventListenner(this.keyboard)
    }
  }

  startPointCloud() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, aspect_ratio, 0.1, 1000);
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true
    });
    this.renderer.setSize(width, height);
    this.camera.up.set(0, -1, 0);

    // https://threejs.org/docs/#examples/controls/OrbitControls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.25;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 1;
    this.controls.maxDistance = 5 * 1000;

    while (this.threeRoot.hasChildNodes()) {
      this.threeRoot.removeChild(this.threeRoot.lastChild);
    }
    this.threeRoot.appendChild(this.renderer.domElement);

    if (!this.frameId) {
      this.frameId = requestAnimationFrame(this.animate);
    }
  }

  updatePointCloud(selected_frame) {
    if (!this.state.show_pointcloud) {
      this.setState({show_pointcloud: true})
      this.startPointCloud()
    }
    this.getPointcloud(selected_frame, "new");
    this.getPointcloud(selected_frame, "reference");
    this.getPointcloud(selected_frame, "groundtruth");
    this.setState({ selected_frame });
  }

  stopPointCloud() {
    cancelAnimationFrame(this.frameId);
  }

  animate = () => {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.frameId = window.requestAnimationFrame(this.animate);
  };

  keyboard = ev => {
    if (this.scene !== undefined){
      var pointcloud_new = this.scene.getObjectByName("new");
      var pointcloud_ref = this.scene.getObjectByName("reference");
      var pointcloud_gt = this.scene.getObjectByName("groundtruth");
    }
    switch (ev.key || String.fromCharCode(ev.keyCode || ev.charCode)) {
      case "+":
      case "=":
        if (pointcloud_new !== undefined) {
          pointcloud_new.material.size *= 1.25;
          pointcloud_new.material.needsUpdate = true;
        }
        if (pointcloud_ref !== undefined) {
          pointcloud_ref.material.size *= 1.25;
          pointcloud_ref.material.needsUpdate = true;
        }
        if (pointcloud_gt !== undefined) {
          pointcloud_gt.material.size *= 1.25;
          pointcloud_gt.material.needsUpdate = true;
        }
        break;
      case "-":
      case "_":
        if (pointcloud_new !== undefined) {
          pointcloud_new.material.size /= 1.25;
          pointcloud_new.material.needsUpdate = true;
        }
        if (pointcloud_ref !== undefined) {
          pointcloud_ref.material.size /= 1.25;
          pointcloud_ref.material.needsUpdate = true;
        }
        if (pointcloud_gt !== undefined) {
          pointcloud_gt.material.size /= 1.25;
          pointcloud_gt.material.needsUpdate = true;
        }
        break;
      case "r":
      case "R":
        if (this.state.showHeatmap || this.state.show_pointcloud) {
          this.setState({focus: this.state.focus === 'new' ? 'reference' : 'new'});
        }
        if (pointcloud_ref !== undefined) {
          pointcloud_ref.visible = !pointcloud_ref.visible;
          pointcloud_new.visible = !pointcloud_new.visible;          
        }
        break;
      case "g":
        if (pointcloud_ref !== undefined) {
          pointcloud_ref.material.transparent = !pointcloud_ref.material.transparent;
          pointcloud_ref.material.opacity = pointcloud_gt.visible ? 1 : 0.5;
        }
        if (pointcloud_new !== undefined) {
          pointcloud_new.material.transparent = !pointcloud_new.material.transparent;
          pointcloud_new.material.opacity = pointcloud_gt.visible ? 1 : 0.5;
        }
        if (pointcloud_gt !== undefined) {
          pointcloud_gt.visible = !pointcloud_gt.visible;
        }
        break;
      default:
        return;
      // todo:
      // - use directionnal arrows to change point of view
    }
  };

  render() {
    const { output_new, output_ref } = this.props;
    const { show_pointcloud, pointclouds, frames, selected_frame } = this.state;
    let is_loaded = !!pointclouds[selected_frame] && !!pointclouds[selected_frame].is_loaded;

    const empty_metrics = { frames: new Map() };
    let metrics_new =
      output_new && output_new.metrics && output_new.metrics.frames
        ? output_new.metrics
        : empty_metrics;
    let metrics_ref =
      output_ref && output_ref.metrics && output_ref.metrics.frames
        ? output_ref.metrics
        : empty_metrics;

    if (!metrics_new || !metrics_ref || !frames) return <span />;

    let traces = [
      make_traces(frames['reference'], "reference"),
      make_traces(frames['new'], "new"),
    ];
    let layout = this.props.layout || {};
    let layout_ = {
      height: 150,
      margin: { l: 50, r: 10, b: 50, t: 50, pad: 5 },
      xaxis: {
        title: "frame"
      },
      yaxis: {
        title: "PCMD"
      },
      legend: {
        orientation: "h",
        bgcolor: "rgba(255,255,255,0.5)",
        traceorder: "grouped",
        tracegroupgap: 0
      },
      ...layout
    };
    let heatmaps_layout = {
      title: this.state.focus + " - " + this.state.output_type,
      yaxis: this.state.heatmapAxes.yaxis,
      xaxis: this.state.heatmapAxes.xaxis,
      width: 640,
      height: 564,
    };
    let img_new = `${
      output_new.output_dir_url
      }/Frame${selected_frame}/${this.state.output_type}.png`;
    let img_ref = `${
      output_ref.output_dir_url
      }/Frame${selected_frame}/${this.state.output_type}.png`;
    return (
      <>
        <p className={Classes.TEXT_MUTED}>
          {show_pointcloud ? (is_loaded && !!this.scene.getObjectByName("new")
                        ? <span>Showing {this.state.focus}. Press R/G to toogle the reference/ground-truth, +/- to adjust point size. <Button onClick={()=>this.setState({show_pointcloud: false})}>close</Button></span>
                        : "Loading...") : "Click a point on the plot to show other frames."}
        </p>
        <div hidden={!show_pointcloud}
          ref={threeRoot => {
            this.threeRoot = threeRoot;
          }}
        >
          {false && is_loaded && this.renderer.render(this.scene, this.camera)}
        </div>

        {<Plot data={traces} layout={layout_}/>}
        {(output_new.metrics.frames !== undefined) && <Slider 
          max = {output_new.metrics.frames.length-1}
          onChange = {(value) => this.setState({sliderValue: value, selected_frame: Array.from(frames['new'].keys())[value]})}
          showTrackFill={false}
          value = {this.state.sliderValue}
          labelRenderer = {(value) => Array.from(frames['new'].keys())[value]}
          labelStepSize = {Math.ceil(output_new.metrics.frames.length/20)}
        />}

        <div>
          <h4 className={Classes.HEADING}>
            <a
              href={`${output_ref.output_dir_url}/Frame${selected_frame}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Frame {selected_frame}
            </a>
          </h4>
          {
            this.state.showHeatmap
            ? (
                <>
                  <div>
                    {
                      (this.state.focus === "new")
                        ?  
                          <Plot data={[{...this.state.newHexData, ...this.state.heatmapZscale }]} layout = {heatmaps_layout}/>
                        : 
                          <Plot data={[{...this.state.refHexData, ...this.state.heatmapZscale}]} layout = {heatmaps_layout}/>
                    }
                  </div>
                  <div>
                    {
                      <RangeSlider 
                        min = {this.state.heatmapScaleMinMax.zmin} 
                        max = {this.state.heatmapScaleMinMax.zmax} 
                        value = {(this.state.heatmapZscale) ? ([this.state.heatmapZscale.zmin,this.state.heatmapZscale.zmax]) : ([0,750])} 
                        onChange = {([minValue,maxValue]) => this.setState({heatmapZscale: {zmin: minValue, zmax: maxValue}})}
                        labelStepSize = {(this.state.heatmapScaleMinMax.zmax - this.state.heatmapScaleMinMax.zmin)/20}
                        stepSize = {0.1}
                      />
                    }
                  </div>
                </>
              )
            : (
                <div>
                  <img width={400} alt="New" src={img_new} />
                  <img width={400} alt="Reference" src={img_ref} />
                </div>
              )
          }
        </div>
        <div className="viewButtons">
          <div>
            <Button onClick={e => this.setState({showHeatmap: !this.state.showHeatmap})}> {this.state.showHeatmap ? ("Show static image") : ("Show heatmap")} </Button>
          </div>
          <div>
            <Button onClick={e => {this.setState({output_type: "depth"});}}> Show depth </Button>
            <Button onClick={e => {this.setState({output_type: "pcmdHeatmap"});}}> Show PCMD </Button>
            <Button onClick={e => {this.setState({output_type: "AbsErrHeatmap"});}}> Show Abs Error </Button>
          </div>
          <div>
            <Button onClick={e => this.updatePointCloud(selected_frame)}> Show Point Cloud </Button>
          </div>
        </div>

        {false && <p>{JSON.stringify(output_new)}</p>}
      </>
    );
  }
}

export default TofOutputCard;
