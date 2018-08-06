/* global Plotly:true */
import React, { Component } from "react";
import * as THREE from "three";
import { PCDLoader } from "./PCDLoader";
import { OrbitControls } from "./OrbitControls";

import { Card, Icon, Tag, Intent, Popover, Colors } from "@blueprintjs/core";
import { MetricTag } from "../MetricsSummary";
import { main_metrics, available_metrics } from "./metrics";

import createPlotlyComponent from "react-plotly.js/factory";
const Plot = createPlotlyComponent(Plotly);

const aspect_ratio = 4 / 3;
const width = 640; // window.innerWidth;
const height = width / aspect_ratio; // window.innerHeight;

const colors = {
  groundtruth: `${Colors.GREEN2}dd`,
  new: `${Colors.ORANGE2}dd`,
  reference: `${Colors.BLUE2}dd`
};

var make_traces = function(metrics_over_frames, label) {
  if (metrics_over_frames === undefined) return [];
  return {
    type: "scatter",
    mode: "lines+markers",
    x: Object.keys(metrics_over_frames),
    y: Object.values(metrics_over_frames).map(m => m.rmse),
    line: {
      color: colors[label],
      width: label === "reference" ? 3 : 2 // ref wider to highlight bit accuracy
    },
    marker: {
      color: colors[label],
      size: 10
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
    if (props.output_new.metrics.frames !== undefined)
      var last_frame_id = props.output_new.metrics.frames.length - 1;
    else last_frame_id = 0;
    this.state = {
      show_pointcloud: false,
      selected_frame: last_frame_id,
      frames: {
        [last_frame_id]: {
          is_loaded: false,
          new: null,
          reference: null
        }
      }
    };
  }

  getFrame(frame_id, label) {
    var loader = new PCDLoader();
    if (label === "new") {
      var output = this.props.output_new;
    } else {
      output = this.props.output_ref;
      if (output.id === undefined) return;
    }
    var url = `${output.output_dir_url}/Frame${frame_id}/pointcloud.pcd`;
    loader.load(url, pointcloud => {
      if (pointcloud !== null) {
        var previous_pointcloud = this.scene.getObjectByName(label);
        console.log(previous_pointcloud)
        if (previous_pointcloud) 
          this.scene.remove(previous_pointcloud);

        pointcloud.name = label;
        if (label === "reference") {
          pointcloud.visible = false;
          pointcloud.material.size = 0.001;
          pointcloud.material.vertexColors = false;
          pointcloud.material.color.setHex(0x000000);
        }
        else {
          var center = pointcloud.geometry.boundingSphere.center;
          this.camera.position.z = center.y;
          this.controls.target.set(center.x, center.y, center.z);
          this.controls.update();
          this.scene.add(pointcloud);
        }
      }
      this.setState((previousState, props) => ({
        frames: {
          ...previousState.frames,
          [frame_id]: {
            ...previousState.frames[frame_id],
            is_loaded: true,
            [label]: pointcloud
          }
        }
      }));
    });
  }

  componentWillUnmount() {
    if (this.state.show_pointcloud) {
      this.stop();
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

    window.addEventListener("keypress", this.keyboard);
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
    console.log(selected_frame)
    this.getFrame(selected_frame, "new");
    this.getFrame(selected_frame, "reference");
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
    var pointcloud_new = this.scene.getObjectByName("new");
    var pointcloud_ref = this.scene.getObjectByName("reference");
    var pointcloud_gt = this.scene.getObjectByName("groundtruth");
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
        break;
      case "r":
        if (pointcloud_ref !== undefined)
          pointcloud_ref.visible = !pointcloud_ref.visible;
        break;
      case "g":
        if (pointcloud_gt !== undefined)
          pointcloud_gt.visible = !pointcloud_gt.visible;
        break;
      default:
        return;
      // todo:
      // - use directionnal arrows to change point of view
    }
  };

  render() {
    const { output_new, output_ref, warning, no_header } = this.props;
    const { show_pointcloud, frames, selected_frame } = this.state;
    let is_loaded =
      frames[selected_frame] && !!frames[selected_frame].is_loaded;

    const empty_metrics = { frames: [] };
    let metrics_new =
      output_new && output_new.metrics && output_new.metrics.frames
        ? output_new.metrics
        : empty_metrics;
    let metrics_ref =
      output_ref && output_ref.metrics && output_ref.metrics.frames
        ? output_ref.metrics
        : empty_metrics;

    const empty_data = { frames: [] };
    let data_new =
      output_new && output_new.metrics && output_new.metrics.frames
        ? output_new.metrics
        : empty_data;
    let data_ref =
      output_ref && output_ref.metrics && output_ref.metrics.frames
        ? output_ref.metrics
        : empty_data;

    // console.log(output_new)
    // console.log(data_new.frames)

    if (!metrics_new || !metrics_ref || !data_new || !data_ref) return <span />;

    let tags = (
      <span>
        {Object.entries(output_new.extra_parameters).map(([k, v]) => (
          <Tag key={k} intent={Intent.PRIMARY} className="pt-round pt-minimal">
            {k}:{v}
          </Tag>
        ))}
        <a
          title="Show output files"
          style={{ paddingLeft: "5px" }}
          target="_blank"
          href={output_new.output_dir_url}
        >
          <Icon icon="download" />
        </a>
        {warning && (
          <Popover interactionKind="hover">
            <Icon intent={Intent.WARNING} icon="warning-sign" />
            <span>{warning}</span>
          </Popover>
        )}
      </span>
    );

    let traces = [
      make_traces(metrics_new.frames, "new"),
      make_traces(metrics_ref.frames, "reference")
    ];
    let layout = this.props.layout || {};
    let card_width = layout.width !== undefined ? `${layout.width}px` : "840px";
    let layout_ = {
      height: 150,
      margin: { l: 50, r: 10, b: 50, t: 50, pad: 5 },
      xaxis: {
        title: "frame"
      },
      yaxis: {
        title: "RMSE"
      },
      legend: {
        orientation: "h",
        bgcolor: "rgba(255,255,255,0.5)",
        traceorder: "grouped",
        tracegroupgap: 0
      },
      ...layout
    };
    const output_types = ["depth"]; //, 'intensity'];

    return (
      <div style={{ flex: "0 0 auto", marginBottom: "20px", card_width }}>
        <Card className="output-card">
          {!no_header && (
            <div>
              <h5
                style={{
                  fontSize: ".7rem",
                  fontWeight: 500,
                  lineHeight: 1.6,
                  letterSpacing: "-1px"
                }}
              >
                {output_new.test_input_path}{" "}
                <Tag className="pt-minimal" style={{ marginRight: "10px" }}>
                  Frame {selected_frame}/{metrics_new.frames.length - 1}
                </Tag>{" "}
                {tags}
              </h5>
              {main_metrics
                .filter(key => metrics_new[key] !== undefined)
                .map(key => (
                  <p key={key}>
                    <MetricTag
                      metrics_new={metrics_new}
                      metrics_ref={metrics_ref}
                      metric_info={available_metrics[key]}
                    />
                  </p>
                ))}
            </div>
          )}

          <p className="pt-text-muted">
            {show_pointcloud ? (is_loaded
                          ? "Press R/G to toogle the reference/ground-truth, +/- to adjust point size."
                          : "Loading...") : "Click on a depth image or a point on the plot to show pointclouds."}
          </p>
          <div
            ref={threeRoot => {
              this.threeRoot = threeRoot;
            }}
          >
            {is_loaded && this.renderer.render(this.scene, this.camera)}
          </div>

          <p className="pt-text-muted">
            {is_loaded
              ? "Click on a RMSE point below to select the corresponding frame."
              : "Loading..."}
          </p>
          <Plot data={traces} layout={layout_} onClick={e => { this.updatePointCloud(e.points[0].pointNumber)}} />

          {data_new.frames.map((f, index) => {
            return (
              <div key={index}>
                <h4>
                  <a
                    href={`${output_ref.output_dir_url}/Frame${index}`}
                    target="_blank"
                  >
                    Frame {index}
                  </a>
                </h4>
                {output_types.map(output_type => {
                  let img_new = `${
                    output_new.output_dir_url
                  }/Frame${index}/${output_type}.png`;
                  let img_ref = `${
                    output_ref.output_dir_url
                  }/Frame${index}/${output_type}.png`;
                  return (
                    <div key={output_type}>
                      <img width={400} onClick={e => this.updatePointCloud(index)} alt="New" src={img_new} />
                      <img width={400} onClick={e => this.updatePointCloud(index)} alt="Reference" src={img_ref} />
                    </div>
                  );
                })}
              </div>
            );
          })}

          {false && <p>{JSON.stringify(output_new)}</p>}
        </Card>
      </div>
    );
  }
}

// <div ref={(threeRoot) => { this.threeRoot = threeRoot }}>{renderer.domElement}</div>
// <div ref={this.threeRoot}>{renderer.domElement}</div>
// <div dangerouslySetInnerHTML={{__html: renderer.domElement}} ></div>

export { TofOutputCard };
