import React, { Component, Fragment } from "react";
import { withRouter } from "react-router";
import qs from "qs";

import Plot from 'react-plotly.js';
import {
  Classes,
  HTMLSelect,
  Tag,
  Colors,
  Intent,
  FormGroup,
  Switch
} from "@blueprintjs/core";

import { updateSelected } from "./actions/selected";

import { OutputCard } from "./viewers/OutputCard";
import { controls_defaults, updateQueryUrl } from "./viewers/controls";
import { BitAccuracyForm } from "./viewers/bit_accuracy/utils";
import { is_image } from "./viewers/images/utils"
import { hash_color, match_query, average, median } from "./utils";

import CommitRow from "./components/CommitRow";

import { Toaster } from "@blueprintjs/core";
export const toaster = Toaster.create();

let default_layout = {
  width: 1200,
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


const has_all_metrics = (commit, batch_label, metrics, aggregation) => {
  if (commit.batches[batch_label] === undefined)
    return false
  for (var index in metrics) {
    let metric = metrics[index];
    let metric_value = commit.batches[batch_label].aggregated_metrics[`${metric}_${aggregation}`];
    if (metric_value === undefined && metric_value === null)
      return false;
  }
  return true;
};


const make_output_filter = output_filter => {
  const matcher = match_query(output_filter)
  return o => {
    if (o.is_pending) return false;
    if (output_filter.length === 0) return true;
    let metadata_s = Object.keys(o.test_input_metadata).length > 0 ? JSON.stringify(o.test_input_metadata) : "";
    let metadata = metadata_s.replace(/"/g, "")
    let searched = `${o.test_input_path} ${o.platform} ${metadata} ${o.configuration}`;
    return matcher(searched)
  };
};


const update_output_counts_in_batches = (commit, output_filter) => {
  Object.keys(commit.batches).forEach(label => {
    let outputs = commit.batches[label].outputs || {}
    commit.batches[label].failed_outputs = 0;
    commit.batches[label].valid_outputs = 0;
    commit.batches[label].pending_outputs = 0;
    let filtered_outputs = {}
    Object.entries(outputs).forEach( ([key, output]) => {
      if (output_filter(output)) {
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



class CommitsEvolutionPerTest extends React.Component {
  constructor(props) {
    super(props);
    const project_qatools_config = ((props.project_data || {}).data || {}).qatools_config;
    this.state = {
      layout: {},
      traces: [],
      // metadata to link hover events to the corresponding batch/commit
      traces_metadata: [],

      hovered_label: null,
      hovered_commit: undefined,
      hovered_commit_ref: undefined,
      selected_ref: false,
      // when displaying per-input data 
      hovered_test_input_path: "",
      hovered_test_configuration: "",

      controls: controls_defaults(project_qatools_config),
    };
  }

  onHover = e => {
    let point_number = e.points[0].pointNumber;
    let curve_number = e.points[0].curveNumber;
    // when not doing per-input display, test_input_path and configuration will be undefined 
    let { label, test_input_path, configuration, commits } = this.state.traces_metadata[curve_number];
    let hovered_commit_ref = point_number < commits.length ? commits[point_number + 1] : null;
    const hovered_commit = commits[point_number]
    if (!!this.props.aggregation && this.props.per_output_granularity && this.props.output_filter.length>0) {
      const output_filter_ = make_output_filter(this.props.output_filter);
      update_output_counts_in_batches(hovered_commit, output_filter_)
      update_output_counts_in_batches(hovered_commit_ref, output_filter_)
    }
    this.props.dispatch(updateSelected(this.props.project, {
      new_commit_id: hovered_commit.id,
      ...((!this.state.selected_ref && !!hovered_commit_ref) ? {ref_commit_id: hovered_commit_ref.id}: {}),
    }))
    this.setState({
      hovered_test_input_path: test_input_path,
      hovered_test_configuration: configuration,
      hovered_label: label,
      hovered_commit,
      ...((!this.state.selected_ref && !!hovered_commit_ref) ? {hovered_commit_ref}: {}),
    }, () => this.updateLayout(this.props));
  };


  onDoubleClick = e => {
    this.setState({selected_ref: false})
  }
  onClick = e => {
    const curve_number = e.points[0].curveNumber
    let point_number = e.points[0].pointNumber;
    // when not doing per-input display, test_input_path and configuration will be undefined 
    let { label, test_input_path, configuration, commits } = this.state.traces_metadata[curve_number];
    let hovered_commit = commits[point_number];
    this.props.dispatch(updateSelected(this.props.project, {
      ref_commit_id: hovered_commit.id,
      new_commit_id: hovered_commit.id,
    }))
    this.setState({
      selected_ref: true,
      hovered_test_input_path: test_input_path,
      hovered_test_configuration: configuration,
      hovered_label: label,
      hovered_commit,
      hovered_commit_ref: hovered_commit,
    }, () => this.updateLayout(this.props));
  }

  componentDidMount() {
    this.updateTraces(this.props);
    this.updateLayout(this.props);
  }

  componentDidUpdate(prevProps) {
    if (
      prevProps.commits !== this.props.commits ||
      prevProps.new_commit !== this.props.new_commit ||
      prevProps.ref_commit !== this.props.ref_commit ||
      prevProps.output_filter !== this.props.output_filter ||
      prevProps.metrics[0] !== this.props.metrics[0] ||
      prevProps.relative !== this.props.relative
    ) {
      this.updateTraces(this.props);
      this.updateLayout(this.props);
    }

    const new_controls = ((((this.props.project_data || {}).data || {}).qatools_config || {}).outputs || {}).controls;
    const old_controls = ((((prevProps.project_data || {}).data || {}).qatools_config || {}).outputs || {}).controls;
    if (old_controls !== new_controls) {
      const project_qatools_config = ((this.props.project_data || {}).data || {}).qatools_config;
      this.setState({controls: controls_defaults(project_qatools_config)});
    }
  }


  updateTracesPerBatch(props) {
    const { commits, metrics, aggregation, available_metrics, per_output_granularity, output_filter } = props;
    let shown_metrics = metrics;
    let shown_aggregation = aggregation || "median";

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

    // TODO: remove outliers
    let traces = [];
    let traces_metadata = [];

    const output_filter_ = per_output_granularity ? make_output_filter(output_filter) : null;
    shown_metrics.forEach(key => {
      let metric = available_metrics[key];
      this.props.shown_batches.forEach(label => {
        const commits_with_batch  = per_output_granularity
          ? commits.filter(c => !!c.batches[label])
          : commits.filter(c => has_all_metrics(c, label, metrics, shown_aggregation));
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
                  .map(c => Object.values(c.batches[label].outputs || {})
                                  .filter(output_filter_)
                  )
                  .map(outputs => outputs.map(o=> o.metrics[metric.key]) )
                  .map(values => aggregation_func(values) )
          }

          // clamp ouliers
          y = y.map(x =>
                    x === undefined || x === null || isNaN(x)
                      ? null
                      : (!!metric.target && x < 20 * metric.target) ? x * metric.scale : 20 * metric.target * metric.scale
          )
          let trace = {
            name: `${name[label]} ${
              shown_metrics.length > 1 ? metric.label : ""
            }`,
            type: "scatter",
            mode: "lines+markers",
            x: commits_with_batch.map(c => c.authored_datetime),
            y: y,
            text: commits_with_batch.map(c => c.message),
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
    });
  }

  updateTraces(props) {
    if (!!this.props.aggregation)
      return this.updateTracesPerBatch(props);
    const {
      commits,
      metrics,
      available_metrics,
      output_filter,
      relative
    } = props;
    const output_filter_ = make_output_filter(output_filter);
    let shown_metrics = metrics;
    let traces = [];
    let traces_metadata = [];

    // console.log("shown_metrics", shown_metrics)
    shown_metrics.forEach(key => {
      let metric = available_metrics[key];
      this.props.shown_batches.forEach(label => {
        let commits_with_batch = commits.filter(c => !!c.batches[label]);
        if (commits_with_batch.length > 0) {
          let input_configuration_set = new Set();
          commits_with_batch.forEach(c => {
            Object.values(c.batches[label].outputs || {})
              .filter(output_filter_)
              .forEach(o => input_configuration_set.add(JSON.stringify([o.test_input_path, o.configuration])));
          });
          // console.log("commits_with_batch", commits_with_batch)
          // console.log(input_configuration_set)
          input_configuration_set.forEach( input_config_json => {
            const [test_input_path, configuration] = JSON.parse(input_config_json)
            let commits_with_output = commits_with_batch.filter(
              c =>
                (Object.values(c.batches[label].outputs || {})
                  .filter(o => o.test_input_path === test_input_path && o.configuration === configuration)
                  .filter(output_filter_)
                  .map(o => o.metrics[metric.key])
                  .filter(m => !(isNaN(m) || m === null || m === undefined))
                  .length > 0)
            );
            // console.log("commits_with_output", commits_with_output)
            let values = commits_with_output
              .map(
                c =>
                  Object.values(c.batches[label].outputs || {})
                    .filter(o => o.test_input_path === test_input_path && o.configuration === configuration)
                    .filter(output_filter_)
                    .filter(o => this.props.project !== 'dvs/psp_swip' || o.configuration.includes("stereo"))
              )
              .filter(outputs => outputs.length > 0)
              .map(outputs => outputs[0].metrics)
              .map(metrics => metrics[metric.key] * metric.scale)
              // if target>0...
              //  Math.min(
              //    100 * metric.target * metric.scale,
              //    metrics[metric.key] * metric.scale
              //  )
              //);
            // console.log(test_input_path, '@', configuration, values)
            const y0 = values[values.length - 1];
            const y = (relative && !!y0) ? values.map(v => 100 * v / y0) : values;

            let color = hash_color(test_input_path, label);
            let trace = {
              name: `${test_input_path} @${configuration}`,
              type: "scatter",
              mode: "lines+markers",
              x: commits_with_output.map(c => c.authored_datetime),
              y,
              // opacity: 0.8,
              marker: {
                size: 7,
                color,
                opacity: 0.95
              },
              line: {
                width: 3,
                color,
                dash: label === "default" ? "solid" : "dot",
                opacity: 0.5
              },
              legendgroup: test_input_path,
              showlegend: false,
              connectgap: true
            };
            let trace_metadata = {
              test_input_path,
              configuration,
              label,
              commits: commits_with_output
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
    });
  }

  updateLayout = props => {
    const {
      available_metrics={},
      metrics=[],
      aggregation,
      relative,
      new_commit,
      ref_commit,
    } = props;
    const {
      hovered_commit=new_commit,
      hovered_commit_ref=ref_commit,
    } = this.state;

    let metric = available_metrics[metrics[0]];
    let threshold = metric.target * metric.scale;
    let layout = {
      ...default_layout,
      ...this.state.layout, // save eg the zoom
      height: !!aggregation ? 150 : 250,
      shapes: [],
    };
    layout.yaxis.ticksuffix = metric.suffix || '';
    layout.yaxis.showticksuffix = 'last';
    layout.yaxis.type = metric.plot_scale || 'log'
    if (!relative && !!threshold)
      layout.shapes.push({
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
      })
    if (!!hovered_commit) {
      layout.shapes.push({
          type: "line",
          layer: "below",
          xref: "x",
          x0: hovered_commit.authored_datetime,
          x1: hovered_commit.authored_datetime,
          yref: "paper",
          y0: 0,
          y1: 1,
          line: {
            color: "rgba(217, 130, 43, 0.5)",
            width: 3,
            dash: "dashdot"
          }
        })
    }
    if (!!hovered_commit_ref) {
      layout.shapes.push({
          type: "line",
          layer: "below",
          xref: "x",
          x0: hovered_commit_ref.authored_datetime,
          x1: hovered_commit_ref.authored_datetime,
          yref: "paper",
          y0: 0,
          y1: 1,
          line: {
            color: "rgba(19, 124, 189, 0.5)",
            width: 3,
            dash: "dashdot"
          }
        })
    }
    this.setState({
      layout,
    })
  }


  toggle = name => () => {
    const controls = {
      ...this.state.controls,
      [name]: !this.state.controls[name],      
    }
    this.setState({controls}, updateQueryUrl(this.props.history, controls));
  }

  toggle_show = name => () => {
    const controls = {
        ...this.state.controls,
        show: {
          ...this.state.controls.show,          
          [name]: !this.state.controls.show[name],
        }
    }
    this.setState({controls}, updateQueryUrl(this.props.history, controls));
  }


  render() {
    const {
      project,
      project_data,
      show_bit_accuracy,
      aggregation,
      new_commit,
      ref_commit,
    } = this.props;
    const {
      traces,
      layout,
      hovered_test_input_path,
      hovered_test_configuration,
      hovered_label,
      hovered_commit=new_commit,
      hovered_commit_ref=ref_commit,
    } = this.state;

    if (!!hovered_commit) {
      let hovered_commit_outputs = Object.values((hovered_commit.batches[hovered_label] || {}).outputs || {})
      let hovered_output = hovered_commit_outputs.filter(o => o.test_input_path === hovered_test_input_path && o.configuration === hovered_test_configuration)[0];
      let should_look_for_ref = !!hovered_output &&  !!hovered_commit_ref && !!hovered_commit_ref.batches[hovered_label]
      let { reference_id, reference_warning } = should_look_for_ref ? hovered_output : {}
      let output_ref = should_look_for_ref ? (((hovered_commit_ref || {}).batches[hovered_label] || {}).outputs || {})[reference_id] : null
      let controls_extra = project_data.data.qatools_config.outputs.controls || []
      let visualizations = project_data.data.qatools_config.outputs.visualizations || project_data.data.qatools_config.outputs.detailed_views || []
      let maybe_diff = visualizations.some(v => is_image(v)) && <Switch
          key='diff'
          intent={Intent.WARNING}
          checked={this.state.controls.diff || false}
          onChange={this.toggle('diff')}
          labelElement={<strong>Image Diff</strong>}
          innerLabel="off"
          innerLabelChecked="on"
        />
      let controls = <>
        {!show_bit_accuracy && visualizations.map( (view, idx) => {
          if (!view.default_hidden ||
              this.state.controls.show === undefined || this.state.controls.show === null ||
              this.state.controls.show[view.name] === undefined || this.state.controls.show[view.name] === null)
            return <React.Fragment key={idx}></React.Fragment>
          return <Switch
                  style={{marginRight: "8px"}}
                  key={idx}
                  checked={this.state.controls.show[view.name]}
                  onChange={this.toggle_show(view.name)}
                  label={view.label || view.name || view.path}
                 />
        })}
        {maybe_diff}
        {controls_extra.map(control => {
          return <Switch
                  style={{marginRight: "8px"}}
                  key={control.name}
                  checked={this.state.controls[control.name]}
                  onChange={this.toggle(control.name)}
                  label={control.label || control.name}
                 />
        })}
      </>

      var legend = <div style={{ marginTop: "30px", background: "#fefefe", padding: "10px" }}>
        {hovered_test_input_path && <Tag style={{ background: hash_color(hovered_test_input_path) }}>
            {hovered_test_input_path} @{hovered_test_configuration}
        </Tag>}
        {(!!hovered_label && hovered_label !== "default") && <Tag style={{ marginLeft: "15px" }}>{hovered_label}</Tag>}
        <CommitRow
          commit={hovered_commit}
          project={this.props.project}
          project_data={project_data}
          toaster={toaster}
          tag={<Tag style={{marginRight: '8px'}} intent={Intent.WARNING}>New</Tag>}
        />
        {!!hovered_commit_ref && <div><CommitRow
                    commit={hovered_commit_ref}
                    project={this.props.project}
                    project_data={project_data}
                    toaster={toaster}
                    tag={<Tag style={{marginRight: '8px'}} intent={Intent.PRIMARY}>Reference</Tag>}
        /></div>}
        <div style={{display: 'flex', flex: '0 0 auto'}}>{controls}</div>
        {!!hovered_output && <OutputCard
                    project={project}
                    project_data={project_data}
                    commit={hovered_commit}
                    output_new={hovered_output}
                    output_ref={output_ref}
                    warning={reference_warning}
                    style={{ width: '1180px', height: '300px' }}
                    no_header={true}
                    dispatch={this.props.dispatch}
                    type={show_bit_accuracy ? 'bit_accuracy' : undefined}
                    show_all_files={this.props.show_all_files}
                    expand_all={this.props.expand_all}
                    files_filter={this.props.files_filter}
                    controls={this.state.controls}
        />}
      </div>;
    }

    // console.log(traces)
    // console.log(revision)
    return (
      <div>
        {traces.length > 0 && (
          <Plot
            data={traces}
            layout={layout}
            onHover={this.onHover}
            onClick={this.onClick}
            onDoubleClick={this.onDoubleClick}
            /* https://github.com/plotly/react-plotly.js#state-management */
            onInitialized={({layout}) => this.setState(layout)}
            onUpdate={({layout}) => this.setState(layout)} 
          />
        )}
        <p className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>
          {!!aggregation 
            ? <span>The performance for each commit may not be evaluated on the same tests</span>
            : <span>Hover over a run to see {show_bit_accuracy
                                             ? `the files it created `
                                             : `a visualization of its outputs `}
                  compared to the previous commit. Click on a commit to freeze it as a reference.</span>
          }
        </p>
        {legend}
      </div>
    );
  }
}

class CommitsEvolution extends Component {
  constructor(props) {
    super(props);
    const params = new URLSearchParams(window.location.search);
    const { main_metrics, default_metric} = ((this.props.project_data || {}).data || {}).qatools_metrics || {};
    this.state = {
      select_metrics: this.props.select_metrics || main_metrics || [],
      selected_metric: params.get("selected_metric") || default_metric,
      selected_aggregation: params.get("selected_aggregation") || "median",

      breakdown_per_test: params.get("breakdown_per_test") === 'true' || this.props.default_breakdown_per_test,
      relative: params.get("relative")==='true' || this.props.default_breakdown_per_test !== true,
      show_bit_accuracy: params.get("show_bit_accuracy")==='true',

      // file viewer controls
      show_all_files: params.get("show_all_files") === 'true' || false,
      expand_all: params.get("expand_all") === 'true' || false,
      files_filter: params.get("files_filter") || '',

      // keep pan-zoom settings
      layout: {},
    };
  }

  update = (attribute, attribute_url) => e => {
    const value = (e.target && e.target.value !==undefined) ? e.target.value : e;
    let query = qs.parse(window.location.search.substring(1));
    this.setState({[attribute]: value,})
    this.props.history.push({
      pathname: window.location.pathname,
      search: qs.stringify({
        ...query,
        [attribute_url || attribute]: value,
      })
    });
  }
  toggle = name => e => {
    this.setState({ [name]: !this.state[name] });
    let query = qs.parse(window.location.search.substring(1));
    this.props.history.push({
      pathname: window.location.pathname,
      search: qs.stringify({
        ...query,
        [name]: !this.state[name],
      })
    });

  }

  render() {
    const { project, project_data, commits, new_commit, ref_commit, style, default_breakdown_per_test, output_filter, per_output_granularity } = this.props;
    const offer_breakdown_per_test = default_breakdown_per_test !== undefined && default_breakdown_per_test !== null;
    const {
      selected_metric,
      selected_aggregation,
      breakdown_per_test,
      relative,
      show_bit_accuracy,
    } = this.state;
    const { select_metrics } = this.state;

    const { available_metrics={}, default_metric} = ((this.props.project_data || {}).data || {}).qatools_metrics || {};

    if (!default_metric)
      return <div>To see metrics over time, <a href={process.env.REACT_APP_QABOARD_DOCS_ROOT}>define your project's metrics</a>.</div>;

    return (
      <div style={style}>
        <FormGroup inline>
          <HTMLSelect
            id="select-metric"
            defaultValue={default_metric}
            onChange={this.update("selected_metric")}
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
              defaultValue={selected_aggregation}
              onChange={this.update("selected_aggregation")}
              minimal
            >
              <option key="median" value="median">median</option>
              <option key="average" value="average">average</option>
            </HTMLSelect>
          )}
          {offer_breakdown_per_test && (
            <Switch
              inline
              label="Breakdown per test"
              defaultChecked={breakdown_per_test}
              onChange={this.toggle("breakdown_per_test")}
            />
          )}
          {offer_breakdown_per_test &&
            breakdown_per_test && (
              <Fragment>
                <Switch
                  inline
                  label="Relative to start (@100)"
                  checked={relative}
                  onChange={this.toggle("relative")}
                />
                <Switch
                  inline
                  label="Show output files"
                  checked={show_bit_accuracy}
                  onChange={this.toggle("show_bit_accuracy")}
                />
              </Fragment>
            )}
        </FormGroup>
        <CommitsEvolutionPerTest
            project={project}
            project_data={project_data}
            commits={commits}
            new_commit={new_commit}
            ref_commit={ref_commit}
            shown_batches={this.props.shown_batches || ['default']}
            metrics={[selected_metric]}
            output_filter={output_filter}
            aggregation={breakdown_per_test ? null : selected_aggregation}
            per_output_granularity={per_output_granularity}
            relative={this.state.relative}
            show_bit_accuracy={show_bit_accuracy}
            available_metrics={available_metrics}
            history={this.props.history}
            show_all_files={this.state.show_all_files}
            expand_all={this.state.expand_all}
            files_filter={this.state.files_filter}
            dispatch={this.props.dispatch}
        />
        {show_bit_accuracy && <BitAccuracyForm
                                     show_all_files={this.state.show_all_files}
                                     expand_all={this.state.expand_all}
                                     files_filter={this.state.files_filter}
                                     toggle={this.toggle}
                                     update={this.update}
        />}
      </div>
    );
  }
}



export default withRouter(CommitsEvolution );
