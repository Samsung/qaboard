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
  groundtruth : '#4daf4a',
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
      isLoadedDebug: false,
      showDebug: false,

      traces_6dof: {},
      traces_3d: {},
      traces_debug: {},

      plotRevision: 0,
    };
  }

  componentDidMount() {
    const { output_new, output_ref } = this.props;
    let has_groundtruth = output_new.translation_aape!==null;
    if (has_groundtruth) {
      var get_gt = () => {
        return get(`${output_new.output_dir_url}/GT_final.txt`)
            .then(response => {
              let poses = parse_poses(response.data, output_new.time_offset_to_groundtruth);
              this.setState({
                traces_6dof: {...this.state.traces_6dof, groundtruth: make_traces(poses, 'groundtruth')},
                traces_3d: {...this.state.traces_3d, groundtruth: make_traces3d(poses, 'groundtruth')},
              })
            })
            .catch(e=>{})
      }
    } else {
      get_gt = () => {}; 
    }
    var get_new = () => {
      return get(`${output_new.output_dir_url}/camera_poses_debug.csv`)
        .then(response => {
          let poses = parse_poses(response.data, output_new.time_offset_to_groundtruth);
          this.setState({
             traces_6dof: {...this.state.traces_6dof, new: make_traces(poses, 'new')},
             traces_3d: {...this.state.traces_3d, new: make_traces3d(poses, 'new')},
          })
        }).catch(e=>{})
    }
    var get_ref;
    if (output_ref!==undefined) {
      get_ref = () => {
        return get(`${output_ref.output_dir_url}/camera_poses_debug.csv`)
          .then(response => {
            let poses = parse_poses(response.data, output_ref.time_offset_to_groundtruth)
            this.setState({
              traces_6dof: {...this.state.traces_6dof, reference: make_traces(poses, 'reference')},
              traces_3d: {...this.state.traces_3d, reference: make_traces3d(poses, 'reference')},
            })
          }).catch(e=>{})
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
        this.setState({
          isLoaded: true
        })
      }))
     .catch(()=>{ this.setState({isLoaded: true})} )
    }

  toogleShowDebug = () => {
    this.setState({
      showDebug: !this.state.showDebug,
    })
    if (!this.state.isLoadedDebug)
      this.loadDebug()
    else
      this.setState({plotRevision: this.state.plotRevision+1})
  }

  loadDebug() {
    const { output_new, output_ref } = this.props;
    var get_new_debug = () => {
      return get(`${output_new.output_dir_url}/DebugExtensions.txt`)
        .then(response => {
          let poses = parse_debug(response.data, output_new.time_offset_to_groundtruth)
          this.setState({
            traces_debug: {...this.state.traces_debug, new: make_traces_debug(poses, 'new')},
          })
        }).catch(e=>{})
    }
    var get_ref_debug = () => {
      return get(`${output_ref.output_dir_url}/DebugExtensions.txt`)
        .then(response => {
          let poses = parse_debug(response.data, output_ref.time_offset_to_groundtruth)
          this.setState({
            traces_debug: {...this.state.traces_debug, reference: make_traces_debug(poses, 'reference')},
          })
        }).catch(e=>{})
    }
    all([
      get_new_debug(),
      get_ref_debug(),
    ])
     .then(spread((req_new, req_ref) => {
        this.setState({
          isLoadedDebug: true,
          plotRevision: this.state.plotRevision+1,
        })
      })).catch(()=>{this.setState({isLoadedDebug: true})})
  }

  render() {
    const { output_new, output_ref, show3d, showVideos } = this.props;
    const { isLoaded, showDebug, plotRevision } = this.state;
  
    var traces = [];
    if (this.state.traces_6dof.groundtruth)
      traces = [...traces, ...this.state.traces_6dof.groundtruth];
    if (this.state.traces_6dof.reference)
      traces = [...traces, ...this.state.traces_6dof.reference];
    if (this.state.traces_6dof.new)
      traces = [...traces, ...this.state.traces_6dof.new];
    if (showDebug) {
      if (this.state.traces_debug.reference)
        traces = [...traces, ...this.state.traces_debug.reference];
      if (this.state.traces_debug.new)
        traces = [...traces, ...this.state.traces_debug.new];      
    }

    if (show3d) {
      var traces3d = [];
      if (this.state.traces_3d.groundtruth)
        traces3d = [...traces3d, this.state.traces_3d.groundtruth];
      if (this.state.traces_3d.reference)
        traces3d = [...traces3d, this.state.traces_3d.reference];
      if (this.state.traces_3d.new)
        traces3d = [...traces3d, this.state.traces_3d.new];
    }

    let tags = <span>
      <Tag intent={Intent.PRIMARY} className="pt-round pt-minimal">{output_new.platform}</Tag>
      <Tag intent={Intent.PRIMARY} className="pt-round pt-minimal">{output_new.configuration}</Tag>
      <Button onClick={this.toogleShowDebug} className="pt-minimal" style={{paddingLeft: '12px'}} text="toogle debug plots" intent={showDebug ? Intent.PRIMARY : Intent.NONE} iconName="series-add" />
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
                  {showVideos && <SyncedVideos
                    src_new={`${output_new.output_dir_url}/results.mp4`}
                    src_ref={output_ref && `${output_ref.output_dir_url}/results.mp4`}
                    poster_new={`${output_new.output_dir_url}/poster.jpg`}
                    poster_ref={output_ref && `${output_ref.output_dir_url}/poster.jpg`}
                  />}
                  {show3d && isLoaded && <Plot
                    data={traces3d}
                    layout={layout3d}
                    revision={plotRevision}
                  />}
                  {isLoaded && <Plot
                    data={traces}
                    layout={make_layout(showDebug, this.state.traces_debug.new)}
                    revision={plotRevision}
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
    let row = data[i];
    rX.push(parseFloat(row['rX']));
    rY.push(parseFloat(row['rY']));
    rZ.push(parseFloat(row['rZ']));
    tX.push(parseFloat(row['tX']));
    tY.push(parseFloat(row['tY']));
    tZ.push(parseFloat(row['tZ']));
    t.push(parseFloat(row['t']-t0));
    // we don't rely on per-commit-sync anymore
    // t.push(parseFloat(row['t'])+gt_time_offset);
    confidence.push(parseFloat(row['confidence']/100));
    tracking_state.push(parseFloat(row['tracking_state']));
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

var make_traces3d = function(poses, label) {
  const sample = (x,i) => i%5===0;
  return {
      type: 'scatter3d',
      x: poses.tX.filter(sample),
      y: poses.tY.filter(sample),
      z: poses.tZ.filter(sample),
      mode: 'lines',
      line: {
        width: label === 'reference' ? 2 : 1,
        color: colors[label],
        opacity: 0.8,
      },
      name: label, legendgroup:label,
      showlegend: true,
  }
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


const make_layout = (showDebug, debug_data) => {
  // 6dof+confidence and the debug info
  var n_yaxis = showDebug && debug_data !== undefined ? 7 + Object.keys(debug_data).length : 7;
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
  if (showDebug && debug_data !== undefined) {
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

const layout3d = {
  width: 350,
  height: 350,
  margin: { l: 60, r: 0, b: 50, t: 50, pad: 10 },
  legend: {
    x:0,
    y:1,
    bgcolor: 'rgba(255,255,255,0.5)',
    traceorder:'grouped',
    tracegroupgap: 0
  }
}

export { OutputCard };
