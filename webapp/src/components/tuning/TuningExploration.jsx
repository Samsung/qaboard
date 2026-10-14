import { memo, useMemo, useState } from "react";
import { useSelected, updateSelected } from "../../hooks";
import { get as _get } from "es-toolkit/compat";

import Plot from "../Plot";
import { Classes, Callout, Colors, Intent, Tag, FormGroup, Switch, HTMLSelect } from "@blueprintjs/core";

import { Section } from "../../components/layout";
import { groupBy, hash_color, median, average, event_value } from "../../utils";
import { convergence, convergence_traces } from "./convergence";

// No "Send to Cloud" or "Edit chart" links: they would upload the data to Plotly's public Chart Studio
const config = {
  displayModeBar: true,
  showSendToCloud: false,
  showLink: false,
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



// outputs => [[params, aggregated metrics]]
// We group outputs by all their tuning / extra parameters: it avoids giving more weight to tunings that ran on more tests
const aggregate_by_params = (outputs, metrics, aggregation) => {
  const outputs_by_params = new Map();
  Object.values(outputs)
    .filter(o => !o.is_pending && !o.is_failed)
    .forEach(output => {
      const key = JSON.stringify(output.params);
      const outputs_with_same_params = outputs_by_params.get(key);
      if (outputs_with_same_params)
        outputs_with_same_params.push(output);
      else
        outputs_by_params.set(key, [output]);
    });
  return Array.from(outputs_by_params.entries()).map(([extra_parameters_s, outputs]) => {
    const aggregated_metrics = {};
    metrics.forEach(m => {
      const values = outputs.map(o => o.metrics[m.key]).filter(x => !isNaN(x));
      aggregated_metrics[m.key] = aggregation === 'median' ? median(values) : average(values);
    });
    return [extra_parameters_s, aggregated_metrics];
  });
};


const is_ok = o => !o.is_pending && !o.is_failed;


// Each iteration's objective, and the best one so far: qa optimize minimizes it.
// We plot it from the iterations: the batch's plot_convergence.png needs matplotlib where qa optimize ran.
const ConvergencePlot = ({ outputs }) => {
  const points = convergence(outputs);
  if (points.length === 0) return <p className={Classes.TEXT_MUTED}>No iteration yet.</p>;
  const layout = {
    height: 300,
    margin: { t: 10, r: 10, b: 50, l: 70 },
    showlegend: true,
    legend: { orientation: 'h', x: 0, y: 1.1 },
    xaxis: { title: { text: 'Iteration' }, dtick: points.length > 25 ? undefined : 1 },
    yaxis: { title: { text: 'Objective (lower is better)' } },
  };
  return <Plot data={convergence_traces(points, { dots: Colors.GRAY3, line: Colors.BLUE3 })} layout={layout} config={config}/>;
};

const Sensibility1DLines = memo(({
  outputs,
  metric,
  parameter,
  relative,
  layout
}) => {
  const outputs_by_input_config = groupBy(
    Object.values(outputs).map(output => ({
      output,
      key: JSON.stringify({test_input_path: output.test_input_path, configurations: output.configurations}),
    })),
    "key",
  );

  const traces = Object.entries(outputs_by_input_config).map(
    ([input_path_config, outputs_for_input]) => {
      const { test_input_path, configurations } = JSON.parse(input_path_config)
      const outputs = outputs_for_input
        .map(({ output }) => output)
        .filter(is_ok)
        .sort((a, b) => _get(a.params, parameter) - _get(b.params, parameter));
      const color = hash_color(test_input_path);
      const line = {
        color,
        width: 2,
        opacity: 0.8,
      };
      const values = outputs.map(o => o.metrics[metric.key] * metric.scale).filter(x => !isNaN(x));
      const v0 = metric.smaller_is_better
        ? Math.min(...values)
        : Math.max(...values);
      const y = relative ? values.map(v => 100 * v / v0) : values;
      const configurations_str = JSON.stringify(configurations);
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
    yaxis: {
      title: metric.label,
      showgrid: false,
      gridcolor: "rgb(255, 255, 255)",
      gridwidth: 1
    },
    ...layout,
    xaxis: {
      ...layout.xaxis,
      title: parameter,
    },
  };
  return <Plot data={traces} layout={layout_} config={config} />;
});

const Sensibility1DBoxplots = memo(({ outputs, metric, parameter, layout }) => {
  const outputs_values = Object.values(outputs).map(o => ({
    ...o,
    extra_parameter: _get(o.params, parameter)
  }));
  const outputs_by_param = groupBy(outputs_values, "extra_parameter");
  const traces = Object.entries(outputs_by_param).map(
    ([param_value, outputs_for_input]) => {
      const outputs = outputs_for_input.filter(is_ok);
      return {
        type: "box",
        name: param_value,
        x: outputs.map(o => o.extra_parameter),
        y: outputs.map(o => o.metrics[metric.key] * metric.scale),
        boxmean: true,
        marker: {
          color: Colors.ORANGE3
        }
      };
    }
  );
  const all_positive = traces.every(t => t.y.every(v => v > 0))
  const yaxis = {
    title: metric.label,
    showgrid: false,
    zeroline: false,
    gridcolor: "rgb(255, 255, 255)",
    gridwidth: 1,
    ...(all_positive ? {
      type: "log",
      autotick: false,
      dtick: 0.69897000433,
      exponentformat: "SI",
    } : {}),
  };
  const layout_ = {
    hovermode: "closest",
    boxgap: 0,
    boxgroupgap: 0,
    showlegend: false,
    ...layout,
    yaxis,
    xaxis: {
      ...layout.xaxis,
      title: parameter,
    },
  };
  return <Plot data={traces} layout={layout_} config={config} />;
});


const max_length = array => array.map(e => e.length).reduce((a, b) => Math.max(a, b), 0);

const ParallelTuningPlot = memo(({
  outputs,
  metrics,
  main_metric,
  parameters,
  aggregation,
}) => {
  const metrics_aggregated_by_params = aggregate_by_params(outputs, metrics, aggregation)
    .map(([extra_parameters_s, aggregated_metrics]) => [
      JSON.parse(extra_parameters_s),
      Object.fromEntries(Object.entries(aggregated_metrics).map(([k, v]) => [k, (v !== null && !isNaN(v)) ? v : NaN])),
    ]);

  const values = metric => metrics_aggregated_by_params.map(([, m]) => m[metric.key] * metric.scale);
  const all_good = values => values.every(v => !isNaN(v) && v !== null && v !== undefined);
  const some_different = values => new Set(values).size > 1;
  const line = {
    color: values(main_metric),
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
  };

  const metrics_with_different_values = metrics.filter(m => {
    const v = values(m);
    return all_good(v) && some_different(v);
  });
  const parameters_with_different_values = parameters.filter(p => some_different(metrics_aggregated_by_params.map(([params]) => _get(params, p))));
  const traces = [{
    type: 'parcoords',
    line: all_good(line.color) ? line : undefined,
    dimensions: [
      ...metrics_with_different_values.map(metric => ({
        label: metric.short_label ?? metric.label ?? metric.key,
        values: values(metric),
      })),
      ...parameters_with_different_values.map(p => {
        const values = metrics_aggregated_by_params.map(([params]) => _get(params, p));
        const numeric = values.every(v => !isNaN(parseFloat(v)) && isFinite(v));
        const integer = values.every(v => Number.isInteger(v));
        if (numeric)
          return { values, integer, label: p };
        // we need to remap the values to categorical integers values
        // TODO: try to differentiate the lines going to the same points...
        //       the best would be using splines, like Google Vizier
        //       adding a bit of jitter could also work
        //         https://github.com/plotly/plotly.js/issues/2229
        const unique_values = new Map();
        const remapped_values = values.map(v => {
          const v_s = JSON.stringify(v);
          if (!unique_values.has(v_s))
            unique_values.set(v_s, unique_values.size + 1);
          return unique_values.get(v_s);
        });
        return {
          values: remapped_values,
          integer: true,
          label: p,
          tickvals: Array.from(unique_values.values()),
          ticktext: Array.from(unique_values.keys()).map(k => k === undefined ? '<no-tuning>' : k),
        };
      })
    ]
  }];
  const columns = metrics_with_different_values.length + parameters_with_different_values.length;
  const max_col_length = max_length(metrics_with_different_values.map(m => (m.short_label ?? m.label ?? m.key))) + max_length(parameters_with_different_values);
  const layout = {
    width: Math.max(4 * max_col_length * columns, 840),
    autosize: false,
  };
  return <Plot data={traces} layout={layout} config={config} />;
});

const EfficientFrontierPlot = memo(({
  outputs,
  metric_x,
  metric_y,
  available_metrics,
  aggregation,
  parameter,
}) => {
  const metrics_aggregated_by_params = aggregate_by_params(outputs, Object.values(available_metrics), aggregation);
  const color = metrics_aggregated_by_params.map(([extra_parameters_s]) => JSON.parse(extra_parameters_s)[parameter]);
  const traces = [{
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
    x: metrics_aggregated_by_params.map(([, aggregated_metrics]) => aggregated_metrics[metric_x.key]),
    y: metrics_aggregated_by_params.map(([, aggregated_metrics]) => aggregated_metrics[metric_y.key]),
    text: metrics_aggregated_by_params.map(([extra_parameters_s]) => extra_parameters_s.replace(/,/g, '<br />')),
    showscale: true,
  }];

  const layout_ = {
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
});



// https://plot.ly/javascript/reference/#contour
// https://plot.ly/javascript/contour-plots/
const Sensibility2DContour = memo(({
  outputs,
  metric,
  parameter_x,
  parameter_y,
  available_metrics,
  aggregation,
}) => {
  const metrics = Object.values(available_metrics);
  const metrics_aggregated_by_params = aggregate_by_params(outputs, metrics, aggregation);

  // then we focus on the variables that are interesting to us
  const metrics_aggregated_by_shown_params = new Map();
  metrics_aggregated_by_params.forEach(([extra_parameters_s, aggregated_metrics]) => {
    const extra_parameters = JSON.parse(extra_parameters_s);
    const shown_params = {
      [parameter_x]: _get(extra_parameters, parameter_x),
      [parameter_y]: _get(extra_parameters, parameter_y),
    };
    const key = JSON.stringify(shown_params);
    const with_same_params = metrics_aggregated_by_shown_params.get(key);
    if (with_same_params)
      with_same_params.push(aggregated_metrics);
    else
      metrics_aggregated_by_shown_params.set(key, [aggregated_metrics]);
  });

  // and re-aggregate
  const metrics_by_shown_params_aggregated = Array.from(metrics_aggregated_by_shown_params.entries()).map(
    ([extra_parameters_s, aggregated]) => {
      const aggregated_metrics = {};
      metrics.forEach(m => {
        const values = aggregated.map(metric => metric[m.key]).filter(x => !isNaN(x));
        const aggregated_value = aggregation === 'median' ? median(values) : average(values);
        if (aggregated_value !== null)
          aggregated_metrics[m.key] = aggregated_value;
      });
      return [JSON.parse(extra_parameters_s), aggregated_metrics];
    }
  );

  const traces = [
    {
      type: "contour",
      x: metrics_by_shown_params_aggregated.map(([p]) => _get(p, parameter_x)),
      y: metrics_by_shown_params_aggregated.map(([p]) => _get(p, parameter_y)),
      z: metrics_by_shown_params_aggregated.map(([, m]) => m[metric.key] * metric.scale),
      contours: {
        coloring: "heatmap", // apply a gradient within each contour
        showlabels: true,
        labelfont: {
          size: 8,
          color: "#ffffff"
        }
      },
      connectgaps: false,
      colorscale: "Viridis"
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
      title: parameter_x
    },
    yaxis: {
      title: parameter_y
    }
  };
  return <Plot data={traces} layout={layout_} config={config} />;
});


const no_metric = { label: 'NA' };
const default_layout = { xaxis: { type: "linear" } };

const TuningExploration = ({ batch, selected_metrics: selected_metrics_, available_metrics: available_metrics_, input }) => {
  const { query } = useSelected();
  const [relative, setRelative] = useState(true);
  const [layout, setLayout] = useState(default_layout);

  // The plots' settings are in the URL
  const aggregation = query.aggregation || 'median';
  const select = attribute => e => updateSelected({ [attribute]: event_value(e) }, { defaults: { aggregation: 'median' } });

  const is_optimization_batch = batch?.data?.best_metrics !== undefined;
  const { selected_metrics, available_metrics } = useMemo(() => {
    const selected_metrics = [
      ...(is_optimization_batch ? ["iteration", "objective"] : []),
      ...(selected_metrics_ ?? []),
    ];
    const available_metrics = {};
    for (const m of [...selected_metrics, ...Object.keys(batch?.data?.best_metrics ?? {})]) {
      const metric = available_metrics_?.[m] ?? optimization_metrics[m];
      if (metric) available_metrics[m] = metric;
    }
    return { selected_metrics, available_metrics };
  }, [is_optimization_batch, selected_metrics_, available_metrics_, batch?.data?.best_metrics]);
  const shown_metrics = useMemo(
    () => selected_metrics.map(m => available_metrics[m]).filter(m => m !== undefined),
    [selected_metrics, available_metrics],
  );

  const outputs = useMemo(() => {
    const outputs = {};
    for (const id of batch?.filtered?.outputs ?? []) {
      if (is_optimization_batch && batch.outputs[id].metrics.objective === undefined)
        continue;
      outputs[id] = batch.outputs[id];
    }
    return outputs;
  }, [batch, is_optimization_batch]);
  const number_inputs = useMemo(
    () => new Set(Object.values(outputs).map(o => o.test_input_path)).size,
    [outputs],
  );

  if (!batch)
    return <p>Loading...</p>;

  const tuned_parameters = batch.extra_parameters;
  const sorted_parameters = batch.sorted_extra_parameters;
  const total_outputs = batch.filtered.outputs.length;
  if (sorted_parameters.length===0 && total_outputs > 0)
    return <Callout title="How to start tuning?" icon="info-sign">
      <p>This page will display various sensibility analysis plots. Your code needs to returns metrics, and support key:values configurations</p>
      <p>To get started with tuning, go to the <strong>"Run Tests / Tuning"</strong> tab, and choose <strong>"Automated Tuning"</strong>.</p>
    </Callout>

  const selected_metric = query.selected_metric ?? (is_optimization_batch ? "objective" : selected_metrics[0]);
  const selected_metric2 = query.selected_metric2 ?? selected_metrics.filter(l => l !== selected_metric)[0];
  // what metric are we looking at?
  const metric = available_metrics[selected_metric] ?? no_metric;
  const metric2 = available_metrics[selected_metric2] ?? no_metric;

  const selected_parameter = query.selected_parameter || sorted_parameters[0];
  const selected_parameter_2 = query.selected_parameter_2 || (sorted_parameters.length > 1 ? sorted_parameters[1] : sorted_parameters[0]);
  const show_2d_sensibility = sorted_parameters.length > 1 && tuned_parameters[sorted_parameters[1]].size > 1;

  const batch_data = batch.data || {};
  const best_metrics = batch_data.best_metrics ?? {};
  const metric_options = Object.values(available_metrics).map(m => ({value: m.key, label: m.label}));
  const parameter_options = sorted_parameters.map(p => ({value: p, label: `${p} (${tuned_parameters[p].size} different${tuned_parameters[p].size > 1 ? "s" : ""})`}));

  const updateXScale = () => setLayout(layout => ({
    ...layout,
    xaxis: { ...layout.xaxis, type: layout.xaxis.type === "log" ? "linear" : "log" },
  }));

  return (
    <Section>
      {batch_data.optimization && <Callout icon='crown' title="Best parameters">
        {Object.entries(batch_data.best_params ?? {}).map(([k, v]) =>
          <Tag key={k} minimal round intent={Intent.SUCCESS} style={{"margin":'3px'}}>{k}: {JSON.stringify(v)}</Tag>
        )}
        {Object.entries(best_metrics).map(([k,v]) =>
          <Tag key={k} minimal round style={{"margin":'3px'}}>{available_metrics[k]?.label ?? k}: {metric_formatter.format(v*(available_metrics[k]?.scale ?? 1))}{available_metrics[k]?.suffix}</Tag>
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
        metrics={shown_metrics}
        parameters={sorted_parameters}
        aggregation={aggregation}
      />

      <FormGroup inline labelFor="select-metric" helperText={"Highlighted above via a color-scale. This metric is shown on the plots below on the Y-axis."}>
        <HTMLSelect
          id="select-metric"
          value={selected_metric}
          options={metric_options}
          onChange={select('selected_metric')}
          minimal
        />
        <HTMLSelect
          id="aggregation"
          value={aggregation}
          options={[{label: "Median aggregation", value: "median"}, {label: "Average aggregation", value: "average"}]}
          onChange={select('aggregation')}
          minimal
        />
      </FormGroup>

      {batch_data.optimization && <>
        <h4>Convergence</h4>
        <ConvergencePlot outputs={outputs}/>
      </>}


      <h4 className={Classes.HEADING}>Sensibility to tuning parameters</h4>
      <FormGroup inline labelFor="select-parameter" helperText="Shown on the X-axis">
        <HTMLSelect
          id="select-parameter"
          value={selected_parameter}
          options={parameter_options}
          onChange={select('selected_parameter')}
          minimal
        />
        <Switch
          inline
          label="Log-scale"
          checked={layout.xaxis.type === "log"}
          onChange={updateXScale}
        />
      </FormGroup>


      {show_2d_sensibility && <>
        <FormGroup inline labelFor="select-parameter-2" helperText="Shown on the Y-axis in the 2D sensibility plot">
          <HTMLSelect
            id="select-parameter-2"
            value={selected_parameter_2}
            options={parameter_options}
            onChange={select('selected_parameter_2')}
            minimal
          />
        </FormGroup>
        <Sensibility2DContour
          outputs={outputs}
          metric={metric}
          available_metrics={available_metrics}
          parameter_x={selected_parameter}
          parameter_y={selected_parameter_2}
          aggregation={aggregation}
        />
        <div className={Classes.TEXT_MUTED} style={{ fontSize: 10 }}>
          <p><span style={{borderBottom: '1px dashed #999', textDecoration: 'none'}} title={`${aggregation} over all selected inputs`}>Aggregated scores</span> are computed for each set of tuning parameters.</p>
          <p>Those having the same values for <em>{selected_parameter}</em> and <em>{selected_parameter_2}</em> are themselves <span style={{borderBottom: '1px dashed #999', textDecoration: 'none'}} title={aggregation}>aggregated</span>.</p>
        </div>
      </>}

      {number_inputs>1 && <Sensibility1DBoxplots
        outputs={outputs}
        metric={metric}
        parameter={selected_parameter}
        layout={layout}
      />}
      <h4 className={Classes.HEADING}>Breakdown by test</h4>
      <Switch
        label="Relative to Best"
        checked={relative}
        onChange={() => setRelative(!relative)}
      />
      <Sensibility1DLines
        outputs={outputs}
        metric={metric}
        parameter={selected_parameter}
        relative={relative}
        layout={layout}
      />

      {show_2d_sensibility && <>
        <h4 className={Classes.HEADING}>Efficient frontier & tradeoffs</h4>
        <FormGroup inline labelFor="select-metric-2" helperText="Metric on Y-axis">
          <HTMLSelect
            id="select-metric-2"
            value={selected_metric2}
            options={metric_options}
            onChange={select('selected_metric2')}
            minimal
          />
        </FormGroup>
        <EfficientFrontierPlot
          outputs={outputs}
          metric_x={metric}
          metric_y={metric2}
          available_metrics={available_metrics}
          aggregation={aggregation}
          parameter={selected_parameter}
        />
      </>}
    </Section>
  );
};

export default TuningExploration;
