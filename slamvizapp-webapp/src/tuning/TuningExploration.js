/* global Plotly:true */
// import Plot from 'react-plotly.js'
import React, { Component } from "react";
import createPlotlyComponent from 'react-plotly.js/factory'
import { Callout, Colors, Intent, FormGroup, Switch } from "@blueprintjs/core";

import { Section } from "../common/containers";
import { groupBy } from "../common/utils";
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
                            color: Colors.ORANGE4,
                            opacity: 0.8,
                          },
                          line: {
                            width: 1,
                            color: Colors.ORANGE5,
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

const Sensibility2DContour = ({ slam_outputs, metric, parameters, layout }) => {
  // https://plot.ly/javascript/reference/#contour
  // https://plot.ly/javascript/contour-plots/
  // todo: aggregate median/mean per recording..
  let slam_outputs_ok = Object.values(slam_outputs).filter( o => !o.is_pending && !o.is_failed);
  let traces = [{
    type: 'contour',
    x: slam_outputs_ok.map(o => o.extra_parameters[parameters[0]]),
    y: slam_outputs_ok.map(o => o.extra_parameters[parameters[1]]),
    // a matrix???/
    z: slam_outputs_ok.map(o => o.metrics[metric.key] * metric.scale),
    contours: {
      coloring: 'heatmap', // apply a gradient within each contour
      showlabels: true,
      labelfont: {
        size: 8,
        color: '#ffffff',
      }
    },
    zsmooth: 'best',
    // connectgaps: false,
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

    // what parameters were changed?
    let tuned_parameters = new Set()
    Object.entries(batch.slam_outputs).forEach( ([id, o]) =>{
      Object.keys(o.extra_parameters).forEach( p => {
        tuned_parameters.add(p)
      })
    })
    let tuned_parameters_array = Array.from(tuned_parameters)
    let default_selected_parameter = tuned_parameters_array[0];
    let default_selected_parameter_2 = tuned_parameters_array.length>1 ? tuned_parameters_array[1] : default_selected_parameter;
    let selected_parameter = this.state.selected_parameter || default_selected_parameter;
    let selected_parameter_2 = this.state.selected_parameter_2 || default_selected_parameter_2;

    // what metric are we looking at?
    let metric = slam_metrics[this.state.selected_metric];


    let total_slam_runs = Object.keys(batch.slam_outputs).length;
    let number_recordings = Object.keys(groupBy(Object.values(batch.slam_outputs), "recording_path")).length;

    return <Section>
      <h3>{total_slam_runs} SLAM runs over {number_recordings} recordings</h3>
      <h4>Sensibility analysis</h4>
      <FormGroup inline labelFor="select-parameter" helperText="Shown on the X-axis">
        <div className="pt-select pt-minimal">
          <select id='select-parameter' defaultValue={default_selected_parameter} onChange={this.selectParameter}>
            {tuned_parameters_array.map( p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <Switch inline label='Log-scale' checked={this.state.layout.xaxis.type==='log'} onChange={this.updateXScale}></Switch>
      </FormGroup>
      {tuned_parameters_array.length>1 && <FormGroup inline labelFor="select-parameter-2" helperText="Shown on the Y-axis in the 2D sensibility plot">
              <div className="pt-select pt-minimal">
                <select id='select-parameter-2' defaultValue={default_selected_parameter_2} onChange={this.selectParameter2}>
                  {tuned_parameters_array.map( p => <option key={p} value={p}>{p}</option>)}
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
      {tuned_parameters_array.length > 1 && <div>
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
