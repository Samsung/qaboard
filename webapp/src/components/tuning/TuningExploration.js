import React, { Component, Fragment, useReducer, useState, useEffect } from "react";
import { withRouter } from "react-router";
import qs from "qs";
import { get as _get } from "lodash";

import Plot from 'react-plotly.js';
import { Classes, Callout, Colors, Intent, Tag, FormGroup, Switch, HTMLSelect } from "@blueprintjs/core";

import { Section } from "../../components/layout";
import { groupBy, groupByObject, hash_color, median, average } from "../../utils";
import { OutputTags } from "../tags";
import { main_metrics } from "../../viewers/tof/metrics";

// to test selectable metrics...
// http://alginfra1:6001/CIS_ISP_Algorithms/approximate_computing/sircapproxlib/commit/dd68070ad59b72b00d242959fb235eed8e9ee495?reference=81055b515c71cd3c3557c49ca8e889e7b0028eb4&selected_views=optimization&sort_by=miter.threshold_%25&sort_order=1&selected_parameter=miter.threshold_%25&selected_metric=fitness_last&aggregation=average&selected_parameter_2=resources.evolve_limit_value&selected_metric2=fitness_last&filter=&selected_metrics%5B0%5D=fitness_init&selected_metrics%5B1%5D=fitness_last&selected_metrics%5B2%5D=fitness_improvement&selected_metrics%5B3%5D=wce_%25_actual&selected_metrics%5B4%5D=wce_%25_goal&selected_metrics%5B5%5D=wce_%25_actual_diff_goal&selected_metrics%5B6%5D=no_generations&selected_metrics%5B7%5D=average_generation_runtime

const config = {
  displayModeBar: true,
  showLink: true,
  plotlyServerURL: "https://chart-studio.plotly.com",
  showSendToCloud: true,
};

const metric_formatter = new Intl.NumberFormat("en-US", {
  style: "decimal",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const optimization_metrics = {
  iteration: {
    key: "iteration",
    label: "Iteration",
    short_label: "iter",
    scale: 1,
    suffix: "",
    target: -1,
    smaller_is_better: false,
    plot_scale: "linear"
  },
  objective: {
    key: "objective",
    label: "Objective",
    short_label: "objective",
    scale: 1,
    suffix: "",
    target: -1,
    smaller_is_better: true,
  },      
}



const Sensibility1DLines = ({
  outputs,
  metric,
  parameter,
  relative,
  layout
}) => {
  Object.keys(outputs).forEach(id => {
    const output = outputs[id]
    output.input_configurations = {test_input_path: output.test_input_path, configurations: output.configurations}
  })
  let outputs_by_input_config = groupByObject(Object.values(outputs), "input_configurations");

  let traces = Object.entries(outputs_by_input_config).map(
    ([input_path_config,  outputs_for_input]) => {
      const { test_input_path, configurations } =  JSON.parse(input_path_config)
      let outputs = outputs_for_input
        .filter(o => !o.is_pending && !o.is_failed)
        .sort(
          (a, b) =>
            _get(a.params, parameter) ?? - _get(b.params, parameter)
        );
      let color = hash_color(test_input_path);
      let line = {
        color,
        width: 2,
        opacity: 0.8,
      };
      let values = outputs.map(o => o.metrics[metric.key] * metric.scale).filter(x => !isNaN(x));
      let v0 = metric.smaller_is_better
        ? Math.min(...values)
        : Math.max(...values);
      let y = relative ? values.map(v => 100 * v / v0) : values;
      let configurations_str = JSON.stringify(configurations);
      return {
        type: "scatter",
        mode: "lines+markers",
        name: `${test_input_path} ${configurations_str}`,
        x: outputs.map(o => _get(o.params, parameter)),
        y,
        text: outputs.map(o => `${configurations_str}<br />${JSON.stringify(o.params).replace(/,/g, '<br />')}`),
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
    hoverlabel: {
      namelength: -1
    },
    hovertemplate: 'name',
    showlegend: false,
    xaxis: {
      title: parameter
    },
    yaxis: {
      title: metric.label,
      // This would create a nice log scale
      // autotick: false,
      // type: "log",
      // dtick: 0.69897000433,
      // exponentformat: "SI",
      showgrid: false,
      // zeroline: false,
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

const Sensibility1DBoxplots = React.memo(({ outputs, metric, parameter, layout }) => {
  let outputs_values = Object.values(outputs).map(o => ({
    ...o,
    extra_parameter: _get(o.params, parameter)
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
        x: outputs.map(o => _get(o.params, parameter)),
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
  const all_positive = traces.every(t => t.y.every(v => v > 0))
  if (all_positive) {
    layout_.yaxis =  {
      ...layout_.yaxis,
      type: "log",
      autotick: false,
      dtick: 0.69897000433,
      exponentformat: "SI",
    }
  }
  return <Plot data={traces} layout={layout_} config={config} />;
});

// SensibilityScatterMatrix
// type: 'splom', // Scatter PLOt Matrix
// diagonal: {visible: true},
// showUpperHalf: false,
// showLowerHalf: true,
// dimensions: parameters.map(p => ({
//   label: p,
//   values: outputs.map(o => o.metrics[metric.key] * metric.scale),
// })),

const plotly_state_init = {data: [], layout: {}, frames: [], config: {}}
const plotly_state_reducer = (state, action) => {
  return {
    ...state,
    ...action
  }
}


const ParallelTuningPlot = ({
  outputs,
  metrics,
  main_metric,
  parameters,
  aggregation,
}) => {
  // console.log("[parallel] metrics", metrics)
  // console.log(outputs_ok)

  // const [revision, setRevision] = useState(0);
  // let traces, layout
  // const [traces, setTraces] = useState([]);
  // const [layout, setLayout] = useState({});

  // useEffect(() => {
    // console.log("[Parallel] UPDATE")
    let outputs_ok = Object.values(outputs).filter(
      o => !o.is_pending && !o.is_failed
    );
      // first we group outputs by all their tuning / extra parameters
    // this avoid giving more weights to tunings that ran on more tests
    let outputs_by_params = new Map();
    outputs_ok.forEach(output => {
      let key = JSON.stringify(output.params);
      let outputs_with_same_params = outputs_by_params.get(key) || [];
      outputs_with_same_params.push(output);
      outputs_by_params.set(key, outputs_with_same_params);
    })
    // console.log(outputs_by_params)

    // we aggregate
    let metrics_aggregated_by_params = Array.from(outputs_by_params.entries()).map(
      ([extra_parameters_s, outputs]) => {
        let aggregated_metrics = {}
        metrics.forEach(m => {
          let values = outputs
            .map(o => o.metrics[m.key])
            .filter(x => !isNaN(x));
          let aggregated_value = aggregation==='median' ? median(values) : average(values);
          if (aggregated_value !== null && !isNaN(aggregated_value) )
            aggregated_metrics[m.key] = aggregated_value;
          else
            aggregated_metrics[m.key] = NaN;
        });
        return [JSON.parse(extra_parameters_s), aggregated_metrics];
      }
    )
    // console.log(metrics_aggregated_by_params)

    const values = metric => aggr => aggr.map(  ([p, m]) => m[metric.key] * metric.scale);
    const all_good = values => values.every( v => !isNaN(v) && v!==null && v!==undefined)
    const some_different = values => new Set(values).size > 1
    const line = {
      color: values(main_metric)(metrics_aggregated_by_params),
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
    }

    const metrics_with_different_values = metrics
      .filter( m => all_good(values(m)(metrics_aggregated_by_params)) )
      .filter( m => some_different(values(m)(metrics_aggregated_by_params)) )
    const parameters_with_different_values = parameters.filter(p => some_different(metrics_aggregated_by_params.map( ([params, agg_metrics]) => _get(params, p))) );
    let traces = [{
      type: 'parcoords',
      line: all_good(line.color) ? line : undefined,
      dimensions: [
        ...metrics_with_different_values
          .map( metric => {
              return {
              label: metric.short_label ?? metric.label ?? metric.key,
              values: values(metric)(metrics_aggregated_by_params),
              // range: [1, 5],
              // constraintrange: [1, 2],
              }
        }),
        ...parameters_with_different_values.map(p => {
          let values = metrics_aggregated_by_params.map( ([params, agg_metrics]) => _get(params, p))
          let numeric = values.every(v => !isNaN(parseFloat(v)) && isFinite(v));
          let integer = values.every(v => Number.isInteger(v));
          // console.log(p, 'int:', integer, 'num:', numeric)
          // console.log(values)
          if (!numeric) {
            // we need to remap the values to categorical integers values
            var remapped_values = new Array(values.length);
            var unique_values = new Map(...[undefined, 0]);
            values.forEach( (v, idx) => {
              let v_s = JSON.stringify(v)
              // if (v === false) v = 'false'
              // if (v === true) v = 'true'
              if (!unique_values.get(v_s))
                unique_values.set(v_s, unique_values.size+1)
              remapped_values[idx] = unique_values.get(v_s)
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
    // console.log(metrics_with_different_values)
    // console.log(parameters_with_different_values)
    const sum_length = array => array.map(e => e.length).reduce( (a,b) => a+b, 0)
    const max_length = array => array.map(e => e.length).reduce( (a,b) => Math.max(a, b), 0)
    const sum_chars = sum_length(metrics_with_different_values.map(m=>(m.short_label ?? m.label ?? m.key))) + sum_length(parameters_with_different_values)
    const columns = metrics_with_different_values.length + parameters_with_different_values.length
    const max_col_length = max_length(metrics_with_different_values.map(m=>(m.short_label ?? m.label ?? m.key))) + max_length(parameters_with_different_values)
    // console.log("columns", columns, "sum_chars", sum_chars, "max_col_length", max_col_length)
    const width = Math.max(4 * max_col_length * columns, 840)
    // console.log(width)
    // console.log(traces)
    let layout = {
      // width: Math.max(5 *columns, 840),
      width,
      autosize: false,
    }
    // console.log(layout.width)
    // setTraces(traces)
    // setLayout(layout)
    // setRevision(revision+1)
    // dispatch({layout})
  // }, [outputs, metrics, main_metric, parameters, aggregation]);

  // const [plotly_state, dispatch] = useReducer(plotly_state_reducer, {
  //   // data: traces,
  //   layout,
  //   config,
  //   frames: [],
  // });
  return <Plot
    data={traces}
    layout={layout}
    // revision={revision}
    config={config}
    // config={plotly_state.config}
    // onInitialized={figure => dispatch(figure)}
    // onUpdate={figure => dispatch(figure)}
  />;
  // return <Plot layout={layout} data={traces} config={config} />;
}

const EfficientFrontierPlot = React.memo(({
  outputs,
  metric_x,
  metric_y,
  available_metrics,
  aggregation,
  parameter,
}) => {
  let outputs_ok = Object.values(outputs).filter(
    o => !o.is_pending && !o.is_failed
  );

  // first we group outputs by all their tuning / extra parameters
  // this avoid giving more weights to tunings that ran on more tests
  let outputs_by_params = new Map();
  outputs_ok.forEach(output => {
    let key = JSON.stringify(output.params);
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
          .filter(x => !isNaN(x));
        aggregated_metrics[m.key] = aggregation==='median' ? median(values) : average(values);
      });
      return [extra_parameters_s, aggregated_metrics];
    }
  )

  let color = metrics_aggregated_by_params.map( ([extra_parameters_s, aggregated_metrics]) => JSON.parse(extra_parameters_s)[parameter])
  let traces = [{
    type: 'scatter',
    mode: 'markers',
    marker: {
      size: 12,
      color,
      colorbar: {
        title: parameter,
      },
      colorscale: 'RdBu',
    },
    x: metrics_aggregated_by_params.map( ([extra_parameters_s, aggregated_metrics]) => aggregated_metrics[metric_x.key]),
    y: metrics_aggregated_by_params.map( ([extra_parameters_s, aggregated_metrics]) => aggregated_metrics[metric_y.key]),
    text: metrics_aggregated_by_params.map( ([extra_parameters_s, aggregated_metrics]) => extra_parameters_s.replace(/,/g, '<br />')),
    showscale: true,
  }];

  let layout_ = {
    hovermode: "closest",
    hoverinfo: "name",
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
})



const Sensibility2DContour = React.memo(({
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
    let key = JSON.stringify(output.params);
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
          .filter(x => !isNaN(x));
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
      [parameters[0]]: _get(extra_parameters, parameters[0]),
      [parameters[1]]: _get(extra_parameters, parameters[1]),
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
        let values = metrics.map(metric => metric[m.key]).filter(x => !isNaN(x))
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
      x: metrics_by_shown_params_aggregated.map(([p,m]) => _get(p, parameters[0])),
      y: metrics_by_shown_params_aggregated.map(([p,m]) => _get(p, parameters[1])),
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
});



class TuningExploration extends Component {
  constructor(props) {
    super(props);
    const params = new URLSearchParams(props.location.search);
    this.state = {
      ...this.parameters_data(props),
      selected_metric: params.get("selected_metric"),
      selected_metric2: params.get("selected_metric2"),
      relative: true,
      aggregation: params.get('aggregation') || 'median',
      layout: {
        xaxis: {
          type: "linear"
        }
      }
    };
  }

  componentDidUpdate(prevProps) {
    if (this.props.batch?.id !== prevProps.batch?.id || this.props.batch?.filtered?.outputs !== prevProps.batch?.filtered?.outputs) {
      this.setState(this.parameters_data(this.props))
    }

  }
  
  parameters_data(props) {
    const params = new URLSearchParams(props.location.search);
    const { batch } = props;
    if (batch === undefined || batch === null) return {};

    const tuned_parameters = batch.extra_parameters
    const sorted_parameters = batch.sorted_extra_parameters
    return {
      tuned_parameters,
      sorted_parameters,
      selected_parameter: params.get("selected_parameter") || sorted_parameters[0],
      selected_parameter_2: params.get("selected_parameter_2") || (sorted_parameters.length > 1 ? sorted_parameters[1] : sorted_parameters[0]),
    }
  }

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

  select = (attribute, attribute_url) => e => {
    const value = (e.target && e.target.value !==undefined) ? e.target.value : e;
    this.setState({[attribute]: value});    
    let query = qs.parse(window.location.search.substring(1));
    this.props.history.push({
      pathname: window.location.pathname,
      search: qs.stringify({
        ...query,
        [attribute_url || attribute]: value,
      })
    });
  } 

  render() {
    const { batch, selected_metrics: selected_metrics_, available_metrics: available_metrics_, input } = this.props;
    const { layout, relative, aggregation } = this.state;
    const { tuned_parameters, sorted_parameters } = this.state;

    if (!batch)
      return <p>Loading...</p>;

    let is_optimization_batch = batch?.data?.best_metrics !== undefined;
    let selected_metrics = [
      ...(is_optimization_batch ? ["iteration", "objective"] : []),
      ...selected_metrics_,
      // ...Object.keys(batch_data.best_metrics ?? {}),
    ];
    // selected_metrics = [...new Set(selected_metrics)];
    let available_metrics = {}
    // const available_metrics = is_optimization_batch ? {
    //   ...optimization_metrics,
    //   ...available_metrics_,
    // } : available_metrics_
    const available_metrics_keys = [...selected_metrics, ...Object.keys(batch.data?.best_metrics ?? {})]
    available_metrics_keys.forEach(m => available_metrics[m] = available_metrics_[m] ?? optimization_metrics[m])
    // http://alginfra1:6001/CIS_ISP_Algorithms/approximate_computing/sircapproxlib/commit/dd68070ad59b72b00d242959fb235eed8e9ee495?reference=81055b515c71cd3c3557c49ca8e889e7b0028eb4
    // console.log("selected_metrics", selected_metrics)
    // console.log("available_metrics", available_metrics)

    // selected_metric: params.get("selected_metric") || ,
    // selected_metric2: params.get("selected_metric2") || main_metrics.filter(l=>l !== default_metric)[0] || default_metric,    	
 
    let selected_metric = this.state.selected_metric ?? (is_optimization_batch ? "objective" : selected_metrics[0])
    let selected_metric2 = this.state.selected_metric2 ?? selected_metrics.filter(l=>l !== selected_metric)[0]
    // console.log(selected_metric, selected_metric2)

    // what metric are we looking at?
    let metric = available_metrics[selected_metric] ?? {label: 'NA'};
    let metric2 = available_metrics[selected_metric2] ?? {label: 'NA'};

    let outputs = {}
    batch.filtered.outputs.forEach(id => {
      if (is_optimization_batch && batch.outputs[id].metrics.objective === undefined)
        return
      outputs[id] = batch.outputs[id]
    })
    let total_outputs = batch.filtered.outputs.length;
    if (sorted_parameters.length===0 && total_outputs > 0)
      return <Callout title="How to start tuning?" icon="info-sign">
        <p>This page will display various sensibility analysis plots. Your code needs to returns metrics, and support key:values configurations</p>
        <p>To get started with tuning, go to the <strong>"Run Tests / Tuning"</strong> tab, and choose <strong>"Automated Tuning"</strong>.</p>
      </Callout>

    let selected_parameter = this.state.selected_parameter;
    let selected_parameter_2 = this.state.selected_parameter_2;

    let show_2d_sensibility = sorted_parameters.length > 1 && tuned_parameters[sorted_parameters[1]].size > 1;

    let number_inputs = Object.keys(groupBy(Object.values(outputs), "test_input_path")).length;

    const batch_data = batch.data || {};
    let filtered_best_metrics = batch_data.best_metrics !==undefined ? Object.keys(batch_data.best_metrics)
                                  // .filter(k => main_metrics.includes(k) )
                                  .reduce((obj, key) => ({
                                    ...obj,
                                    [key]: batch_data.best_metrics[key]
                                   }), {}) : {};
    return (
      <Section>
        {batch_data.optimization && <Callout icon='crown' title="Best parameters">
          {Object.entries(batch_data.best_params).map(([k, v]) => 
            <Tag key={k} minimal round intent={Intent.SUCCESS} style={{"margin":'3px'}}>{k}: {JSON.stringify(v)}</Tag>
          )}
          {Object.entries(filtered_best_metrics).map(([k,v]) =>
            <Tag key={k} minimal round style={{"margin":'3px'}}>{available_metrics[k].label}: {metric_formatter.format(v*available_metrics[k].scale)}{available_metrics[k].suffix}</Tag>
          )}
          <p className={Classes.TEXT_MUTED}>found at iteration {batch_data.best_iter}/{batch_data.iteration}</p>
        </Callout>}

        {!batch_data.optimization && <>
          <h3 className={Classes.HEADING}>{total_outputs} run{total_outputs>1 && "s"}</h3>
          <p className={Classes.TEXT_MUTED}>{number_inputs} {number_inputs>1 && "different "}input{number_inputs>1 && "s"}</p>
        </>}

        <div style={{paddingBottom: '10px'}}>
          {input}
        </div>
        <ParallelTuningPlot
          outputs={outputs}
          main_metric={metric}
          metrics={selected_metrics.map(m => available_metrics[m])}
          parameters={sorted_parameters}
          aggregation={this.state.aggregation}
        />

        <FormGroup inline labelFor="select-metric" helperText={"Highlighted above via a color-scale. This metric is shown on the plots below on the Y-axis."}>
          <HTMLSelect
            id="select-metric"
            value={selected_metric}
            options={Object.values(available_metrics).map(m => ({value: m.key, label: m.label}) )}
            onChange={this.select('selected_metric')}
            minimal
          />
          <HTMLSelect
            id="aggregation"
            value={aggregation}
            options={[{label: "Median aggregation", value: "median"}, {label: "Average aggregation", value: "average"}]}
            onChange={this.select('aggregation')}
            minimal
          />
        </FormGroup>

        {batch_data.optimization && <>
          <h4>Convergence</h4>
          <img height={250} alt="not yet available" src={`${batch.batch_dir_url}/plot_convergence.png?iter=${batch_data.best_iter}`}/>
          {/* <h4>Parameters' importance</h4>
          <img alt="not yet available" src={`${batch.batch_dir_url}/plot_objective.png`}/>
          <h4>How we sampled the search space</h4>
          <img alt="not yet available" src={`${batch.batch_dir_url}/plot_evaluations.png`}/> */}
        </>}


        <h4 className={Classes.HEADING}>Sensibility to tuning parameters</h4>
        <FormGroup inline labelFor="select-parameter" helperText="Shown on the X-axis">
          <HTMLSelect
            id="select-parameter"
            value={selected_parameter}
            options={sorted_parameters.map(p => ({value: p, label: `${p} (${tuned_parameters[p].size} different${tuned_parameters[p].size > 1 ? "s" : ""})`}))}
            onChange={this.select('selected_parameter')}
            minimal
          />
          <Switch
            inline
            label="Log-scale"
            checked={this.state.layout.xaxis.type === "log"}
            onChange={this.updateXScale}
          />
        </FormGroup>


        {show_2d_sensibility && <>
          <FormGroup inline labelFor="select-parameter-2" helperText="Shown on the Y-axis in the 2D sensibility plot">
            <HTMLSelect
              id="select-parameter-2"
              value={selected_parameter_2}
              options={sorted_parameters.map(p => ({value: p, label: `${p} (${tuned_parameters[p].size} different${tuned_parameters[p].size > 1? "s" : ""})`}))}
              onChange={this.select('selected_parameter_2')}
              minimal
            />
          </FormGroup>
          <Sensibility2DContour
            outputs={outputs}
            metric={metric}
            available_metrics={available_metrics}
            parameters={[selected_parameter, selected_parameter_2]}
            aggregation={this.state.aggregation}
          />
          <div className={Classes.TEXT_MUTED} style={{ fontSize: 10 }}>
            <p><span style={{borderBottom: '1px dashed #999', textDecoration: 'none'}} title={`${aggregation} over all selected inputs`}>Aggregated scores</span> are computed for each set of tuning parameters.</p>
            <p>Those having the same values for <em>{selected_parameter}</em> and <em>{selected_parameter_2}</em> are themselves <span style={{borderBottom: '1px dashed #999', textDecoration: 'none'}} title={aggregation}>aggregated</span>.</p>
          </div>
        </>}

        {number_inputs>1 && <Sensibility1DBoxplots
          outputs={outputs}
          metric={metric}
          available_metrics={available_metrics}
          parameter={selected_parameter}
          layout={layout}
        />}
        <h4 className={Classes.HEADING}>Breakdown by test</h4>
        <Switch
          label="Relative to Best"
          defaultChecked={relative}
          onChange={e => {this.setState({ relative: !relative });}}
        />
        <Sensibility1DLines
          outputs={outputs}
          metric={metric}
          available_metrics={available_metrics}
          parameter={selected_parameter}
          relative={relative}
          layout={layout}
        />

        {show_2d_sensibility &&<Fragment>
        <h4 className={Classes.HEADING}>Efficient frontier & tradeoffs</h4>
        <FormGroup inline labelFor="select-metric-2" helperText="Metric on Y-axis">
          <HTMLSelect
            id="select-metric-2"
            value={selected_metric2}
            options={Object.values(available_metrics).map(m => ({value:m.key, label: m.label}))}
            onChange={this.select('selected_metric2')}
            minimal
          />
        </FormGroup>
        <EfficientFrontierPlot
          outputs={outputs}
          metric_x={metric}
          metric_y={metric2}
          available_metrics={available_metrics}
          aggregation={this.state.aggregation}
          parameter={selected_parameter}
        />
        </Fragment>
      }

      </Section>
    );
  }
}

export default withRouter(TuningExploration);
