/* global Plotly:true */
// import Plot from 'react-plotly.js'
import React, { Component } from "react";
import createPlotlyComponent from 'react-plotly.js/factory'
import { Callout, Colors, Intent, FormGroup, Switch } from "@blueprintjs/core";

import { Section } from "../common/containers";
import { groupBy, groupByObject } from "../common/utils";
import { slam_metrics, default_metric } from "../slam/metrics";

const Plot = createPlotlyComponent(Plotly);
const config = {};


const Sensibility1DLines = ({ slam_outputs, metric, parameter, layout }) => {
  let slam_outputs_by_recording = groupBy(Object.values(slam_outputs), "recording_path");
  let traces = Object.entries(slam_outputs_by_recording)
                     .map( ([recording_path, slam_outputs_for_recording]) => {
                        let slam_outputs = slam_outputs_for_recording
                                           .filter( o => !o.is_pending && !o.is_failed)
                                           .sort( (a,b) => a.extra_parameters[parameter] - b.extra_parameters[parameter])
                        return {
                          type: 'scatter',
                          name: recording_path,
                          x: slam_outputs.map(o => o.extra_parameters[parameter]),
                          y: slam_outputs.map(o => o.metrics[metric.key] * metric.scale),
                          marker: {
                            size: 4,
                            // color: Colors.ORANGE4,
                            opacity: 0.8,
                          },
                          line: {
                            width: 1,
                            // color: Colors.ORANGE5,
                            opacity: 0.8,
                          }
                        }
                      })
  const layout_ = {
    hovermode: 'closest',
    hoverinfo: 'name',
    hoverlabel: {
      namelength: -1,
    },
    showlegend: false,
    xaxis: {
      title: parameter,
    },
    yaxis: {
      title: metric.label,
      type:'log',
      autotick: false,
      dtick:0.69897000433,
      exponentformat:'SI',
      showgrid: false,
      zeroline: false,
      gridcolor: 'rgb(255, 255, 255)',
      gridwidth: 1,
    },
    ...layout,
  }
  return <Plot data={traces} layout={layout_} config={config}/>
}

const Sensibility1DBoxplots = ({ slam_outputs, metric, parameter, layout }) => {
  let slam_outputs_values = Object.values(slam_outputs)
                            .map(o => ({
                              ...o,
                              extra_parameter: o.extra_parameters[parameter]
                            }) );
  let slam_outputs_by_param = groupBy(slam_outputs_values, "extra_parameter");
  let traces = Object.entries(slam_outputs_by_param)
                     .map( ([param_value, slam_outputs_for_recording]) => {
                        let slam_outputs = slam_outputs_for_recording
                                           .filter( o => !o.is_pending && !o.is_failed)
                        return {
                          type: 'box',
                          name: param_value,
                          x: slam_outputs.map(o => o.extra_parameters[parameter]),
                          y: slam_outputs.map(o => o.metrics[metric.key] * metric.scale),
                          marker: {
                            color: Colors.ORANGE3,
                          },
                        }
                      })
  const layout_ = {
    hovermode: 'closest',
    boxgap: 0,
    boxgroupgap: 0,
    showlegend: false,
    xaxis: {
      title: parameter,
    },
    yaxis: {
      title: metric.label,
      type:'log',
      autotick: false,
      dtick:0.69897000433,
      exponentformat:'SI',
      showgrid: false,
      zeroline: false,
      gridcolor: 'rgb(255, 255, 255)',
      gridwidth: 1,
    },
    ...layout,
  }
  return <Plot data={traces} layout={layout_} config={config}/>
}


// SensibilityScatterMatrix
// type: 'splom', // Scatter PLOt Matrix
// diagonal: {visible: true},
// showUpperHalf: false,
// showLowerHalf: true,
// dimensions: parameters.map(p => ({
//   label: p,
//   values: slam_outputs.map(o => o.metrics[metric.key] * metric.scale),
// })),

const average = array => {
  return array.reduce( (a,b) => (a+b) , 0) / array.length;
}

const Sensibility2DContour = ({ slam_outputs, metric, parameters, layout }) => {
  // https://plot.ly/javascript/reference/#contour
  // https://plot.ly/javascript/contour-plots/
  let slam_outputs_ok = Object.values(slam_outputs).filter( o => !o.is_pending && !o.is_failed);
  // todo: aggregate median/mean per recording..

  let slam_outputs_by_param = groupByObject(slam_outputs_ok, "extra_parameters");
  // console.log(slam_outputs_by_param)

  let slam_outputs_aggregated = Object.entries(slam_outputs_by_param).map( ([extra_parameters, outputs]) => {
    Object.values(slam_metrics).forEach( m => {
      let values = outputs.map( o => o.metrics[m.key]).filter(x => x!==undefined)
      outputs[0].metrics[m.key] = average(values)
    })
    return outputs[0]
  })
  // console.log(slam_outputs_aggregated)

  let traces = [{
    type: 'contour',
    x: slam_outputs_aggregated.map(o => o.extra_parameters[parameters[0]]),
    y: slam_outputs_aggregated.map(o => o.extra_parameters[parameters[1]]),
    // a matrix???/
    z: slam_outputs_aggregated.map(o => o.metrics[metric.key] * metric.scale),
    contours: {
      coloring: 'heatmap', // apply a gradient within each contour
      showlabels: true,
      labelfont: {
        size: 8,
        color: '#ffffff',
      }
    },
    // zsmooth: 'best',// default
    connectgaps: false,
    colorscale: 'Viridis',
    // reversescale: true,
    // showscale: false,
  }]
  const layout_ = {
    hovermode: 'closest',
    hoverinfo: 'name',
    hoverlabel: {
      namelength: -1,
    },
    showlegend: false,
    xaxis: {
      title: parameters[0],
    },
    yaxis: {
      title: parameters[1],
    },
  }
  console.log(traces)
  return <Plot data={traces} layout={layout_} config={config}/>
}


class TuningExploration extends Component {
  constructor(props) {
    super(props);
    this.state = {
      selected_parameter: null,
      selected_metric: default_metric,
      layout: {
        xaxis: {
          type: 'linear',
        }
      },
    };
  }

  selectParameter = e => {
    this.setState({selected_parameter: e.target.value})
  }
  selectParameter2 = e => {
    this.setState({selected_parameter_2: e.target.value})
  }
  selectMetric = e => {
    this.setState({selected_metric: e.target.value})
  }
  updateXScale = e => {
    const toogleScale = scale => scale === 'log' ? 'linear' : 'log';
    this.setState((previousState, newProps) => ({
      layout: {
        ...previousState.layout,
        xaxis: {
          ...previousState.layout.xaxis,
          type: toogleScale(previousState.layout.xaxis.type),
        }
      }
    }))
  }

  render() {
    const { batch } = this.props;
    const { layout } = this.state;
    if (!batch) return <p>Loading...</p>
    if (batch.label==='default')
      return <Callout intent={Intent.PRIMARY}>First select a tuning experiment</Callout>

    // tuned_parameters holds all tuning values used for each parameter
    let tuned_parameters = {};
    Object.entries(batch.slam_outputs).forEach( ([id, o]) =>{
      Object.entries(o.extra_parameters).forEach( ([param,value]) => {
        if (tuned_parameters[param]===undefined)
          tuned_parameters[param] = new Set()
        tuned_parameters[param].add(value)
      })
    })
    // we sort tuned parameters by the number of different values that were used
    let sorted_parameters = Object.entries(tuned_parameters)
                                  .sort( ([p1,s1],[p2,s2]) => s2.size-s1.size )
                                  .map( ([k,v])=>k )
    let default_selected_parameter = sorted_parameters[0];
    let default_selected_parameter_2 = sorted_parameters.length>1 ? sorted_parameters[1] : default_selected_parameter;
    let selected_parameter = this.state.selected_parameter || default_selected_parameter;
    let selected_parameter_2 = this.state.selected_parameter_2 || default_selected_parameter_2;

    // what metric are we looking at?
    let metric = slam_metrics[this.state.selected_metric];

    let show_2d_sensibility = sorted_parameters.length>1 && tuned_parameters[sorted_parameters[1]].size>1;

    let total_slam_runs = Object.keys(batch.slam_outputs).length;
    let number_recordings = Object.keys(groupBy(Object.values(batch.slam_outputs), "recording_path")).length;

    return <Section>
      <h3>{total_slam_runs} SLAM runs over {number_recordings} recordings</h3>
      <h4>Sensibility analysis</h4>
      <FormGroup inline labelFor="select-parameter" helperText="Shown on the X-axis">
        <div className="pt-select pt-minimal">
          <select id='select-parameter' defaultValue={default_selected_parameter} onChange={this.selectParameter}>
            {sorted_parameters.map( p => <option key={p} value={p}>{p} ({tuned_parameters[p].size} different{tuned_parameters[p].size>1 ? 's':''})</option>)}
          </select>
        </div>
        <Switch inline label='Log-scale' checked={this.state.layout.xaxis.type==='log'} onChange={this.updateXScale}></Switch>
      </FormGroup>
      {show_2d_sensibility && <FormGroup inline labelFor="select-parameter-2" helperText="Shown on the Y-axis in the 2D sensibility plot">
              <div className="pt-select pt-minimal">
                <select id='select-parameter-2' defaultValue={default_selected_parameter_2} onChange={this.selectParameter2}>
                  {sorted_parameters.map( p => <option key={p} value={p}>{p} ({tuned_parameters[p].size} different{tuned_parameters[p].size>1 ? 's':''})</option>)}
                </select>
              </div>
      </FormGroup>}
      <FormGroup inline labelFor="select-metric" helperText="Shown on the Y-axis">
        <div className="pt-select pt-minimal">
          <select id='select-metric' defaultValue={default_metric} onChange={this.selectMetric}>
            {Object.values(slam_metrics).map( m => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </div>
      </FormGroup>
      {show_2d_sensibility && <div>
        <p>Everything is interpolated, so don't rush to conclusions.</p>
        <Sensibility2DContour slam_outputs={batch.slam_outputs} metric={metric} parameters={[selected_parameter, selected_parameter_2]} />
      </div>}
      <Sensibility1DBoxplots slam_outputs={batch.slam_outputs} metric={metric} parameter={selected_parameter} layout={layout}/>
      <h4>Breakdown by recording</h4>
      <Sensibility1DLines slam_outputs={batch.slam_outputs} metric={metric} parameter={selected_parameter} layout={layout}/>
    </Section>
  }
}


export { TuningExploration };
