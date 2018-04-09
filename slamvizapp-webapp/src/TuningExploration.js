/* global Plotly:true */
// import Plot from 'react-plotly.js'
import React, { Component } from "react";
import createPlotlyComponent from 'react-plotly.js/factory'
import { Callout, Colors, Intent, FormGroup } from "@blueprintjs/core";

import { Section } from "./Common";
import { available_metrics } from "./Metrics";
import { groupBy } from "./utils";
const Plot = createPlotlyComponent(Plotly);


class TuningExploration extends Component {
  constructor(props) {
    super(props);
    this.state = {
      selected_parameter: null,
      selected_metric: 'translation_aape',
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
    let metric = available_metrics[this.state.selected_metric];

    let slam_outputs_by_recording = groupBy(Object.values(batch.slam_outputs), "recording_path");
    let traces = Object.entries(slam_outputs_by_recording)
                       .map( ([recording_path, slam_outputs_for_recording]) => {
                          let slam_outputs = slam_outputs_for_recording
                                             .filter( o => !o.is_pending && !o.is_failed)
                                             .sort( (a,b) => a.extra_parameters[selected_parameter] - b.extra_parameters[selected_parameter])
                          return {
                            type: 'scatter',
                            name: recording_path,
                            x: slam_outputs.map(o => o.extra_parameters[selected_parameter]),
                            y: slam_outputs.map(o => o[metric.key] * metric.scale),
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
    console.log(traces)

    const layout = {
      hovermode: 'closest',
      showlegend: false,
      xaxis: {
        title: selected_parameter,
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

    // label="Sensibility analysis of parameter"
    // label="Metric of interest" 
    return <Section>
      <FormGroup inline labelFor="select-parameter" helperText="Shown on the X-axis">
        <div className="pt-select pt-minimal">
          <select id='select-parameter' defaultValue={default_selected_parameter} onChange={this.selectParameter}>
            {tuned_parameters_array.map( p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      </FormGroup>
      <FormGroup inline labelFor="select-metric" helperText="Shown on the Y-axis">
        <div className="pt-select pt-minimal">
          <select id='select-metric' defaultValue='translation_aape' onChange={this.selectMetric}>
            {Object.values(available_metrics).map( m => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </div>
      </FormGroup>
      <Plot data={traces} layout={layout} config={{displayModeBar:false}}/>
    </Section>
  }
}


export { TuningExploration };
