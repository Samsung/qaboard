/* global Plotly:true */
// import Plot from 'react-plotly.js'
import React, { Component } from "react";

import createPlotlyComponent from 'react-plotly.js/factory'
import { Colors, FormGroup } from "@blueprintjs/core";
import { slam_metrics, default_metric } from "./slam/metrics";

const Plot = createPlotlyComponent(Plotly);
let layout = {
  width: 1200,
  height: 150,
  margin: { // will eat into the drawing area
      l: 40,
      r: 30,
      b: 40,
      t: 0,
      pad:0
  },
  autosize: false,
  yaxis: {
    type:'log',
  },
}


const has_all_metrics = (commit, metrics, aggregation) => {
  for (var index in metrics) {
    let metric = metrics[index];
    if (!commit.batches.default.aggregated_metrics[`${metric}_${aggregation}`])
      return false;
  }
  return true;
}


const CommitsEvolution1D = ({ commits, metrics, aggregation }) => {
  let shown_metrics = metrics || [default_metric];
  let shown_aggregation = aggregation || 'average';
  let valid_commits = commits.filter( c => !!c.batches.default )
                             .filter(c => has_all_metrics(c, metrics, shown_aggregation) )
  let traces = shown_metrics
                .map( key => slam_metrics[key] )
                .map( metric => ({
                  name: metric.label,
                  type: 'scatter',
                  x: valid_commits.map( c => c.authored_datetime ),
                  y: valid_commits
                     .map( c => c.batches.default.aggregated_metrics[`${metric.key}_${shown_aggregation}`] )
                     .map( value => Math.min(100, value*metric.scale) ),
                  text: valid_commits.map( c => c.message ),
                  marker: {
                    size: 10,
                    color: Colors.BLUE2,
                  },
                  line: {
                    width: 2,
                    color: Colors.BLUE3,
                  },
                }),
              );
  return <Plot data={traces} layout={layout}/>
}


class CommitsEvolution extends Component {
  constructor(props) {
    super(props);
    this.state = {
      selected_metric: default_metric,
      selected_aggregation: 'average',
    };
  }

  selectMetric = e => {
    this.setState({selected_metric: e.target.value})
  }
  selectAggregation = e => {
    this.setState({selected_aggregation: e.target.value})
  }
  render() {
    const { commits, style } = this.props;
    const { selected_metric, selected_aggregation } = this.state;
    return <div style={style}>
      <FormGroup inline>
        <div className="pt-select pt-minimal">
          <select id='select-metric' defaultValue={default_metric} onChange={this.selectMetric}>
            {Object.values(slam_metrics).map( m => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </div>
        <div className="pt-select pt-minimal">
          <select id='select-aggregation' defaultValue='average' onChange={this.selectAggregation}>
            <option key='average' value='average'>average</option>
            <option key='median' value='median'>median</option>
          </select>
        </div>
      </FormGroup>
      <CommitsEvolution1D commits={commits} metrics={[selected_metric]} aggregation={selected_aggregation} />
    </div>
  }
}

export { CommitsEvolution };
