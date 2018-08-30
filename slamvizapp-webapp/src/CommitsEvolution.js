import React, { Component, Fragment } from "react";
import Plot from 'react-plotly.js';

import { Classes, HTMLSelect, Tag, Colors, FormGroup, Switch, InputGroup } from "@blueprintjs/core";

import { metrics } from "./metrics";
import { OutputCard } from "./OutputCard";
import { input_test_color, matching_output, average, median } from "./common/utils";

import { CommitRow } from "./CommitRow";

import { Toaster } from "@blueprintjs/core";
export const toaster = Toaster.create();

let layout = {
  width: 1200,
  height: 150,
  margin: {
    // will eat into the drawing area
    l: 40,
    r: 30,
    b: 40,
    t: 0,
    pad: 0
  },
  autosize: false,
  yaxis: {
    showgrid: false,
    showline: false,
    type: "log"
  },
  hovermode: "closest",
  hoverinfo: "y",
  hoverlabel: {
    namelength: -1
  }
  // showlegend: false,
  // legend: {
  //   "orientation": "h"
  // },
};

// const CommitsEvolution1D = ({ commits, metrics, aggregation, available_metrics }) => {
//   let shown_metrics = metrics || [default_metric];
//   let shown_aggregation = aggregation || 'median';
//   let valid_commits = commits.filter( c => !!c.batches.default )
//                              .filter(c => has_all_metrics(c, metrics, shown_aggregation) )

//   let traces = shown_metrics
//                 .map( key => available_metrics[key] )
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

const has_all_metrics = (commit, metrics, aggregation) => {
  for (var index in metrics) {
    let metric = metrics[index];
    if (!commit.batches.default.aggregated_metrics[`${metric}_${aggregation}`])
      return false;
  }
  return true;
};


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
      hovered_test_input_path: "",
      hovered_label: null,
      hovered_commit: null
    };
  }

  onHover = e => {
    let { label, commits } = this.state.traces_metadata[
      e.points[0].curveNumber
    ];
    let commit = commits[e.points[0].pointNumber];
    if (this.props.per_output_granularity && this.props.output_filter.length>0) {
      const output_filter_ = make_output_filter(this.props.output_filter);
      Object.keys(commit.batches).forEach(label => {
        let outputs = commit.batches[label].outputs
        commit.batches[label].failed_outputs = 0;
        commit.batches[label].valid_outputs = 0;
        commit.batches[label].pending_outputs = 0;
        let filtered_outputs = {}
        Object.entries(outputs).forEach( ([key, output]) => {
          if (output_filter_(output)) {
            filtered_outputs[key] = output
            if (output.is_pending) {
              commit.batches[label].pending_outputs += 1
            } else if (output.is_failed) {
              commit.batches[label].failed_outputs += 1;
            } else {
              commit.batches[label].valid_outputs += 1;
            }
          }
        })
        commit.batches[label].outputs = filtered_outputs;
      })
    }
    this.setState({
      hovered: true,
      hovered_label: label,
      hovered_commit: commit
    });
  };

  componentDidMount() {
    this.updateTraces(this.props);
  }

  componentWillReceiveProps(nextProps) {
    if (
      nextProps.output_filter !== this.props.output_filter ||
      nextProps.commits !== this.props.commits ||
      nextProps.metrics[0] !== this.props.metrics[0] ||
      nextProps.aggregation !== this.props.aggregation
    )
      this.updateTraces(nextProps);
  }

  updateTraces(props) {
    const { commits, metrics, aggregation, available_metrics, per_output_granularity, output_filter } = props;
    let shown_metrics = metrics;
    let shown_batches = ["default", "ci-android-rt", "manual-android-rt"];
    let shown_aggregation = aggregation || "median";

    let valid_commits // fixme remove this shit
    if (!per_output_granularity) {
      valid_commits = commits
        .filter(c => !!c.batches.default)
        .filter(c => has_all_metrics(c, metrics, shown_aggregation));      
    } else {
      valid_commits = commits;
    }
    const output_filter_ = per_output_granularity ? make_output_filter(output_filter) : null;

    // TODO: remove outliers
    let traces = [];
    let traces_metadata = [];

    let color_line = {
      default: Colors.BLUE3,
      "ci-android-rt": Colors.ORANGE3,
      "manual-android-rt": Colors.ORANGE4
    };
    let color_marker = {
      default: Colors.BLUE2,
      "ci-android-rt": Colors.ORANGE2,
      "manual-android-rt": Colors.ORANGE3
    };
    let name = {
      default: "Linux (LSF)",
      "ci-android-rt": "Real-time (Android, CI)",
      "manual-android-rt": "Real-time (Android, manual tests)"
    };
    shown_metrics.forEach(key => {
      let metric = available_metrics[key];
      shown_batches.forEach(label => {
        let commits_with_batch = valid_commits.filter(
          c => c.batches[label] !== undefined
        );
        if (commits_with_batch.length > 0) {
          let y;
          if (!per_output_granularity) {
            y = commits_with_batch
                .map(
                  c =>
                    c.batches[label].aggregated_metrics[
                      `${metric.key}_${shown_aggregation}`
                    ]
                )

          } else {
            let aggregation_func = shown_aggregation === 'median' ? median : average;
            y = commits_with_batch
                  .map(c => Object.values(c.batches[label].outputs)
                                  .filter(output_filter_)
                  )
                  .map(outputs => outputs.map(o=> o.metrics[metric.key]) )
                  .map(values => aggregation_func(values) )
          }

          // clamp ouliers
          y = y.map(x =>
                    x === undefined || x === null || isNaN(x)
                      ? null
                      : x < 20 * metric.threshold
                        ? x * metric.scale
                        : 20 * metric.threshold * metric.scale
          )
          let trace = {
            name: `${name[label]} ${
              shown_metrics.length > 1 ? metric.label : ""
            }`,
            type: "scatter",
            mode: "lines+markers",
            x: commits_with_batch.map(c => c.authored_datetime),
            y: y,
            text: valid_commits.map(c => c.message),
            marker: {
              size: 10,
              color: color_marker[label]
            },
            line: {
              width: 2,
              color: color_line[label]
            }
          };
          let trace_metadata = {
            label,
            commits: commits_with_batch
          };
          traces.push(trace);
          traces_metadata.push(trace_metadata);
        }
      });
    });
    this.setState({
      traces,
      traces_metadata,
      revision: this.state.revision + 1
    });
  }

  render() {
    const { metrics, available_metrics } = this.props;
    const { revision, hovered, hovered_commit, traces } = this.state;

    if (hovered) {
      var legend = (
        <div
          style={{ marginTop: "30px", background: "#fefefe", padding: "10px" }}
        >
          <CommitRow
            commit={hovered_commit}
            project={this.props.project}
            toaster={toaster}
          />
        </div>
      );
    } else {
      legend = <span />;
    }

    let metric = available_metrics[metrics[0]];
    let threshold = metric.threshold * metric.scale;
    let layout_ = {
      ...layout,
      shapes: [
        {
          type: "line",
          layer: "below",
          xref: "paper",
          x0: 0,
          x1: 1,
          yref: "y",
          y0: threshold,
          y1: threshold,
          line: {
            color: "rgba(150, 150, 150, 0.5)",
            width: 3,
            dash: "dashdot"
          }
        }
      ]
    };
    layout_.yaxis.ticksuffix = metric.suffix || '';
    layout_.yaxis.showticksuffix = 'last';
    return (
      <div>
        {traces.length > 0 && (
          <Plot
            revision={revision}
            data={traces}
            layout={layout_}
            onHover={this.onHover}
          />
        )}
        <p>
          <span className={Classes.TEXT_MUTED} style={{ fontSize: 10 }}>
            Results are to clamped to >20x KPIs. The performance for each commit
            may not be evaluated on the same tests.
          </span>
        </p>
        {legend}
      </div>
    );
  }
}

const make_output_filter = output_filter => {
  const filter_tokens = output_filter
    .toLowerCase()
    .replace("android", "s8")
    .split(" ");
  return o => {
    if (o.is_pending || o.is_failed) return false;
    if (output_filter.length === 0) return true;
    let searched = `${o.test_input_path} ${o.platform} ${(o.test_input_tags || []).join()} ${
      o.configuration
    }`.toLowerCase();

    let negative_filter_tokens = filter_tokens
      .filter(t => t[0] === "-")
      .map(t => t.substring(1));
    if (negative_filter_tokens.some(token => searched.includes(token)))
      return false;

    let positive_filter_tokens = filter_tokens.filter(t => t[0] !== "-");
    if (positive_filter_tokens.length === 0) return true;
    return positive_filter_tokens.every(token => searched.includes(token));
  };
};

class CommitsEvolutionPerMovie extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      revision: 0,
      traces: [],
      // metadata to link hover events to the corresponding batch/commit
      traces_metadata: [],

      hovered: false,
      hovered_test_input_path: "",
      hovered_label: null,
      hovered_commit: null,
      hovered_commit_ref: null
    };
  }

  onHover = e => {
    let { label, test_input_path, commits } = this.state.traces_metadata[
      e.points[0].curveNumber
    ];
    let point_number = e.points[0].pointNumber;
    this.setState({
      hovered: true,
      hovered_test_input_path: test_input_path,
      hovered_label: label,
      hovered_commit: commits[point_number],
      hovered_commit_ref: point_number > 0 ? commits[point_number - 1] : null
    });
  };

  componentDidMount() {
    this.updateTraces(this.props);
  }

  componentWillReceiveProps(nextProps) {
    if (
      nextProps.commits !== this.props.commits ||
      nextProps.metrics[0] !== this.props.metrics[0] ||
      nextProps.relative !== this.props.relative ||
      nextProps.output_filter !== this.props.output_filter
    )
      this.updateTraces(nextProps);
  }

  updateTraces(props) {
    const {
      commits,
      metrics,
      available_metrics,
      output_filter,
      relative
    } = props;
    const output_filter_ = make_output_filter(output_filter);
    let shown_metrics = metrics;
    let shown_batches = ["default", "ci-android-rt"];
    let traces = [];
    let traces_metadata = [];

    shown_metrics.forEach(key => {
      let metric = available_metrics[key];
      shown_batches.forEach(label => {
        let commits_with_batch = commits.filter(c => !!c.batches[label]);
        if (commits_with_batch.length > 0) {
          let input_paths = new Set();
          commits_with_batch.forEach(c => {
            Object.values(c.batches[label].outputs)
              .filter(output_filter_)
              .forEach(o => input_paths.add(o.test_input_path));
          });
          input_paths.forEach(test_input_path => {
            let commits_with_input = commits_with_batch.filter(
              c =>
                Object.values(c.batches[label].outputs)
                  .filter(o => o.test_input_path === test_input_path)
                  .filter(output_filter_)
                  .filter(o => o.configuration.includes("stereo")).length > 0
            );

            let name = test_input_path;
            let values = commits_with_input
              .map(
                c =>
                  Object.values(c.batches[label].outputs)
                    .filter(o => o.test_input_path === test_input_path)
                    .filter(output_filter_)
                    .filter(o => o.configuration.includes("stereo"))[0]
              )
              .map(o =>
                Math.min(
                  100 * metric.threshold * metric.scale,
                  o.metrics[metric.key] * metric.scale
                )
              );
            const y0 = values[values.length - 1];
            const y = relative ? values.map(v => 100 * v / y0) : values;

            // ? compute an hash of the path -> 0-1, boom
            // interpolateRainbow(0->1)
            // same for symbols / line style
            let color = input_test_color(test_input_path, label);
            let trace = {
              name,
              type: "scatter",
              mode: "lines+markers",
              x: commits_with_input.map(c => c.authored_datetime),
              y,
              opacity: 0.8,
              marker: {
                size: 5,
                color,
                opacity: 0.8
              },
              line: {
                width: 2,
                color,
                dash: label === "default" ? "solid" : "dot",
                opacity: 0.3
              },
              legendgroup: test_input_path,
              showlegend: false,
              connectgap: true
            };
            let trace_metadata = {
              test_input_path,
              label,
              commits: commits_with_input
            };
            traces.push(trace);
            traces_metadata.push(trace_metadata);
          });
        }
      });
    });
    this.setState({
      traces,
      traces_metadata,
      revision: this.state.revision + 1
    });
  }

  render() {
    const {
      metrics,
      available_metrics,
      relative,
      details_on_hover
    } = this.props;
    const {
      revision,
      traces,
      hovered_test_input_path,
      hovered_label,
      hovered_commit,
      hovered_commit_ref
    } = this.state;
    let metric = available_metrics[metrics[0]];
    let threshold = metric.threshold * metric.scale;
    let layout_ = {
      ...layout,
      height: 250
    };
    layout_.yaxis.ticksuffix = metric.suffix || '';
    layout_.yaxis.showticksuffix = 'last';

    if (!relative)
      layout_.shapes = [
        {
          type: "line",
          layer: "below",
          xref: "paper",
          x0: 0,
          x1: 1,
          yref: "y",
          y0: threshold,
          y1: threshold,
          line: {
            color: "rgba(150, 150, 150, 0.5)",
            width: 3,
            dash: "dashdot"
          }
        }
      ];

    if (this.state.hovered) {
      let hovered_output = Object.values(
        hovered_commit.batches[hovered_label].outputs
      ).filter(o => o.test_input_path === hovered_test_input_path)[0];
      if (
        details_on_hover &&
        !!hovered_commit_ref &&
        !!hovered_commit_ref.batches[hovered_label]
      ) {
        var { output_ref, warning } = matching_output({
          output: hovered_output,
          batch: hovered_commit_ref.batches[hovered_label]
        });
      }

      var legend = (
        <div
          style={{ marginTop: "30px", background: "#fefefe", padding: "10px" }}
        >
          <Tag
            style={{ background: input_test_color(hovered_test_input_path) }}
          >
            {hovered_test_input_path}
          </Tag>
          <Tag style={{ marginLeft: "15px" }}>
            {hovered_label === "default" ? "LSF" : "Android"}
          </Tag>
          <CommitRow
            commit={hovered_commit}
            project={this.props.project}
            toaster={toaster}
          />
          {details_on_hover && (
            <OutputCard
              output_new={hovered_output}
              output_ref={output_ref}
              warning={warning}
              layout={{ width: 1180, height: 300 }}
              no_header={true}
            />
          )}
        </div>
      );
    } else {
      legend = <span />;
    }

    return (
      <div>
        {traces.length > 0 && (
          <Plot
            revision={revision}
            data={traces}
            layout={layout_}
            onHover={this.onHover}
          />
        )}
        {legend}
      </div>
    );
  }
}

class CommitsEvolution extends Component {
  constructor(props) {
    super(props);
    const { project } = props;
    this.state = {
      available_metrics: metrics[project].available_metrics,
      select_metrics: this.props.select_metrics || metrics[project].main_metrics,
      selected_metric: metrics[project].default_metric,
      selected_aggregation: "median",
      output_filter: "small-scale",
      relative: true,
      details_on_hover: false
    };
  }

  selectMetric = e => {
    this.setState({ selected_metric: e.target.value });
  };
  selectAggregation = e => {
    this.setState({ selected_aggregation: e.target.value });
  };

  render() {
    const { project, commits, style, offer_breakdown_per_test, per_output_granularity } = this.props;
    const {
      selected_metric,
      selected_aggregation,
      breakdown_per_test,
      output_filter,
      relative,
      details_on_hover
    } = this.state;
    const { available_metrics, select_metrics } = this.state;

    if (!metrics[project].default_metric)
      return <div>To see metrics over time, define your project's metrics with <a href="http://gitlab-srv/common-infrastructure/qatools/wikis/introduction">qatools</a></div>;

    return (
      <div style={style}>
        <FormGroup inline>
          <HTMLSelect
            id="select-metric"
            defaultValue={metrics[this.state.project].default_metric}
            onChange={this.selectMetric}
            minimal
          >
            {select_metrics.map(m => (
              <option key={available_metrics[m].key} value={m}>
                {available_metrics[m].label}
              </option>
            ))}
          </HTMLSelect>
          {!breakdown_per_test && (
            <HTMLSelect
              id="select-aggregation"
              defaultValue={selected_metric}
              onChange={this.selectAggregation}
              minimal
            >
              <option key="median" value="median">
                median
              </option>
              <option key="average" value="average">
                average
              </option>
            </HTMLSelect>
          )}
          {offer_breakdown_per_test && (
            <Switch
              inline
              label="Breakdown per test"
              defaultChecked={breakdown_per_test}
              onChange={e => {
                this.setState({ breakdown_per_test: !breakdown_per_test });
              }}
            />
          )}
          {offer_breakdown_per_test &&
            breakdown_per_test && (
              <Fragment>
                <Switch
                  inline
                  label="Relative"
                  defaultChecked={relative}
                  onChange={e => {
                    this.setState({ relative: !relative });
                  }}
                />
                <Switch
                  inline
                  label="Show 6dof"
                  defaultChecked={details_on_hover}
                  onChange={e => {
                    this.setState({ details_on_hover: !details_on_hover });
                  }}
                />
              </Fragment>
            )}
          { (per_output_granularity || (offer_breakdown_per_test && breakdown_per_test)) &&
              <FormGroup labelFor="filter-input" inline>
                <InputGroup
                  value={output_filter}
                  placeholder="filter by input path, tag, configuration..."
                  onChange={e =>
                    this.setState({ output_filter: e.target.value })
                  }
                  type="search"
                  leftIcon="search"
                />
              </FormGroup>}
        </FormGroup>
        {breakdown_per_test ? (
          <CommitsEvolutionPerMovie
            project={project}
            commits={commits}
            metrics={[selected_metric]}
            output_filter={output_filter}
            relative={this.state.relative}
            details_on_hover={details_on_hover}
            available_metrics={available_metrics}
          />
        ) : (
          <CommitsEvolutionPerBatch
            project={project}
            commits={commits}
            metrics={[selected_metric]}
            output_filter={output_filter}
            aggregation={selected_aggregation}
            available_metrics={available_metrics}
            per_output_granularity={per_output_granularity}
          />
        )}
      </div>
    );
  }
}

export { CommitsEvolution };
