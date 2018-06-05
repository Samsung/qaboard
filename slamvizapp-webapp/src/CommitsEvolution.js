/* global Plotly:true */
// import Plot from 'react-plotly.js'
import React, { Component } from "react";

import createPlotlyComponent from 'react-plotly.js/factory'
import { Tag, Colors, FormGroup, Switch, Intent, InputGroup } from "@blueprintjs/core";
import { slam_metrics, main_metrics, default_metric } from "./slam/metrics";

import { CommitRow } from "./CommitRow";

import { Toaster } from "@blueprintjs/core";
export const toaster = Toaster.create();


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


// const CommitsEvolution1D = ({ commits, metrics, aggregation }) => {
//   let shown_metrics = metrics || [default_metric];
//   let shown_aggregation = aggregation || 'median';
//   let valid_commits = commits.filter( c => !!c.batches.default )
//                              .filter(c => has_all_metrics(c, metrics, shown_aggregation) )

//   let traces = shown_metrics
//                 .map( key => slam_metrics[key] )
//                 .map( metric => ({
//                   name: metric.label,
//                   type: 'scatter',
//                   x: valid_commits.map( c => c.authored_datetime ),
//                   y: valid_commits
//                      .map( c => c.batches.default.aggregated_metrics[`${metric.key}_${shown_aggregation}`] )
//                      .map( value => Math.min(100, value*metric.scale) ),
//                   text: valid_commits.map( c => c.message ),
//                   marker: {
//                     size: 10,
//                     color: Colors.BLUE2,
//                   },
//                   line: {
//                     width: 2,
//                     color: Colors.BLUE3,
//                   },
//                 }),
//               );
//   return <Plot data={traces} layout={layout}/>
// }

class CommitsEvolutionPerBatch extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      revision: 0,
      traces: [],
      // metadata to link hover events to the corresponding batch/commit
      traces_metadata: [],
      // date_to_commit: {},

      hovered: false,
      hovered_test_input_path: '',
      hovered_label: null,
      hovered_commit: null,
    }
  }

  onHover = e => {
    let { label, commits } = this.state.traces_metadata[e.points[0].curveNumber];
    let commit = commits[e.points[0].pointNumber];
    this.setState({
      hovered: true,
      hovered_label: label,
      hovered_commit: commit,
    })
  }

  componentDidMount() {
    this.updateTraces(this.props)
  }

  componentWillReceiveProps(nextProps) {
    if (nextProps.commits !== this.props.commits ||
        nextProps.metrics[0] !== this.props.metrics[0] ||
        nextProps.aggregation !== this.props.aggregation
       )
    this.updateTraces(nextProps)
  }

  updateTraces(props) {
    const { commits, metrics, aggregation } = props;
    let shown_metrics = metrics || [default_metric];
    let shown_batches = ['default', 'ci-android-rt']
    let shown_aggregation = aggregation || 'median';
    let valid_commits = commits.filter( c => !!c.batches.default )
                               .filter(c => has_all_metrics(c, metrics, shown_aggregation) )
    let traces = []
    let traces_metadata = []

    shown_metrics.forEach( key => {
      let metric = slam_metrics[key]
      shown_batches.forEach( label => {
        let commits_with_batch = valid_commits.filter(c => c.batches[label]!==undefined)
        if (commits_with_batch.length>0) {
          let trace = {
            name: `${label==='default' ? 'Linux (LSF)' : 'Real-time (Android)'} ${shown_metrics.length>1 ? metric.label : ''}`,
            type: 'scatter',
            x: commits_with_batch.map( c => c.authored_datetime ),
            y: commits_with_batch
               .map( c => c.batches[label].aggregated_metrics[`${metric.key}_${shown_aggregation}`] )
               .map( value => Math.min(100*metric.threshold*metric.scale, value*metric.scale) ),
            // text: valid_commits.map( c => c.message ),
            marker: {
              size: 10,
              color: label==='default' ? Colors.BLUE2 : Colors.ORANGE2,
            },
            line: {
              width: 2,
              color: label==='default' ? Colors.BLUE3 : Colors.ORANGE3,
            },
          }
          let trace_metadata = {
            label,
            commits: commits_with_batch,
          }
          traces.push(trace);
          traces_metadata.push(trace_metadata);
        }
      })
    });
    this.setState({traces, traces_metadata, revision: this.state.revision+1})
  }


  render() {
    const { metrics } = this.props;

    if (this.state.hovered) {
      var legend = <div style={{marginTop: '30px', background: '#fefefe', 'padding': '10px'}}>
        <CommitRow commit={this.state.hovered_commit} project="dvs/psp_swip" toaster={toaster} />
      </div>
    } else {
      legend = <span></span>
    }

    let metric = slam_metrics[metrics[0]];
    let threshold = metric.threshold*metric.scale;
    let layout_ = {
      ...layout,
      shapes: [
          {
            type: 'line',
            layer: 'below',
            xref: 'paper',
            x0: 0,
            x1: 1,
            yref: 'y',
            y0: threshold,
            y1: threshold,
            line: {
              color: 'rgba(150, 150, 150, 0.5)',
              width: 3,
              dash: 'dashdot',
            },
        },
      ],
    }
    return <div>
      <Plot revision={this.state.revision} data={this.state.traces} layout={layout_} onHover={this.onHover}/>
      {legend}
    </div>
  }

}


class CommitsEvolutionPerMovie extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      revision: 0,
      traces: [],
      // metadata to link hover events to the corresponding batch/commit
      traces_metadata: [],

      hovered: false,
      hovered_test_input_path: '',
      hovered_label: null,
      hovered_commit: null,
    }
  }

  onHover = e => {
    let { label, test_input_path, commits } = this.state.traces_metadata[e.points[0].curveNumber];
    let commit = commits[e.points[0].pointNumber];
    this.setState({
      hovered: true,
      hovered_test_input_path: test_input_path,
      hovered_label: label,
      hovered_commit: commit,
    })
  }

  componentDidMount() {
    this.updateTraces(this.props)
  }

  componentWillReceiveProps(nextProps) {
    // if (nextProps.commits !== this.props.commits ||
    //     nextProps.metrics[0] !== this.props.metrics[0] ||
    //     nextProps.filter !== this.props.filter
    //    ) {
      this.updateTraces(nextProps)
    // }
  }

  updateTraces(props) {
    const { commits, metrics, filter } = props;
    let shown_metrics = metrics || [default_metric];
    let shown_batches = ['default', 'ci-android-rt']
    let traces = []
    let traces_metadata = []

    shown_metrics.forEach( key => {
      let metric = slam_metrics[key]
      shown_batches.forEach( label => {
        let commits_with_batch = commits.filter(c => !!c.batches[label])
        if (commits_with_batch.length>0) {
          let input_paths = new Set()
          commits_with_batch.forEach(c => {
            Object.values(c.batches[label].outputs)
                  .map(o => o.test_input_path)
                  .filter(test_input_path => test_input_path.includes(filter))
                  .forEach(new_test_input_path => input_paths.add(new_test_input_path))
          })
          console.log(filter)
          input_paths.forEach( test_input_path => {
            // console.log(test_input_path)
            let commits_with_input = commits_with_batch
                                     .filter(c => Object.values(c.batches[label].outputs)
                                                        .filter(o=>o.test_input_path===test_input_path)
                                                        .filter(o=>o.configuration.includes('stereo'))
                                                        .length>0 )
            let name = test_input_path;
            let trace = {
              name,
              type: 'scatter',
              x: commits_with_input.map( c => c.authored_datetime ),
              y: commits_with_input.map( c => Object.values(c.batches[label].outputs)
                                                    .filter(o => o.test_input_path===test_input_path)
                                                    .filter(o=>o.configuration.includes('stereo'))[0])
                                   .map( o => Math.min(100*metric.threshold*metric.scale, o.metrics[metric.key]*metric.scale) ),
              opacity: 0.8,
              marker: {
                size: 5,
                color: label==='default' ? Colors.BLUE2 : Colors.ORANGE2,
                opacity: 0.8,
              },
              line: {
                width: 2,
                color: label==='default' ? Colors.BLUE3 : Colors.ORANGE3,
                opacity: 0.3,
              },
              legendgroup: test_input_path,
              showlegend: false,
              connectgap: true,
            };
            let trace_metadata = {
              test_input_path,
              label,
              commits: commits_with_input,
            }
            traces.push(trace);
            traces_metadata.push(trace_metadata);
          })
        }
      })
    });
    this.setState({traces, traces_metadata, revision: this.state.revision+1})
  }

  render() {
    const { metrics } = this.props;
    let metric = slam_metrics[metrics[0]];
    let threshold = metric.threshold*metric.scale;
    let layout_ = {
      ...layout,
      height: 500,
      hovermode: 'closest',
      hoverinfo: 'y',
      // showlegend: false,
      legend: {
        "orientation": "h"
      },
      shapes: [
          {
            type: 'line',
            layer: 'below',
            xref: 'paper',
            x0: 0,
            x1: 1,
            yref: 'y',
            y0: threshold,
            y1: threshold,
            line: {
              color: 'rgba(150, 150, 150, 0.5)',
              width: 3,
              dash: 'dashdot',
            },
        },
      ],
    }

    if (this.state.hovered) {
      var legend = <div style={{marginTop: '30px', background: '#fefefe', 'padding': '10px'}}>
        <Tag intent={this.state.hovered_label==='default' ? Intent.PRIMARY : Intent.WARNING}>{this.state.hovered_test_input_path}</Tag>
        <CommitRow commit={this.state.hovered_commit} project="dvs/psp_swip" toaster={toaster} />
      </div>
    } else {
      legend = <span></span>
    }

    return <div>
      <Plot revision={this.state.revision} data={this.state.traces} layout={layout_} onHover={this.onHover}/>
      {legend}
    </div>
  }
}

class CommitsEvolution extends Component {
  constructor(props) {
    super(props);
    this.state = {
      selected_metric: default_metric,
      selected_aggregation: 'median',
      filter: '',
    };
  }

  selectMetric = e => {
    this.setState({selected_metric: e.target.value})
  }
  selectAggregation = e => {
    this.setState({selected_aggregation: e.target.value})
  }

  render() {
    const { project, commits, style, offer_breakdown_per_test } = this.props;
    const { selected_metric, selected_aggregation, breakdown_per_test, filter } = this.state;

    if (project!=='dvs/psp_swip') return <div></div>;

    return <div style={style}>
      <FormGroup inline>
        <div className="pt-select pt-minimal">
          <select id='select-metric' defaultValue={default_metric} onChange={this.selectMetric}>
            {main_metrics.map( m => <option key={slam_metrics[m].key} value={m}>{slam_metrics[m].label}</option>)}
          </select>
        </div>
        <div className="pt-select pt-minimal">
          <select id='select-aggregation' defaultValue={selected_metric} onChange={this.selectAggregation}>
            <option key='median' value='median'>median</option>
            <option key='average' value='average'>average</option>
          </select>
        </div>
        {offer_breakdown_per_test && <Switch inline label='Breakdown per test' defaultChecked={breakdown_per_test} onChange={e => {this.setState({breakdown_per_test: !breakdown_per_test})}}></Switch>}
        {offer_breakdown_per_test && breakdown_per_test && 
          <FormGroup labelFor="filter-input" inline>
            <InputGroup
              value={this.state.filter}
              placeholder="filter by input path"
              onChange={e => this.setState({filter: e.target.value})}
              type="search"
              leftIcon="search"
            />
          </FormGroup>
        }
      </FormGroup>
      {breakdown_per_test ? <CommitsEvolutionPerMovie commits={commits} metrics={[selected_metric]} filter={filter} />
                          : <CommitsEvolutionPerBatch commits={commits} metrics={[selected_metric]} aggregation={selected_aggregation} />
      }
    </div>
  }
}

export { CommitsEvolution };
