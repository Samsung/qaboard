import React, { Component } from "react";
import Plot from 'react-plotly.js';
import * as THREE from "three";
import { PCDLoader } from "./PCDLoader";
import { OrbitControls } from "./OrbitControls";
import { PointerLockControls } from "./PointerLockControls";

import { Classes, Colors, Button, RangeSlider, Slider } from "@blueprintjs/core";
import { get } from "axios";
import { parse_hex } from "./Sys_Tools"

const aspect_ratio = 4 / 3;
const width = 640;                   // full screen would be window.innerWidth;
const height = width / aspect_ratio; // full screen would be window.innerHeight;





// Using Math.min(...array) leads to max-stack-exceeded errors on large arrays.
function maxmin(array) {
    let zmax = -Infinity;
    let zmin = Infinity;
    array.forEach(e => {
      if (e < zmin) zmin = e;
      if (e > zmax) zmax = e;
    })
    return {zmin, zmax};
}


const colors = {
  new: `${Colors.ORANGE2}dd`,
  reference: `${Colors.BLUE2}dd`,
  groundtruth: `${Colors.GREEN2}dd`,
};

const default_heatmap = {
  axes: {
    xaxis: {
      autorange : true,
    },
    yaxis: {
      autorange: "reversed",
    }
  },
  zscale: {
    zmin: 0,
    zmax: 750,
  },
  scaleMinMax: {
    zmin: 0,
    zmax: 750,
  },
};

// Creates plotly traces for the plot displaying metrics over frames.
const make_metric_trace = function(metrics_over_frames /*: Map*/, label) {
  if (metrics_over_frames === undefined)
    return [];
  return {
    type: "scatter",
    mode: "lines+markers",
    x: Array.from(metrics_over_frames.keys()),
    y: Array.from(metrics_over_frames.values()).map(m => m.pcmd),
    line: {
      color: colors[label],
      // the reference is wider to highlight bit accuracy
      width: label === "reference" ? 3 : 2,
    },
    marker: {
      color: colors[label],
      size: label === 'reference' ? 12 : 10,
    },
    name: label,
    legendgroup: label,
    showlegend: true,
  };
};



class TofOutputCard extends Component {
  constructor(props) {
    super(props);
    // References for the ThreeJS integration:
    // https://stackoverflow.com/questions/41248287/how-to-connect-threejs-to-react
    // https://itnext.io/how-to-use-plain-three-js-in-your-react-apps-417a79d926e0

    // This is a reference to the <canvas/> element used to render with ThreeJS
    this.threeRoot = React.createRef();

    // Those are used when navigating the pointcloud with the WASD keys
    // We them manage them outside of the React state - it avoids overhead, updates or re-renders.
    this.moveForward = false;
    this.moveBackward = false;
    this.moveLeft = false;
    this.moveRight = false;
    this.prevTime = performance.now();
    this.direction = new THREE.Vector3();
    this.velocity = new THREE.Vector3();

    let last_frame_id = 0 // default
    let first_frame_id = 0 // default

    this.state = {
      first_frame_id,
      last_frame_id,
      selected_frame: last_frame_id,

      // should we show the new or the reference ouput?
      focus: 'new',

      show_pointcloud: false,
      control: 'orbit',
      pointclouds: {
        [last_frame_id]: {
          is_loaded: false,
          new: null,
          reference: null,
        }
      },

      show_heatmap: false,
      // the heatmap can display different sorts of data
      selected_output_type: "depth",
      custom_output_filename: "[custom filename].hex",
      mesh_output: true,
      mesh_thresh: "5.0",
      use_intensity: false,
      pcd_flip_xy: true,
      depth : default_heatmap, // make a deep copy...
      z     : JSON.parse(JSON.stringify(default_heatmap)),
      intensity     : JSON.parse(JSON.stringify(default_heatmap)),
      amplitude     : JSON.parse(JSON.stringify(default_heatmap)),
      AbsErrHeatmap : JSON.parse(JSON.stringify(default_heatmap)),
      pcmdHeatmap : JSON.parse(JSON.stringify(default_heatmap)),
      customMap : JSON.parse(JSON.stringify(default_heatmap)),
    };
  }

  // To access information about each frame and keep information about the frame order,
  // we turn frame.outputs_new.frames into a Map (~ordered dict~)
  updateFrames(props, keep_selected_frame) {
    if (props.output_new === null || props.output_new === undefined)
      return;
    // we check that the results metric include per-frame information
    // if the tof crashed for instance, they won't be there
    let has_frames_info = props.output_new.metrics.frames !== undefined
    // we will first display the last frame of each recording
    let last_frame_id = has_frames_info ? (props.output_new.metrics.frames[props.output_new.metrics.frames.length - 1] || {}).frame_path_idx : 0;
    let first_frame_id = has_frames_info ? (props.output_new.metrics.frames[0] || {}).frame_path_idx : 0;

    const to_map = output => (output !==undefined && output.metrics !== undefined && output.metrics.frames !== undefined)
                              ? new Map(output.metrics.frames.map(frame => [parseFloat(frame.frame_path_idx), frame]))
                              : new Map();

    const selected_frame = keep_selected_frame
                           ? Math.max(Math.min(this.state.selected_frame, last_frame_id), first_frame_id)
                           : last_frame_id;
    this.setState({
        first_frame_id,
        last_frame_id,
        selected_frame,
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

  componentDidUpdate(prevProps, prevState) {
    let outputs_changed = prevProps.output_new !== this.props.output_new || prevProps.output_ref !== this.props.output_ref;
    if (outputs_changed)
        this.updateFrames(this.props, /*keep_selected_frame=*/prevProps.output_new.test_input_path === this.props.output_new.test_input_path)
    const { selected_output_type, selected_frame } = this.state;
    const heatmaps = this.state[selected_output_type] || {}
    const heatmap = heatmaps[this.state.selected_frame] || {is_loading: false, is_loaded: false};
    let should_load_heatmap = !heatmap.is_loaded && !heatmap.is_loading;
    if (prevState.custom_output_filename !== this.state.custom_output_filename)
    {
        if (selected_output_type === 'customMap')
            should_load_heatmap = true;
        this.setState({customMap: JSON.parse(JSON.stringify(default_heatmap)) } );
    }
    if (this.state.show_pointcloud){
      if ( prevState.mesh_output !== this.state.mesh_output)
      {
        //this.closePointCloud(); // this unsets show_pointcloud so don't do that
        this.renderer.forceContextLoss(); // needed for switch from PCD to Mesh
        this.startPointCloud();
        this.updatePointCloud(selected_frame);
      }
      else if (
        this.state.mesh_output && (
          this.state.mesh_thresh   !== prevState.mesh_thresh   ||
          this.state.use_intensity !== prevState.use_intensity ||
          this.state.pcd_flip_xy   !== prevState.pcd_flip_xy
        )
      ) {
        this.updatePointCloud(selected_frame);
      } 
      
    }
    if (this.state.show_heatmap && (should_load_heatmap || outputs_changed) )
        this.getHeatmapData(this.props);
  }
  
  
  getHeatmapData(props) {
    const { output_new, output_ref } = props;
    const { selected_frame, selected_output_type, custom_output_filename }  = this.state;
    let hex_layout = {
        type: 'heatmap',
        name: `${selected_output_type}`,
        hoverinfo: "x+y+z+name",
        showscale: true,
        colorscale: 'Viridis',      
    }
    this.setState({
      [selected_output_type]: {
        ...this.state[selected_output_type],
        [selected_frame]: {
          is_loaded: false,
          ...this.state[selected_output_type][selected_frame],
          is_loading: true
        }
      }
    })

    let fileNameToGet = selected_output_type !== 'customMap'
                        ? `${output_new.output_dir_url}/Frame${selected_frame}/${selected_output_type}.hex`
                        : `${output_new.output_dir_url}/Frame${selected_frame}/${custom_output_filename}`;
    console.log(fileNameToGet)
    get(fileNameToGet)
    .then(response => {
      let convert_nan = selected_output_type === 'z' || selected_output_type === 'depth'
      const newHexData = {
        ...hex_layout,
        z: parse_hex(response.data, convert_nan).z,
      }
      const z_minmax = maxmin(newHexData.z.flat());
	    this.setState({
        [selected_output_type]: {
          ...this.state[selected_output_type],
          zscale: z_minmax,
          scaleMinMax: z_minmax,
  	      [selected_frame]: {
            ...this.state[selected_output_type][selected_frame],
            is_loaded: true,
            is_loading: false,
            newHexData,
          },
	      }
      }) 
	  })
    .catch(error => {
      this.setState({
        [selected_output_type]: {
          ...this.state[selected_output_type],
          [selected_frame]: {
            ...this.state[selected_output_type][selected_frame],
            is_loaded: true,
            is_loading: false,
            error: error,
          },
        }
      })
    });
    
    if (output_ref === undefined || output_ref === null) {
      return;
    }
    let fileNameToGetRef = selected_output_type !== 'customMap'
                           ? `${output_ref.output_dir_url}/Frame${selected_frame}/${selected_output_type}.hex`
                           : `${output_ref.output_dir_url}/Frame${selected_frame}/${custom_output_filename}`;
    get(fileNameToGetRef)
    .then(response => {
      let convert_nan = selected_output_type === 'z' || selected_output_type === 'depth'
      this.setState({
        [selected_output_type]: {
          ...this.state[selected_output_type],
          [selected_frame]: {
            ...this.state[selected_output_type][selected_frame],
            is_loaded: true,
            is_loading: false,
            refHexData: {
              ...hex_layout,
              z: parse_hex(response.data, convert_nan).z,
            },
          }
        }
      }) 
    })
    .catch(e => {
      console.log(e)
      this.setState({
        [selected_output_type]: {
          ...this.state[selected_output_type],
          [selected_frame]: {
            ...this.state[selected_output_type][selected_frame],
            is_loaded: true,
            is_loading: false,
          },
        }
      })
    });
  }
  
  getPointcloud(frame_id, label) {
    var loader = new PCDLoader();
    let { mesh_thresh, use_intensity, mesh_output, pcd_flip_xy } = this.state;
    console.log('use_intensity: '); console.log(use_intensity);
    loader.use_intensity = use_intensity;
    loader.mesh_output   = mesh_output;
    loader.flip_xy       = pcd_flip_xy;
    loader.triangle_thresh = parseFloat(mesh_thresh);

    if (label === "new") {
      var pointcloud_dir = this.props.output_new.output_dir_url;
    } else if (label === "reference") {
      if (!!!this.props.output_ref || this.props.output_ref.id === undefined) return;
      pointcloud_dir = this.props.output_ref.output_dir_url;
    } else if (label === "groundtruth") {
      pointcloud_dir = `/s/${this.props.output_new.test_input_database}/${this.props.output_new.test_input_path}`;
    }

    var url = `${pointcloud_dir}/Frame${frame_id}/pointcloud.pcd`;
    loader.load(url, pointcloud => {
      if (pointcloud !== null) {
        var previous_pointcloud = this.scene.getObjectByName(label);
        if (previous_pointcloud) 
          this.scene.remove(previous_pointcloud);
        pointcloud.name = label;
        if (use_intensity)
            pointcloud.material.size = 0.5;
        else
            pointcloud.material.size = 0.01;
        if (label === "reference")
          pointcloud.visible = false;
        else if (label === "new") {
          var center = pointcloud.geometry.boundingSphere.center;
          if (use_intensity)
              this.camera.position.z = -10.0;
          else
            this.camera.position.z = center.y;
          if (this.state.control==='orbit') {
            if (use_intensity)
                this.controls.target.set(0, 0, 80.0);
            else
                this.controls.target.set(center.x, center.y, center.z);
            this.controls.update();            
          }
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
            [label]: pointcloud,
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
      // window.removeEventListenner(this.click)
    }
  }

  setControls(control) {
    if (control === 'orbit') {
      if (!!this.controls && !!this.controls.unlock) this.controls.unlock();
      // https://threejs.org/docs/#examples/controls/OrbitControls
      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.25;
      this.controls.screenSpacePanning = false;
      this.controls.minDistance = 1;
      this.controls.maxDistance = 5 * 1000;
    } else {
      this.controls = new PointerLockControls(this.camera, this.renderer.domElement);
      this.controls.lock();
      this.prevTime = performance.now();
    }
  } 

  addShadowedLight( x, y, z, color, intensity ) {

    var directionalLight = new THREE.DirectionalLight( color, intensity );
    directionalLight.position.set( x, y, z );
    this.scene.add( directionalLight );

    directionalLight.castShadow = true;

    var d = 1;
    directionalLight.shadow.camera.left = - d;
    directionalLight.shadow.camera.right = d;
    directionalLight.shadow.camera.top = d;
    directionalLight.shadow.camera.bottom = - d;

    directionalLight.shadow.camera.near = 1;
    directionalLight.shadow.camera.far = 4;

    directionalLight.shadow.mapSize.width = 1024;
    directionalLight.shadow.mapSize.height = 1024;

    directionalLight.shadow.bias = - 0.001;

  }

  startPointCloud() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, aspect_ratio, 0.1, 1000);
    let {mesh_output} = this.state;
    if (mesh_output){
      //this.scene.add( new THREE.HemisphereLight( 0x443333, 0x111122 ) );
      this.scene.add( new THREE.HemisphereLight( 0xffffff, 0xffffff, 2.5 ) );
      this.addShadowedLight( 1, -250, -200, 0xffffff, 0.25 );
      this.addShadowedLight( 0.5, 100,  -400, 0xffffff, 0.25 );
    }

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true
    });
    this.camera.up.set(0, -1, 0);
    this.renderer.setSize(width, height);

    this.renderer.domElement.setAttribute("tabindex", 0); // listen to keyboard events
    this.renderer.domElement.addEventListener("keydown", this.keyup);
    this.renderer.domElement.addEventListener("keyup", this.keydown);
    this.renderer.domElement.addEventListener("click", this.click);
    this.setControls('orbit')

    while (this.threeRoot.hasChildNodes()) {
      this.threeRoot.removeChild(this.threeRoot.lastChild);
    }
    this.threeRoot.appendChild(this.renderer.domElement);
    if (!this.frameId) this.frameId = requestAnimationFrame(this.animate);
  }

  updatePointCloud(selected_frame) {
    if (!this.state.show_pointcloud) {
      this.setState({show_pointcloud: true});
      this.startPointCloud();
    }
    this.getPointcloud(selected_frame, "new");
    this.getPointcloud(selected_frame, "reference");
    this.getPointcloud(selected_frame, "groundtruth");
    this.setState({selected_frame});
  }
  
  closePointCloud() {
    console.log("killing context");
    // this.renderer.dispose();
	  this.renderer.forceContextLoss();
    this.setState({show_pointcloud: false});
  }

  stopPointCloud() {
    cancelAnimationFrame(this.frameId);
    console.log("killing context");
    this.renderer.forceContextLoss();
  }

  animate = () => {
    if (this.state.control === 'orbit') {
      this.controls.update();
    } else {
      let time = performance.now();
      let delta = ( time - this.prevTime ) / 1000;
      this.prevTime = time;

      this.velocity.x -= this.velocity.x * 10.0 * delta;
      this.velocity.z -= this.velocity.z * 10.0 * delta;
      this.velocity.y -= this.velocity.y * 10.0 * delta;

      this.direction.z = Number( this.moveForward ) - Number( this.moveBackward );
      this.direction.x = Number( this.moveLeft ) - Number( this.moveRight );
      this.direction.normalize(); // this ensures consistent movements in all directions
      if ( this.moveForward || this.moveBackward ) this.velocity.z -= this.direction.z * 400.0 * delta;
      if ( this.moveLeft || this.moveRight ) this.velocity.x -= this.direction.x * 400.0 * delta;


      this.controls.getObject().translateX(this.velocity.x * delta);
      this.controls.getObject().translateY(this.velocity.y * delta);
      this.controls.getObject().translateZ(this.velocity.z * delta);

      if (this.moveForward) this.velocity.z -= 400.0 * delta;
      if (this.moveBackward) this.velocity.z += 400.0 * delta;
      if (this.moveLeft) this.velocity.x -= 400.0 * delta;
      if (this.moveRight) this.velocity.x += 400.0 * delta;    
    }

    this.renderer.render(this.scene, this.camera);
    this.frameId = window.requestAnimationFrame(this.animate);
  };


  render() {
    const { output_new, output_ref } = this.props;
    const { selected_frame, frames, first_frame_id, last_frame_id, custom_output_filename, mesh_output, mesh_thresh, use_intensity, pcd_flip_xy } = this.state;
    const { show_pointcloud, pointclouds, selected_output_type } = this.state;
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

    let has_many_frame = output_new.metrics.frames !== undefined &&  output_new.metrics.frames.length > 1;
    let has_reference = output_ref !== undefined && output_ref !== null;

    let metric_traces = [
      make_metric_trace(frames['reference'], "reference"),
      make_metric_trace(frames['new'], "new"),
    ];
    let metric_layout = {
      height: 150,
      margin: { l: 50, r: 10, b: 50, t: 50, pad: 5 },
      xaxis: {
        title: "frame",
      },
      yaxis: {
        title: "PCMD",
      },
      legend: {
        orientation: "h",
        bgcolor: "rgba(255,255,255,0.5)",
        traceorder: "grouped",
        tracegroupgap: 0
      },
      ...(this.props.layout || {})
    };
    let heatmaps_layout = {
      title: `${selected_output_type} @${this.state.focus}`,
      ...this.state[selected_output_type].axes,
      width: 640,
      height: 564,
    };

    const { focus } = this.state;
    const heatmaps = this.state[selected_output_type] || {};
    const heatmap = heatmaps[selected_frame] || {is_loaded: false};
    let show_heatmap = this.state.show_heatmap && heatmap.is_loaded;
    let  heatmaps_data = show_heatmap ? [{
      ...(focus === "new" ? heatmap.newHexData : heatmap.refHexData),
      ...heatmaps.zscale,
    }] : []

    return (
      <>
        <p className={Classes.TEXT_MUTED}>
          {show_pointcloud ? (is_loaded && !!this.scene.getObjectByName("new")
                        ? <span>Showing {this.state.focus}. Press R/G to toogle the reference/ground-truth, +/- to adjust point size. <Button onClick={()=>this.closePointCloud()}>close</Button></span>
                        : "Loading...") : (has_many_frame ? "Click a point on the plot to show other frames." : "")}
        </p>
        <div hidden={!show_pointcloud} ref={threeRoot => {this.threeRoot = threeRoot;}}> </div>

        {has_many_frame && <>
          <Plot data={metric_traces} layout={metric_layout}/>}
          <Slider 
            min={first_frame_id}
            max={last_frame_id}
            onChange={selected_frame => {
              // we check that the frame exists, otherwise we don't update anything...
              if (!!frames['new'].get(selected_frame)) {
                this.setState({selected_frame})
                if (this.state.show_pointcloud)
                  this.updatePointCloud(selected_frame);
              }
            }}
            value={selected_frame}
            labelRenderer={idx => idx}
            labelStepSize={Math.ceil(output_new.metrics.frames.length / 20)}
            showTrackFill={false}
          />
        </>}

        <div>
          <h4 className={Classes.HEADING}>
            <a
              href={`${output_new.output_dir_url}/Frame${selected_frame}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Frame {selected_frame}
            </a>
          </h4>
          {
            show_heatmap
            ? <>
                <Plot data={heatmaps_data} layout={heatmaps_layout} />
                <div>
                  <RangeSlider
                    min={heatmaps.scaleMinMax.zmin} 
                    max={heatmaps.scaleMinMax.zmax} 
                    value={[heatmaps.zscale.zmin, heatmaps.zscale.zmax]} 
                    onChange={ ([zmin, zmax]) => this.setState({
                        [selected_output_type]: {
                          ...this.state[selected_output_type],
                          zscale: {zmin, zmax},
                        } 
                      })
                    }
                    labelStepSize={(heatmaps.scaleMinMax.zmax - heatmaps.scaleMinMax.zmin) / 20}
                    stepSize={0.1}
                  />
                </div>
              </>
            : <div>
                <img width={400} alt="New" src={`${output_new.output_dir_url}/Frame${selected_frame}/${selected_output_type}.png`} />
                {has_reference && <img width={400} alt="Reference" src={`${output_ref.output_dir_url}/Frame${selected_frame}/${selected_output_type}.png`} />}
              </div>
          }
        </div>
        <div className="viewButtons">
          <div>
            <Button onClick={e => this.setState({show_heatmap: !this.state.show_heatmap})}>{this.state.show_heatmap ? (heatmap.is_loaded ? "Show static image" : "loading...") : "Show heatmap"}</Button>&nbsp; &nbsp;
            <input type="text" id="customFileInput" value={`${custom_output_filename}`} onChange={e=> {this.setState({custom_output_filename: e.target.value})}}></input>
          </div>
          <div>
            <Button onClick={e => {this.setState({selected_output_type: "depth"})}}>Show depth</Button>
			<Button onClick={e => {this.setState({selected_output_type: "z"})}}>Show z</Button>
            <Button onClick={e => {this.setState({selected_output_type: "intensity"})}}>Show intensity</Button>
			<Button onClick={e => {this.setState({selected_output_type: "amplitude"})}}>Show amplitude</Button>
            <Button onClick={e => {this.setState({selected_output_type: "pcmdHeatmap"})}}>Show PCMD</Button>
            <Button onClick={e => {this.setState({selected_output_type: "AbsErrHeatmap"})}}>Show Abs Error</Button>
            <Button onClick={e => {this.setState({selected_output_type: "customMap"})}}>Show Custom</Button>
          </div>
          <div>
            <Button onClick={e => {
              if (!show_pointcloud)
                this.updatePointCloud(selected_frame)
              else
                this.closePointCloud()
            }}>
              {!show_pointcloud ? "Show Point Cloud"  : (!is_loaded ? "loading..." : "Hide point Cloud")}
            </Button>
            &nbsp; <input type="checkbox" id="use_intensity" checked={use_intensity} onChange={e=> { this.setState({use_intensity: e.target.checked}) }}></input> Use Intensity
            &nbsp; <input type="checkbox" id="mesh_output" checked={mesh_output} onChange={e=> { this.setState({mesh_output: e.target.checked}) }}></input> Mesh
            &nbsp; <input type="text" id="mesh_thresh" value={`${mesh_thresh}`} onChange={e=> { this.setState({mesh_thresh: e.target.value})  } }></input> Mesh Thresh
            &nbsp; <input type="checkbox" id="flip_xy" checked={pcd_flip_xy} onChange={e=> { this.setState({pcd_flip_xy: e.target.checked}) }}></input> Flip XY
          </div>
        </div>
      </>
    );
  }



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
          //console.log(pointcloud_new.material.size);
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
        let focus = this.state.focus === 'new' ? 'reference' : 'new';
        this.setState({focus})
        if (pointcloud_new !== undefined)
          pointcloud_new.visible = focus === 'new';
        if (pointcloud_ref !== undefined)
          pointcloud_ref.visible = focus === 'reference';
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
    }
  };




  // Toggles the component's focus in order to receive keyboard events.
  // When the component is focused, WASD keys control the viewpoint, otherwise we use the standard "orbit" controls.
  click = ev => {
    if (!!!this.renderer || !!!this.renderer.domElement)
      return
    this.renderer.domElement.focus();
  }

  keydown = ev => {
    console.log('keydown', ev)
    if (!!this.renderer && this.renderer.domElement === document.activeElement) {
      switch (ev.keyCode) {
        case 38: // up
        case 87: // w
          this.moveForward = true;
          break;
        case 37: // left
        case 65: // a
          this.moveLeft = true;
          break;
        case 40: // down
        case 83: // s
          this.moveBackward = true;
          break;
        case 39: // right
        case 68: // d
          this.moveRight = true;
          break;
        case 67: // c
        case 16: // 16
          let control = this.state.control === "pointerlock" ? 'orbit' : 'pointerlock';
          console.log(`... change controls to ${control}`)
          this.setControls(control)
          this.setState({control})
          break;
        default:
          return;
      }
    };    
  }

  keyup = ev => {
    console.log('keyup', ev)
    if (!!this.renderer && this.renderer.domElement === document.activeElement) {
      switch (ev.keyCode) {
        case 38: // up
        case 87: // w
          this.moveForward = false;
          break;
        case 37: // left
        case 65: // a
          this.moveLeft = false;
          break;
        case 40: // down
        case 83: // s
          this.moveBackward = false;
          break;
        case 39: // right
        case 68: // d
          this.moveRight = false;
          break;
        default:
          return;
      }
    };    
  }
}

export default TofOutputCard;
