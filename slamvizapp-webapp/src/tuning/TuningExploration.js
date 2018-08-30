/* global Plotly:true */
// import Plot from 'react-plotly.js'
import React, { Component, Fragment } from "react";
import createPlotlyComponent from "react-plotly.js/factory";
import { Classes, Callout, Colors, Intent, FormGroup, Switch, HTMLSelect } from "@blueprintjs/core";

import { Section } from "../common/containers";
import { groupBy, input_test_color, median, average } from "../common/utils";
import { metrics } from "../metrics";

const Plot = createPlotlyComponent(Plotly);
const config = {};

const Sensibility1DLines = ({
  outputs,
  metric,
  parameter,
  relative,
  layout
}) => {
  let outputs_by_input = groupBy(Object.values(outputs), "test_input_path");
  let traces = Object.entries(outputs_by_input).map(
    ([test_input_path, outputs_for_input]) => {
      let outputs = outputs_for_input
        .filter(o => !o.is_pending && !o.is_failed)
        .sort(
          (a, b) =>
            a.extra_parameters[parameter] - b.extra_parameters[parameter]
        );
      let color = input_test_color(test_input_path);
      let line = {
        width: 1,
        color,
        opacity: 0.8
      };
      let values = outputs.map(o => o.metrics[metric.key] * metric.scale);
      let v0 = metric.smaller_is_better
        ? Math.min(...values)
        : Math.max(...values);
      let y = relative ? values.map(v => 100 * v / v0) : values;
      return {
        type: "scatter",
        mode: "lines+markers",
        name: test_input_path,
        x: outputs.map(o => o.extra_parameters[parameter]),
        y,
        marker: {
          size: 4,
          color,
          opacity: 0.8,
          line
        },
        line
      };
    }
  );
  const layout_ = {
    hovermode: "closest",
    hoverinfo: "name",
    hoverlabel: {
      namelength: -1
    },
    showlegend: false,
    xaxis: {
      title: parameter
    },
    yaxis: {
      title: metric.label,
      type: "log",
      autotick: false,
      dtick: 0.69897000433,
      exponentformat: "SI",
      showgrid: false,
      zeroline: false,
      gridcolor: "rgb(255, 255, 255)",
      gridwidth: 1
    },
    ...layout,
    // eslint-disable-next-line
    xaxis: {
      ...layout.axis,
      title: parameter,
    },
  };
  return <Plot data={traces} layout={layout_} config={config} />;
};

const Sensibility1DBoxplots = ({ outputs, metric, parameter, layout }) => {
  let outputs_values = Object.values(outputs).map(o => ({
    ...o,
    extra_parameter: o.extra_parameters[parameter]
  }));
  let outputs_by_param = groupBy(outputs_values, "extra_parameter");
  let traces = Object.entries(outputs_by_param).map(
    ([param_value, outputs_for_input]) => {
      let outputs = outputs_for_input.filter(
        o => !o.is_pending && !o.is_failed
      );
      return {
        type: "box",
        name: param_value,
        x: outputs.map(o => o.extra_parameters[parameter]),
        y: outputs.map(o => o.metrics[metric.key] * metric.scale),
        boxmean: true,
        marker: {
          color: Colors.ORANGE3
        }
      };
    }
  );
  const layout_ = {
    hovermode: "closest",
    boxgap: 0,
    boxgroupgap: 0,
    showlegend: false,
    yaxis: {
      title: metric.label,
      type: "log",
      autotick: false,
      dtick: 0.69897000433,
      exponentformat: "SI",
      showgrid: false,
      zeroline: false,
      gridcolor: "rgb(255, 255, 255)",
      gridwidth: 1
    },
    ...layout,
    xaxis: {
      ...layout.axis,
      title: parameter,
    },
  };
  return <Plot data={traces} layout={layout_} config={config} />;
};

// SensibilityScatterMatrix
// type: 'splom', // Scatter PLOt Matrix
// diagonal: {visible: true},
// showUpperHalf: false,
// showLowerHalf: true,
// dimensions: parameters.map(p => ({
//   label: p,
//   values: outputs.map(o => o.metrics[metric.key] * metric.scale),
// })),

const ParallelTuningPlot = ({
  outputs,
  metrics,
  main_metric,
  parameters,
  aggregation,
}) => {
  let outputs_ok = Object.values(outputs).filter(
    o => !o.is_pending && !o.is_failed
  );

  // first we group outputs by all their tuning / extra parameters
  // this avoid giving more weights to tunings that ran on more tests
  let outputs_by_params = new Map();
  outputs_ok.forEach(output => {
    let key = JSON.stringify(output.extra_parameters);
    let outputs_with_same_params = outputs_by_params.get(key) || [];
    outputs_with_same_params.push(output);
    outputs_by_params.set(key, outputs_with_same_params);
  })

  // we aggregate
  let metrics_aggregated_by_params = Array.from(outputs_by_params.entries()).map(
    ([extra_parameters_s, outputs]) => {
      let aggregated_metrics = {}
      metrics.forEach(m => {
        let values = outputs
          .map(o => o.metrics[m.key])
          .filter(x => x !== undefined);
        let aggregated_value = aggregation==='median' ? median(values) : average(values);
        if (aggregated_value !== null)
          aggregated_metrics[m.key] = aggregated_value;
      });
      return [JSON.parse(extra_parameters_s), aggregated_metrics];
    }
  )

  let main_metric_values = metrics_aggregated_by_params.map( ([params, agg_metrics]) => agg_metrics[main_metric.key] * main_metric.scale)
  let traces = [{
    type: 'parcoords',
    line: {
      color: main_metric_values,
      colorscale: 'Viridis',
      showscale: true,
      reversescale: main_metric.smaller_is_better,
      colorbar: {
        title: main_metric.label,
        thickness: 20, // default: 30
        outlinewidth: 0,
        borderwidth: 0,
        ticksuffix: main_metric.suffix || '',
        showticksuffix: 'last',
      },
    },
    dimensions: [
      ...metrics.map( metric => {
        return {
          label: metric.label,
          values: metrics_aggregated_by_params.map( ([params, agg_metrics]) => agg_metrics[metric.key] * metric.scale),
          // range: [1, 5],
          // constraintrange: [1, 2],
        }
      }),
      ...parameters.map(p => {
        let values = metrics_aggregated_by_params.map( ([params, agg_metrics]) => params[p])
        let numeric = values.every(v => !isNaN(parseFloat(v)) && isFinite(v));
        let integer = values.every(v => Number.isInteger(v));
        // console.log(p, 'int:', integer, 'num:', numeric)
        // console.log(values)
        if (!numeric) {
          // we need to remap the values to categorical integers values
          var remapped_values = new Array(values.length);
          var unique_values = new Map(...[undefined, 0]);
          values.forEach( (v, idx) => {
            if (!unique_values.get(v))
              unique_values.set(v, unique_values.size+1)
            remapped_values[idx] = unique_values.get(v)
          })
        }
        // console.log(unique_values)
        let dimension = {
          values: numeric ? values : remapped_values,
          integer,
          label: p,
        }
        if (!numeric) {
          // TODO: try to differentiate the lines going to the same points...
          //       the best would be using splines, like Google Vizier
          //       adding a bit of jitter could also work
          //         https://github.com/plotly/plotly.js/issues/2229
          //         https://github.com/plotly/plotly.js/issues/2229
          dimension.tickvals = Array.from(unique_values.values());
          dimension.ticktext = Array.from(unique_values.keys()).map(k=> k===undefined ? '<no-tuning>' : k);
          dimension.integer = true;    
        }
        // console.log(dimension)
        // TODO: hover
        //       https://github.com/plotly/dash-core-components/issues/157
        return dimension;
      })
    ]
  }]
  // console.log(traces)
  let layout = {
    width: 500+100*parameters.length,
    autosize: false,
  }
  return <Plot layout={layout} data={traces} config={config} />;
}

const EfficientFrontierPlot = ({
  outputs,
  metric_x,
  metric_y,
  available_metrics,
  aggregation,
}) => {
  let outputs_ok = Object.values(outputs).filter(
    o => !o.is_pending && !o.is_failed
  );

  // first we group outputs by all their tuning / extra parameters
  // this avoid giving more weights to tunings that ran on more tests
  let outputs_by_params = new Map();
  outputs_ok.forEach(output => {
    let key = JSON.stringify(output.extra_parameters);
    let outputs_with_same_params = outputs_by_params.get(key) || [];
    outputs_with_same_params.push(output);
    outputs_by_params.set(key, outputs_with_same_params);
  })
  // we aggregate
  let metrics_aggregated_by_params = Array.from(outputs_by_params.entries()).map(
    ([extra_parameters_s, outputs]) => {
      let aggregated_metrics = {}
      Object.values(available_metrics).forEach(m => {
        let values = outputs
          .map(o => o.metrics[m.key])
          .filter(x => x !== undefined);
        aggregated_metrics[m.key] = aggregation==='median' ? median(values) : average(values);
      });
      return [extra_parameters_s, aggregated_metrics];
    }
  )

  let traces = [{
    type: 'scatter',
    mode: 'markers',
    marker: { size: 12 },
    x: metrics_aggregated_by_params.map( ([extra_parameters_s, aggregated_metrics]) => aggregated_metrics[metric_x.key]),
    y: metrics_aggregated_by_params.map( ([extra_parameters_s, aggregated_metrics]) => aggregated_metrics[metric_y.key]),
    text: metrics_aggregated_by_params.map( ([extra_parameters_s, aggregated_metrics]) => extra_parameters_s),
  }];

  let layout_ = {
    xaxis: {
      title: metric_x.label,
      ticksuffix: metric_x.suffix || '',
      showticksuffix: 'last',
    },
    yaxis: {
      title: metric_y.label,
      ticksuffix: metric_y.suffix || '',
      showticksuffix: 'last',
    },
  };
  return <Plot data={traces} layout={layout_} config={config} />;
}



const Sensibility2DContour = ({
  outputs,
  metric,
  parameters,
  layout,
  available_metrics,
  aggregation,
}) => {
  // https://plot.ly/javascript/reference/#contour
  // https://plot.ly/javascript/contour-plots/
  let outputs_ok = Object.values(outputs).filter(
    o => !o.is_pending && !o.is_failed
  );

  // first we group outputs by all their tuning / extra parameters
  // this avoid giving more weights to tunings that ran on more tests
  let outputs_by_params = new Map();
  outputs_ok.forEach(output => {
    let key = JSON.stringify(output.extra_parameters);
    let outputs_with_same_params = outputs_by_params.get(key) || [];
    outputs_with_same_params.push(output);
    outputs_by_params.set(key, outputs_with_same_params);
  })
  // we aggregate
  let metrics_aggregated_by_params = Array.from(outputs_by_params.entries()).map(
    ([extra_parameters_s, outputs]) => {
      let aggregated_metrics = {}
      Object.values(available_metrics).forEach(m => {
        let values = outputs
          .map(o => o.metrics[m.key])
          .filter(x => x !== undefined);
        aggregated_metrics[m.key] = aggregation==='median' ? median(values) : average(values);
      });
      return [extra_parameters_s, aggregated_metrics];
    }
  )

  // then we focus on the variables that are interesting to us
  let metrics_aggregated_by_shown_params = new Map();
  metrics_aggregated_by_params.forEach(([extra_parameters_s, metrics]) => {
    let extra_parameters = JSON.parse(extra_parameters_s);
    let shown_params = {
      [parameters[0]]: extra_parameters[parameters[0]],
      [parameters[1]]: extra_parameters[parameters[1]],
    }
    let key = JSON.stringify(shown_params);
    let outputs_with_same_params = metrics_aggregated_by_shown_params.get(key) || [];
    outputs_with_same_params.push(metrics);
    metrics_aggregated_by_shown_params.set(key, outputs_with_same_params);
  })

  // and re-aggregate
  let metrics_by_shown_params_aggregated = Array.from(metrics_aggregated_by_shown_params.entries()).map(
    ([extra_parameters_s, metrics]) => {
      let aggregated_metrics = {}
      Object.values(available_metrics).forEach(m => {
        let values = metrics.map(metric => metric[m.key])
        let aggregated_value = aggregation==='median' ? median(values) : average(values);
        if (aggregated_value !== null)
          aggregated_metrics[m.key] = aggregated_value;
      });
      return [JSON.parse(extra_parameters_s), aggregated_metrics];
    }
  )


  let traces = [
    {
      type: "contour",
      x: metrics_by_shown_params_aggregated.map(([p,m]) => p[parameters[0]]),
      y: metrics_by_shown_params_aggregated.map(([p,m]) => p[parameters[1]]),
      z: metrics_by_shown_params_aggregated.map(([p,m]) => m[metric.key] * metric.scale),
      contours: {
        coloring: "heatmap", // apply a gradient within each contour
        showlabels: true,
        labelfont: {
          size: 8,
          color: "#ffffff"
        }
      },
      // zsmooth: 'best',// default
      connectgaps: false,
      colorscale: "Viridis"
      // reversescale: true,
      // showscale: false,
    }
  ];
  const layout_ = {
    hovermode: "closest",
    hoverinfo: "name",
    hoverlabel: {
      namelength: -1
    },
    showlegend: false,
    xaxis: {
      title: parameters[0]
    },
    yaxis: {
      title: parameters[1]
    }
  };
  return <Plot data={traces} layout={layout_} config={config} />;
};

class TuningExploration extends Component {
  constructor(props) {
    super(props);
    const project = props.project || "dvs/psp_swip";
    this.state = {
      selected_parameter: null,
      available_metrics: metrics[project].available_metrics,
      main_metrics: metrics[project].main_metrics,
      selected_metric: metrics[project].default_metric,
      selected_metric2: metrics[project].main_metrics.filter(l=>l!==metrics[project].default_metric)[0],
      relative: true,
      aggregation: 'median',
      layout: {
        xaxis: {
          type: "linear"
        }
      }
    };
  }

  selectParameter = e => {
    this.setState({ selected_parameter: e.target.value });
  };
  selectParameter2 = e => {
    this.setState({ selected_parameter_2: e.target.value });
  };
  selectMetric = e => {
    this.setState({ selected_metric: e.target.value });
  };
  selectMetric2 = e => {
    this.setState({ selected_metric2: e.target.value });
  };
  updateXScale = e => {
    const toogleScale = scale => (scale === "log" ? "linear" : "log");
    this.setState((previousState, newProps) => ({
      layout: {
        ...previousState.layout,
        xaxis: {
          ...previousState.layout.xaxis,
          type: toogleScale(previousState.layout.xaxis.type)
        }
      }
    }));
  };

  render() {
    const { batch, project } = this.props;
    const { layout, relative, available_metrics, main_metrics, aggregation } = this.state;
    if (!batch) return <p>Loading...</p>;
    if (batch.label === "default")
      return (
        <Callout intent={Intent.PRIMARY}>
          First select a tuning experiment
        </Callout>
      );

    // tuned_parameters holds all tuning values used for each parameter
    let tuned_parameters = {};
    Object.entries(batch.outputs).forEach(([id, o]) => {
      Object.entries(o.extra_parameters).forEach(([param, value]) => {
        if (tuned_parameters[param] === undefined)
          tuned_parameters[param] = new Set();
        tuned_parameters[param].add(value);
      });
    });
    // we sort tuned parameters by the number of different values that were used
    let sorted_parameters = Object.entries(tuned_parameters)
      .sort(([p1, s1], [p2, s2]) => s2.size - s1.size)
      .map(([k, v]) => k);
    let default_selected_parameter = sorted_parameters[0];
    let default_selected_parameter_2 =
      sorted_parameters.length > 1
        ? sorted_parameters[1]
        : default_selected_parameter;
    let selected_parameter =
      this.state.selected_parameter || default_selected_parameter;
    let selected_parameter_2 =
      this.state.selected_parameter_2 || default_selected_parameter_2;

    // what metric are we looking at?
    let metric = available_metrics[this.state.selected_metric];
    let metric2 = available_metrics[this.state.selected_metric2];

    let show_2d_sensibility =
      sorted_parameters.length > 1 &&
      tuned_parameters[sorted_parameters[1]].size > 1;

    let total_outputs = Object.keys(batch.outputs).length;
    let number_inputs = Object.keys(
      groupBy(Object.values(batch.outputs), "test_input_path")
    ).length;

    return (
      <Section>
        <h3 className={Classes.HEADING}>
          {total_outputs} SLAM results over {number_inputs} recordings
        </h3>
        <h4 className={Classes.HEADING}>Sensibility analysis</h4>
        <FormGroup
          inline
          labelFor="select-parameter"
          helperText="Shown on the X-axis"
        >
          <HTMLSelect
            id="select-parameter"
            defaultValue={default_selected_parameter}
            onChange={this.selectParameter}
            minimal
          >
            {sorted_parameters.map(p => (
              <option key={p} value={p}>
                {p} ({tuned_parameters[p].size} different{tuned_parameters[p]
                  .size > 1
                  ? "s"
                  : ""})
              </option>
            ))}
          </HTMLSelect>
          <Switch
            inline
            label="Log-scale"
            checked={this.state.layout.xaxis.type === "log"}
            onChange={this.updateXScale}
          />
        </FormGroup>
        {show_2d_sensibility && (
          <Fragment>
          <FormGroup
            inline
            labelFor="select-parameter-2"
            helperText="Shown on the Y-axis in the 2D sensibility plot"
          >
            <HTMLSelect
              id="select-parameter-2"
              defaultValue={default_selected_parameter_2}
              onChange={this.selectParameter2}
              minimal
            >
              {sorted_parameters.map(p => (
                <option key={p} value={p}>
                  {p} ({tuned_parameters[p].size} different{tuned_parameters[
                    p
                  ].size > 1
                    ? "s"
                    : ""})
                </option>
              ))}
            </HTMLSelect>
          </FormGroup>
          <FormGroup
            inline
            labelFor="aggregation"
            helperText="Aggregation method"
          >
            <HTMLSelect
              id="aggregation"
              defaultValue={aggregation}
              onChange={e =>this.setState({aggregation: e.target.value})}
              minimal
            >
              <option key="median" value="median">median</option>
              <option key="average" value="average">average</option>
            </HTMLSelect>
          </FormGroup>
          </Fragment>
        )}
        <FormGroup
          inline
          labelFor="select-metric"
          helperText={show_2d_sensibility ? "Shown via a color-scale on the 2d sensibility plot, on the Y-axis elsewhere" : "Shown on the Y-axis"}
        >
          <HTMLSelect
            id="select-metric"
            defaultValue={metrics[project].default_metric}
            onChange={this.selectMetric}
            minimal
          >
            {Object.values(available_metrics).map(m => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </HTMLSelect>
        </FormGroup>
        {show_2d_sensibility && <ParallelTuningPlot
                                 outputs={batch.outputs}
                                 main_metric={metric}
                                 metrics={main_metrics.map(m => available_metrics[m])}
                                 parameters={sorted_parameters}
                                 aggregation={this.state.aggregation}
                                />}
        {show_2d_sensibility && (
          <div>
            <Sensibility2DContour
              outputs={batch.outputs}
              metric={metric}
              available_metrics={available_metrics}
              parameters={[selected_parameter, selected_parameter_2]}
              aggregation={this.state.aggregation}
            />
            <div className={Classes.TEXT_MUTED} style={{ fontSize: 10 }}>
            <p><span style={{borderBottom: '1px dashed #999', textDecoration: 'none'}} title={`${aggregation} over all selected inputs`}>Aggregated scores</span> are computed for each set of tuning parameters.</p>
            <p>Those having the same values for <em>{selected_parameter}</em> and <em>{selected_parameter_2}</em> are themselves <span style={{borderBottom: '1px dashed #999', textDecoration: 'none'}} title={aggregation}>aggregated</span>.</p>
            </div>
          </div>
        )}
        <Sensibility1DBoxplots
          outputs={batch.outputs}
          metric={metric}
          available_metrics={available_metrics}
          parameter={selected_parameter}
          layout={layout}
        />
        <h4 className={Classes.HEADING}>Breakdown by test</h4>
        <Switch
          label="Relative"
          defaultChecked={relative}
          onChange={e => {
            this.setState({ relative: !relative });
          }}
        />
        <Sensibility1DLines
          outputs={batch.outputs}
          metric={metric}
          available_metrics={available_metrics}
          parameter={selected_parameter}
          relative={relative}
          layout={layout}
        />

        {show_2d_sensibility &&<Fragment>
        <h4 className={Classes.HEADING}>Tuning tradeoffs</h4>
        <FormGroup
          inline
          labelFor="select-metric-2"
          helperText="Metric on Y-axis"
        >
          <HTMLSelect
            id="select-metric-2"
            defaultValue={metrics[project].main_metrics[1] || metrics[project].main_metrics[0]}
            onChange={this.selectMetric2}
            minimal
          >
            {Object.values(available_metrics).map(m => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </HTMLSelect>
        </FormGroup>
        <EfficientFrontierPlot
          outputs={batch.outputs}
          metric_x={metric}
          metric_y={metric2}
          available_metrics={available_metrics}
          aggregation={this.state.aggregation}
        />
        </Fragment>
      }

      </Section>
    );
  }
}

export { TuningExploration };
