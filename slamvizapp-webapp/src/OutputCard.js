/* global Plotly:true */
// import Plot from 'react-plotly.js'
import React, { Component, Fragment } from "react";
import { get, all, spread } from "axios";
import { tsvParse } from "d3-dsv";
import styled from "styled-components";
import { Card, Icon, Tag, Button, Intent } from "@blueprintjs/core";
import { MetricTag } from "./Metrics";
import { SyncedVideos } from "./SyncedVideos";

import createPlotlyComponent from 'react-plotly.js/factory'
const Plot = createPlotlyComponent(Plotly);



var colors = {
  ground_truth : '#4daf4a',
  new : 'rgba(255, 131, 0, .9)',
  reference : 'rgb(25,34,231)',
}

const SlimCard = styled(Card)`
  padding: 0px !important;
  overflow: 'auto';
`

class OutputCard extends Component {
  constructor(props) {
    super(props);
    this.state = {
      isLoaded: false,
      showDebug: false,
      isLoadedDebug: false,
      plotRevision: 0,
    };
  }

  componentDidMount() {
    const { output_new, output_ref } = this.props;
    if (output_new.translation_aape!==null) {
      var get_gt = () => {
        return get(`${output_new.output_dir_url}/GT_final.txt`)
          .then(response => this.setState({
            '6dof_groudtruth': make_traces(parse_poses(response.data, output_new.time_offset_to_groundtruth), 'ground_truth')
          })
          ).catch(e=>{})
      }
    } else {
      get_gt = () => {}; 
    }
    var get_new = () => {
      return get(`${output_new.output_dir_url}/camera_poses_debug.csv`)
        .then(response => this.setState({
          '6dof_new': make_traces(parse_poses(response.data, output_new.time_offset_to_groundtruth), 'new')
        })).catch(e=>{})
    }
    var get_ref;
    if (output_ref!==undefined) {
      get_ref = () => {
        return get(`${output_ref.output_dir_url}/camera_poses_debug.csv`)
          .then(response => this.setState({
            '6dof_ref': make_traces(parse_poses(response.data, output_ref.time_offset_to_groundtruth), 'reference')
          })).catch(e=>{})
      }      
    } else {
      get_ref = () => {};
    }

    all([
      get_gt(),
      get_new(),
      get_ref()
    ])
     .then(spread((req_gt, req_new, req_ref) => {
        this.setState({isLoaded: true})
      })).catch(()=>{this.setState({isLoaded: true})})
    }

  toogleShowDebug = () => {
    this.setState({showDebug:!this.state.showDebug})
    if (!this.state.isLoadedDebug)
      this.loadDebug()
    else {
        this.setState({plotRevision: this.state.plotRevision+1})
    }
  }

  loadDebug() {
    const { output_new, output_ref } = this.props;
    var get_new_debug = () => {
      return get(`${output_new.output_dir_url}/DebugExtensions.txt`)
        .then(response => this.setState({
          'debug_new': make_traces_debug(parse_debug(response.data, output_new.time_offset_to_groundtruth), 'new')
        })).catch(e=>{})
    }
    var get_ref_debug = () => {
      return get(`${output_ref.output_dir_url}/DebugExtensions.txt`)
        .then(response => this.setState({
          'debug_ref': make_traces_debug(parse_debug(response.data, output_ref.time_offset_to_groundtruth), 'reference')
        })).catch(e=>{})
    }
    all([
      get_new_debug(),
      get_ref_debug(),
    ])
     .then(spread((req_new, req_ref) => {
        this.setState({isLoadedDebug: true, plotRevision: this.state.plotRevision+1})
      })).catch(()=>{this.setState({isLoadedDebug: true})})
  }

  render() {
    const { output_new, output_ref } = this.props;
    var traces = [];
    if (this.state['6dof_groudtruth'])
      traces = [...traces, ...this.state['6dof_groudtruth']];
    if (this.state['6dof_ref'])
      traces = [...traces, ...this.state['6dof_ref']];
    if (this.state['6dof_new'])
      traces = [...traces, ...this.state['6dof_new']];
    if (showDebug && this.state['debug_ref'])
      traces = [...traces, ...this.state['debug_ref']];
    if (showDebug && this.state['debug_new'])
      traces = [...traces, ...this.state['debug_new']];

    let tags = <span>
      <Tag intent={Intent.PRIMARY} className="pt-round pt-minimal">{output_new.platform}</Tag>
      <Tag intent={Intent.PRIMARY} className="pt-round pt-minimal">{output_new.configuration}</Tag>
      <Button onClick={this.toogleShowDebug} className="pt-minimal" style={{paddingLeft: '12px'}} text="toogle debug plots" intent={this.state.showDebug ? Intent.PRIMARY : Intent.NONE} iconName="series-add" />
      <a title="Show output files" style={{paddingLeft: '8px'}} target="_blank" href={output_new.output_dir_url}><Icon iconName="folder-shared"/></a>
    </span>

    return <Fragment> {!output_new.is_failed && !output_new.is_pending &&
              <div style={{flex: '0 0 auto', width: '350px', marginBottom: '20px'}}>
                <SlimCard className="output-card">
                  <div style={{padding:'  '}}>
                    <h5 style={{fontSize:'.7rem', fontWeight: 500, lineHeight: 1.6, letterSpacing: '-1px'}}>{output_new.recording_path} {tags}</h5>
                    {output_new.translation_rmse>0 && <p><MetricTag output={output_new} output_ref={output_ref} metric='translation_aape'/></p>}
                    {output_new.rotation_mean>0 && <p><MetricTag output={output_new} output_ref={output_ref} metric='rotation_mean'/></p>}
                  </div>
                  <SyncedVideos
                    src_new={`${output_new.output_dir_url}/results.mp4`}
                    src_ref={output_ref && `${output_ref.output_dir_url}/results.mp4`}
                    poster_new={`${output_new.output_dir_url}/poster.jpg`}
                    poster_ref={output_ref && `${output_ref.output_dir_url}/poster.jpg`}
                  />
                  {this.state.isLoaded && <Plot
                    revision={this.state.plotRevision}
                    data={traces}
                    layout={make_layout(this.state.debug_new)}
                  />}
                </SlimCard>
              </div>}
            </Fragment>
  }
}

const parse_debug = (text_string, gt_time_offset) => {
  let data = tsvParse(text_string);
  var output = {}
  data.columns.forEach(c=>output[c]=[])

  let t0 = data[0]['t'];
  for (let i=1; i<data.length; i++) { // we don't plot the 1st point, often far away in time...
    let row = data[i];
    row['t'] = parseFloat(row['t']-t0);
    data.columns.forEach(c=>output[c].push(parseFloat(row[c])));
  };
  return output;
}



const parse_poses = (text_string, gt_time_offset) => {
  let headers = ["rX","rY","rZ","tX", "tY", "tZ", "t", "confidence", "tracking_state\n"].join('\t');
  let data = tsvParse(headers + text_string);
  let tX=[], tY=[], tZ=[];
  let rX=[], rY=[], rZ=[];
  let t=[];
  let confidence=[], tracking_state=[];

  let t0 = data[0]['t'];

  // we ignore the 1st point, often far away in time...
  for (let i=1; i<data.length; i++) {
    // if (i%10!=0)
    //   continue
    let row = data[i];
    rX.push(row['rX']);
    rY.push(row['rY']);
    rZ.push(row['rZ']);
    tX.push(row['tX']);
    tY.push(row['tY']);
    tZ.push(row['tZ']);
    t.push(parseFloat(row['t']-t0));
    // we don't rely on per-commit-sync anymore
    // t.push(parseFloat(row['t'])+gt_time_offset);
    confidence.push(row['confidence']/100);
    tracking_state.push(row['tracking_state']);
  };
  return {rX, rY, rZ, tX, tY, tZ, t, confidence, tracking_state};
}


var make_traces = function(poses, label) {
  let columns = ["tZ", "tY", "tX", "rZ", "rY","rX", "confidence", "tracking_state"];
  return columns.map((c,index)=> {
    return {
      x: poses.t, y: poses[c],
      line: {
        color: colors[label],
        width: label === 'reference' ? 3 : 2, // ref wider to highlight bit accuracy
      },
      marker: {
        color: colors[label],
        size: 5
      },
      mode: 'lines',
      name: label, legendgroup:label,
      yaxis: `y${Math.min(index+1, 7)}`,
      showlegend: index===0 ? true : false,
    }
  })
}

const make_traces_debug = (data, label) => {
  let traces = Object.keys(data)
    .filter(c=>c!=='t')
    .map( (c, index) => {
      return {
        x: data.t, y: data[c],
        line: {
          color: colors[label],
          width: label === 'reference' ? 3 : 2, // reference wider to highlight bit accuracy
        },
        marker: {
          color: colors[label],
          size: 5
        },
        mode: 'lines',
        name: c, legendgroup:label,
        yaxis: `y${8+index}`,
        showlegend: false,
      }
  })
  return traces;
}


const make_layout = (debug_data) => {
  // 6dof+confidence and the debug info
  var n_yaxis = debug_data !== undefined ? 7 + Object.keys(debug_data).length : 7;
  var frac_v = 1.0/n_yaxis;
  var layout = {
    type: 'scattergl', // try scatter
    height:Math.min(85*n_yaxis, 1200),
    width:350,
    // autosize: false,
    margin: { l: 60, r: 0, b: 50, t: 50, pad: 10 },
    legend: {
      x:0,
      y:1,
      bgcolor: 'rgba(255,255,255,0.5)',
      traceorder:'grouped',
      tracegroupgap: 0
    }
  }
  var axes = ["tZ", "tY", "tX", "rZ", "rY", "rX", "Tracking"];
  if (debug_data !== undefined) {
    let debug_axes = Object.values(debug_data).map(t=>t.name);
    axes = axes.concat(debug_axes)
  }
  axes.forEach( (title, index) => {
    let yaxis = `yaxis${index===0 ? '' : index+1}`;
    layout[yaxis] = {
      domain: [index*frac_v, (index+1)*frac_v],
      titlefont: {size: index>8 ? 10 : 12},
      title
    };
  });
  return layout;
}

export { OutputCard };
