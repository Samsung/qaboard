/* global Plotly:true */
// import Plot from 'react-plotly.js'
import React, { Component } from "react";
import createPlotlyComponent from 'react-plotly.js/factory'
import { Callout, Colors, Intent, FormGroup } from "@blueprintjs/core";

import { Section } from "../Common";
import { slam_metrics, default_metric } from "../slam/metrics";
import { groupBy } from "../utils";

const Plot = createPlotlyComponent(Plotly);
const config = {};


const Sensibility1DLines = ({ slam_outputs, metric, parameter }) => {
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
  const layout = {
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
  }
  return <Plot data={traces} layout={layout} config={config}/>
}

const Sensibility1DBoxplots = ({ slam_outputs, metric, parameter }) => {
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
  const layout = {
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
  }
  return <Plot data={traces} layout={layout} config={config}/>
}


class TuningExploration extends Component {
  constructor(props) {
    super(props);
    this.state = {
      selected_parameter: null,
      selected_metric: default_metric,
    };
  }

  selectParameter = e => {
    this.setState({selected_parameter: e.target.value})
  }
  selectMetric = e => {
    this.setState({selected_metric: e.target.value})
  }

  render() {
    const { batch } = this.props;
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
    let selected_parameter = this.state.selected_parameter || default_selected_parameter;

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
      </FormGroup>
      <FormGroup inline labelFor="select-metric" helperText="Shown on the Y-axis">
        <div className="pt-select pt-minimal">
          <select id='select-metric' defaultValue={default_metric} onChange={this.selectMetric}>
            {Object.values(slam_metrics).map( m => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </div>
      </FormGroup>
      <Sensibility1DBoxplots slam_outputs={batch.slam_outputs} metric={metric} parameter={selected_parameter}/>
      <h4>Breakdown by recording</h4>
      <Sensibility1DLines slam_outputs={batch.slam_outputs} metric={metric} parameter={selected_parameter}/>
    </Section>
  }
}


export { TuningExploration };
