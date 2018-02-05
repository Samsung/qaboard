/* global Plotly:true */
// import Plot from 'react-plotly.js'
import React, { Component, Fragment } from "react";
import { get, all, spread } from "axios";
import styled from "styled-components";
import { Card, ProgressBar } from "@blueprintjs/core";
import { MetricTag } from "./Metrics";
import { SyncedVideos } from "./SyncedVideos";

import createPlotlyComponent from 'react-plotly.js/factory'
const Plot = createPlotlyComponent(Plotly);



const SlimCard = styled(Card)`
  padding: 0px !important;
  overflow: 'auto';
`

class OutputCard extends Component {
  constructor(props) {
    super(props);
    this.state = {
      isLoaded: false,
    };
  }

  componentDidMount() {
    const { output_new, output_ref} = this.props;
    let get_gt = () => {
      return get(`${output_new.output_dir_url}/GT_final.txt`)
        .then(response => this.setState({
          '6dof_groudtruth': parse_poses(response.data, output_new.time_offset_to_groundtruth)
        })).catch()
    }
    let get_new = () => {
      return get(`${output_new.output_dir_url}/camera_poses_debug.csv`)
        .then(response => this.setState({
          '6dof_new': parse_poses(response.data, output_new.time_offset_to_groundtruth)
        })).catch()
    }
    let get_ref = () => {
      return get(`${output_ref.output_dir_url}/camera_poses_debug.csv`)
        .then(response => this.setState({
          '6dof_ref': parse_poses(response.data, output_ref.time_offset_to_groundtruth)
        })).catch()
    }

    all([
      get_gt(),
      get_new(),
      get_ref()
    ])
     .then(spread((req_gt, req_new, req_ref) => {
        this.setState({isLoaded: true})
      }))
    }

  render() {
    const {output_new, output_ref} = this.props;
    var traces = []
    if (this.state['6dof_groudtruth']) {
      traces = [...traces, ...make_traces(this.state['6dof_groudtruth'], 'ground_truth', colors_compare)]
    }
    if (this.state['6dof_ref']) {
      traces = [...traces, ...make_traces(this.state['6dof_ref'], 'reference', colors_compare)]
    }
    if (this.state['6dof_new']) {
      traces = [...traces, ...make_traces(this.state['6dof_new'], 'new', colors_compare)]
    }


    return <Fragment> {!output_new.is_failed && !output_new.is_pending &&
              <div style={{flex: '0 0 auto', width: '350px', marginBottom: '20px'}}>
                <SlimCard className="output-card">
                  <div style={{padding:'  '}}>
                    <h5 style={{fontSize:'.7rem', fontWeight: 500, lineHeight: 1.6, letterSpacing: '-1px'}}>{output_new.recording_path}</h5>
                    {output_new.translation_rmse>0 && <p><MetricTag output={output_new} output_ref={output_ref} metric='translation_aape'/></p>}
                    {output_new.rotation_mean>0 && <p><MetricTag output={output_new} output_ref={output_ref} metric='rotation_mean'/></p>}
                  </div>
                  <SyncedVideos
                    src_new={`${output_new.output_dir_url}/results.mp4`}
                    src_ref={`${output_ref.output_dir_url}/results.mp4`}
                    poster_new={`${output_new.output_dir_url}/poster.jpg`}
                    poster_ref={`${output_ref.output_dir_url}/poster.jpg`}
                  />
                  {!this.state.isLoaded && <ProgressBar/>}
                  {this.state.isLoaded && <Plot revision={0} data={traces} layout={layout}></Plot>}
                </SlimCard>
              </div>}
            </Fragment>
  }
}


const parse_poses = (text_string, gt_time_offset) => {
  let headers = ["a","b","c","x", "y", "z", "t", "confidence", "tracking_state\n"].join('\t');
  let data = Plotly.d3.tsv.parse(headers + text_string);
  let x=[], y=[], z=[];
  let a=[], b=[], c=[];
  let t=[];
  let confidence=[], tracking_state=[];

  let t0 = data[0]['t'];

  // we ignore the 1st point, often far away in time...
  for (let i=1; i<data.length; i++) {
    // if (i%10!=0)
    //   continue
    let row = data[i];
    a.push(row['a']);
    b.push(row['b']);
    c.push(row['c']);
    x.push(row['x']);
    y.push(row['y']);
    z.push(row['z']);
    t.push(parseFloat(row['t']-t0));
    // we don't rely on per-commit-sync anymore
    // t.push(parseFloat(row['t'])+gt_time_offset);
    confidence.push(row['confidence']/100);
    tracking_state.push(row['tracking_state']);
  };
  return {x, y, z, a, b, c, t, confidence, tracking_state};
}


var make_traces = function(poses, label, colors) {
  let mode = 'lines';
  let line_width = 2;
  // we make the reference wider to highlight bit accuracy
  if (label === 'reference')
    line_width = 3;

  let marker_size = 5;
  return [
    {
      x: poses.t, y: poses.x,
      line: { color: colors[label].x, width: line_width },
      marker: { color: colors[label].x, size: marker_size },
      mode,
      name: label, legendgroup:label
    },
    {
      x: poses.t, y: poses.y,
      line: { color: colors[label].y, width: line_width },
      marker: { color: colors[label].y, size: marker_size },
      mode,
      yaxis: 'y2',
      name: label, legendgroup:label,
      showlegend: false
    },
    {
      x: poses.t, y: poses.z,
      line: { color: colors[label].z, width: line_width },
      marker: { color: colors[label].z, size: marker_size },
      mode,
      name: label, legendgroup:label,
      yaxis: 'y3',
      showlegend: false
    },
    {
      x: poses.t, y: poses.a,
      line: { color: colors[label].x, width: line_width },
      marker: { color: colors[label].x, size: marker_size },
      mode,
      name: label, legendgroup:label,
      yaxis: 'y4',
      showlegend: false
    },
    {
      x: poses.t, y: poses.b,
      line: { color: colors[label].y, width: line_width },
      marker: { color: colors[label].y, size: marker_size },
      mode,
      name: label, legendgroup:label,
      yaxis: 'y5',
      showlegend: false
    },
    {
      x: poses.t, y: poses.c,
      line: { color: colors[label].z, width: line_width },
      marker: { color: colors[label].z, size: marker_size },
      mode,
      name: label, legendgroup:label,
      yaxis: 'y6',
      showlegend: false
    },
    {
      x: poses.t, y: poses.confidence,
      line: { color: colors[label].confidence, width: line_width },
      marker: { color: colors[label].confidence, size: marker_size },
      mode,
      name: label, legengroup:label,
      yaxis: 'y7',
      showlegend: false
    },
    {
      x: poses.t, y: poses.tracking_state,
      line: { color: colors[label].tracking_state, width: line_width },
      marker: { color: colors[label].tracking_state, size: marker_size },
      mode,
      name: label, legengroup:label,
      yaxis: 'y7',
      showlegend: false
    }
  ]
}





var n_yaxis = 7;
var frac_v = 1.0/n_yaxis;
var layout = {
  type: 'scattergl', // try sc
  height:600,
  width:350,
  // autosize: false,
  margin: { l: 60, r: 0, b: 50, t: 50, pad: 10 },
  yaxis:  {domain: [0*frac_v, 1*frac_v], title: 'tX'},
  yaxis2: {domain: [1*frac_v, 2*frac_v], title: 'tY'},
  yaxis3: {domain: [2*frac_v, 3*frac_v], title: 'tZ'},
  yaxis4: {domain: [3*frac_v, 4*frac_v], title: 'rX'},
  yaxis5: {domain: [4*frac_v, 5*frac_v], title: 'rY'},
  yaxis6: {domain: [5*frac_v, 6*frac_v], title: 'rZ'},
  yaxis7: {domain: [6*frac_v, 1], title: 'Tracking'},
  legend: {
    x:0,
    y:1,
    bgcolor: 'rgba(255,255,255,0.5)',
    traceorder:'grouped',
    tracegroupgap: 0
    // orientation: "h",
    // yanchor: "bottom", 
  }
}


// 157
var color_new = 'rgba(255, 131, 0, .9)' // Red: 'rgba(228, 26, 28, .9)'
var color_ref = 'rgb(25,34,231)'
var colors_compare = {
  ground_truth : {
    x: '#4daf4a',
    y: '#4daf4a',
    z: '#4daf4a',
    confidence: '#4daf4a',
    tracking_state: '#4daf4a',
  },
  // offline : {
  //   x: '#a6dba0',
  //   y: '#a6dba0',
  //   z: '#a6dba0',
  //   confidence: '#a6dba0',
  //   tracking_state: '#a6dba0',
  // },
  // s8...
  new : {
    x: color_new,
    y: color_new,
    z: color_new,
    confidence: '#d8b365',
    tracking_state: color_new,
  },
  // ref_offline : {
  //   x: '#c2a5cf',
  //   y: '#c2a5cf',
  //   z: '#c2a5cf',
  //   confidence: '#c2a5cf',
  //   tracking_state: '#c2a5cf',
  // },
  // ref_s8...
  reference : {
    x: color_ref,
    y: color_ref,
    z: color_ref,
    confidence: '#5ab4ac',
    tracking_state: color_ref,
  }
}


export { OutputCard };
