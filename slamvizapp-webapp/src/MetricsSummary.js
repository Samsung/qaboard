/* global Plotly:true */
// import Plot from 'react-plotly.js'
import React, { Component, Fragment } from "react";
import styled from "styled-components";

import {
  Tag,
  Button,
  Intent,
  Callout,
  MenuItem,
  Colors
} from "@blueprintjs/core";
import { MultiSelect, Classes } from "@blueprintjs/select";

import { metrics } from "./metrics";
import { noMetrics } from "./common/metricSelect";

import createPlotlyComponent from "react-plotly.js/factory";
const Plot = createPlotlyComponent(Plotly);

// todo: we should use the colors defined by @blueprint, and JS helpers to alpha-ize, darken, etc.
const color = "rgba(255, 157, 0, 1)";
const color_ref = "rgba(55, 126, 184, 1)";
const colors = [color, color_ref];

const color_a = "rgba(255, 157, 0, .4)";
const color_ref_a = "rgba(55, 126, 184, .4)";
const colors_a = [color_a, color_ref_a];

const metric_formatter = new Intl.NumberFormat("en-US", {
  style: "decimal",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
const percent_formatter = new Intl.NumberFormat("en-US", {
  style: "decimal",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});

const MetricTag = ({ metrics_new, metrics_ref, metric_info }) => {
  let formatted_valued = (
    <span>
      {metric_info.short_label}:{" "}
      <strong>
        {metric_formatter.format(
          metric_info.scale * metrics_new[metric_info.key]
        )}
        {metric_info.suffix}
      </strong>
    </span>
  );
  let intent =
    (metrics_new[metric_info.key] > metric_info.threshold &&
      metric_info.smaller_is_better) ||
    (metrics_new[metric_info.key] < metric_info.threshold &&
      !metric_info.smaller_is_better)
      ? Intent.DANGER
      : Intent.SUCCESS;
  let metric_tag = (
    <Tag className="pt-minimal" intent={intent}>
      {formatted_valued}
    </Tag>
  );

  if (metrics_ref !== undefined && metrics_ref[metric_info.key]) {
    let delta = metrics_new[metric_info.key] - metrics_ref[metric_info.key];
    let delta_relative = delta / metrics_ref[metric_info.key];
    var intent_compare;
    if (delta_relative > 0.01) intent_compare = Intent.DANGER;
    else if (delta_relative < -0.01) intent_compare = Intent.SUCCESS;
    else intent_compare = Intent.DEFAULT;
    var compare_tag = (
      <Tag className="pt-minimal" intent={intent_compare}>
        {percent_formatter.format(100 * delta_relative)}%
      </Tag>
    );
  } else {
    compare_tag = <Fragment />;
  }
  return (
    <Fragment>
      {metric_tag}
      {compare_tag}
    </Fragment>
  );
};

const MetricRow = styled.div`
  display: flex;
  align-items: center;
  &:first-child {
    margin-top: 10px;
  }
  // justify-content: space-between;
`;
const MetricTile = styled.div`
  flex: 0.1 0.1 auto;
  text-align: center;
  align-self: start;
  padding: 10px;
  min-width: 355px; // manuall adjusted with the largest title..
`;

const HistogramComparaison = ({
  new_values,
  ref_values,
  metric,
  xaxis_labels
}) => {
  const xdata = xaxis_labels || ["New", "Reference"];
  let plot_scale = metric["plot_scale"] || "log";
  let layout = {
    bargap: 0,
    bargroupgap: 0,
    barmode: "overlay",
    yaxis: {
      type: plot_scale,
      autorange: true,
      color: "rgba(0,0,0,0.8)",
      tickcolor: "rgba(0,0,0,0.8)",
      showgrid: false,
      zeroline: false,
      gridcolor: "rgb(255, 255, 255)",
      gridwidth: 1
    },
    xaxis: { color: "rgba(0,0,0,0.8)", fixedrange: true, title: "" },
    shapes: [],
    showlegend: false,
    margin: {
      // will eat into the drawing area
      l: 40,
      r: 30,
      b: 25,
      t: 0,
      pad: 0
    },
    width: 300,
    height: 100,
    autosize: false,
    plot_bgcolor: "rgba(0,0,0,0)",
    paper_bgcolor: "rgba(0,0,0,0)"
  };

  let threshold = metric.threshold * metric.scale;
  let all_values = [...new_values, ...ref_values].filter(
    x => x !== null && x !== undefined && !isNaN(x)
  );
  let min_y = Math.min(...all_values) * metric.scale;
  let max_y = Math.max(...all_values) * metric.scale;
  let all_success = metric.smaller_is_better
    ? max_y <= threshold
    : min_y <= threshold;
  let all_failed = metric.smaller_is_better
    ? min_y >= threshold
    : max_y >= threshold;

  if (!all_success)
    layout.shapes.push({
      type: "rect",
      layer: "below",
      xref: "paper",
      x0: 0,
      x1: 1,
      yref: "y",
      y0: metric.smaller_is_better ? max_y : threshold,
      y1: metric.smaller_is_better ? threshold : min_y,
      opacity: 0.2,
      fillcolor: Colors.RED5,
      line: {
        color: Colors.RED5
      }
    });
  if (!all_failed)
    layout.shapes.push({
      type: "rect",
      layer: "below",
      xref: "paper",
      x0: 0,
      x1: 1,
      yref: "y",
      y0: metric.smaller_is_better ? min_y : threshold,
      y1: metric.smaller_is_better ? threshold : max_y,
      opacity: 0.15,
      fillcolor: Colors.GREEN2,
      line: {
        color: Colors.GREEN2
      }
    });

  var ydata = [
    new_values.map(x => metric.scale * x),
    ref_values.map(x => metric.scale * x)
  ];

  var data = [];
  for (var i = 0; i < xdata.length; i++) {
    var result = {
      type: "box",
      y: ydata[i],
      name: xdata[i],
      boxpoints: "all",
      jitter: 0.5,
      whiskerwidth: 0.3,
      fillcolor: colors_a[i],
      marker: {
        size: 8,
        color: colors_a[i]
      },
      line: {
        width: 2,
        color: colors[i]
      }
    };
    data.push(result);
  }
  // layout.xaxis.title = metric.label;
  return (
    <Plot
      data={data}
      layout={layout}
      config={{ displayModeBar: false }}
      useResizeHandler
      fit
      style={{
        marginLeft: "auto",
        flex: "0 1 auto",
        position: "relative",
        display: "inline-block"
      }}
    />
  );
};

// -${JSON.stringify(output.extra_parameters)}
const run_type = output =>
  `${output.test_input_path}-${output.platform}-${output.configuration}`;

const average = array => {
  return array.reduce((a, b) => a + b, 0) / array.length;
};
const pc_under_threshold = (array, threshold) => {
  return array.filter(x => x <= threshold).length / array.length;
};
const pc_over_threshold = (array, threshold) => {
  return array.filter(x => x >= threshold).length / array.length;
};

const disable_axe = {
  fixedrange: true,
  zeroline: false,
  showgrid: false,
  showline: false,
  showticklabel: false,
  ticks: "",
  autotick: true
};

let layout_tiles = {
  barmode: "stack",
  font: {
    color: "#fff"
  },
  yaxis: {
    ...disable_axe,
    title: "",
    color: "#fff",
    tickcolor: "#fff"
  },
  xaxis: {
    ...disable_axe,
    title: "",
    color: "#fff",
    tickcolor: "#fff"
  },
  showlegend: false,
  margin: {
    l: 0,
    r: 0,
    b: 0,
    t: 0,
    pad: 0
  },
  width: 150,
  height: 25,
  autosize: false,
  plot_bgcolor: "rgba(0,0,0,0)",
  paper_bgcolor: "rgba(0,0,0,0)"
};

const SuccessBar = ({ success_frac }) => (
  <Plot
    data={[
      {
        type: "bar",
        orientation: "h",
        name: "Success",
        x: [100 * success_frac],
        textposition: "auto",
        hoverinfo: "none",
        text:
          success_frac > 0.4
            ? `${percent_formatter.format(100 * success_frac)}% success`
            : "",
        opacity: 1,
        marker: {
          color: Colors.GREEN3
        }
      },
      {
        type: "bar",
        orientation: "h",
        name: "Failure",
        x: [100 * (1 - success_frac)],
        textposition: "auto",
        hoverinfo: "none",
        text:
          success_frac < 0.6
            ? `${percent_formatter.format(100 * (1 - success_frac))}% failed`
            : "",
        opacity: 0.8,
        marker: {
          color: Colors.RED5
        }
      }
    ]}
    layout={layout_tiles}
    config={{ displayModeBar: false }}
  />
);

class MetricsSummary extends Component {
  constructor(props) {
    super(props);
    const { project } = props;
    const available_metrics = metrics[project].available_metrics;
    const default_selected_metrics =
      metrics[project].summary_metrics.map(k => available_metrics[k]) || [];
    let selected_metrics = props.selected_metrics || default_selected_metrics;
    this.state = {
      available_metrics,
      selected_metrics
    };
  }

  renderMetric = (metric, { handleClick, modifiers, query }) => {
    if (!modifiers.matchesPredicate) {
      return null;
    }
    return (
      <MenuItem
        active={modifiers.active}
        icon={this.isMetricSelected(metric) ? "tick" : "blank"}
        key={metric.key}
        label={metric.key}
        text={`${metric.label} [${metric.suffix}]`}
        onClick={handleClick}
        shouldDismissPopover={false}
      />
    );
  };
  filterMetric = (query, metric) => {
    let searched = `${metric.key} ${metric.label} ${
      metric.short_label
    }`.toLowerCase();
    let search = query.toLowerCase();
    return searched.indexOf(search) >= 0;
  };
  handleClear = () => this.setState({ selected_metrics: [] });
  handleTagRemove = (_tag, index) => {
    this.deselectMetric(index);
  };
  getSelectedMetricIndex = metric => {
    return this.state.selected_metrics.indexOf(metric);
  };
  isMetricSelected(metric) {
    return this.getSelectedMetricIndex(metric) !== -1;
  }
  deselectMetric = index => {
    this.setState({
      selected_metrics: this.state.selected_metrics.filter(
        (metric, i) => i !== index
      )
    });
  };
  handleMetricSelect = metric => {
    if (!this.isMetricSelected(metric)) {
      this.setState({
        selected_metrics: [...this.state.selected_metrics, metric]
      });
    } else {
      this.deselectMetric(this.getSelectedMetricIndex(metric));
    }
  };

  render() {
    const { new_batch, ref_batch } = this.props;
    if (new_batch === null) return <span />;

    let xaxis_labels = this.props.xaxis_labels || ["New", "Reference"];
    let outputs_new = Object.values(new_batch.outputs).filter(
      o => !o.is_pending
    );
    let run_types_new = new Set(outputs_new.map(o => run_type(o)));
    let outputs_ref = Object.values(ref_batch.outputs)
      .filter(o => run_types_new.has(run_type(o)))
      .filter(o => !o.is_pending);
    run_types_new = new Set(outputs_new.map(o => o.test_input_path));
    outputs_ref = Object.values(ref_batch.outputs)
      .filter(o => run_types_new.has(o.test_input_path))
      .filter(o => !o.is_pending);

    const { selected_metrics } = this.state;
    const clearButton =
      selected_metrics.length > 0 ? (
        <Button icon="cross" minimal={true} onClick={this.handleClear} />
      ) : null;

    // what parameters were changed?
    let tuned_parameters = new Set();
    Object.entries(new_batch.outputs).forEach(([id, o]) => {
      Object.keys(o.extra_parameters).forEach(p => {
        tuned_parameters.add(p);
      });
    });
    let tuned_parameters_array = Array.from(tuned_parameters);

    return (
      <div>
        {tuned_parameters_array.length > 0 && (
          <Callout intent={Intent.WARNING}>
            The results below show <strong>all the results</strong> with various
            parameters mixed together.
          </Callout>
        )}
        <MultiSelect
          items={Object.values(this.state.available_metrics)}
          itemPredicate={this.filterMetric}
          itemRenderer={this.renderMetric}
          onItemSelect={this.handleMetricSelect}
          tagRenderer={m => m.label}
          tagInputProps={{
            onRemove: this.handleTagRemove,
            rightElement: clearButton
          }}
          noResults={noMetrics}
          selectedItems={selected_metrics}
          popoverProps={Classes.MINIMAL}
        />
        {selected_metrics.map(m => {
          let new_values = outputs_new
            .map(o => o.metrics[m.key])
            .filter(x => x !== undefined)
            .map(o => 1 * o);
          if (new_values.length === 0) return <Fragment key={m.key} />;
          let ref_values = outputs_ref
            .map(o => o.metrics[m.key])
            .filter(x => x !== undefined);
          let new_avg = average(new_values);
          let ref_avg = average(ref_values);
          let new_pc_good = m.smaller_is_better
            ? pc_under_threshold(new_values, m.threshold)
            : pc_over_threshold(new_values, m.threshold);
          let ref_pc_good = m.smaller_is_better
            ? pc_under_threshold(ref_values, m.threshold)
            : pc_over_threshold(ref_values, m.threshold);
          let delta = new_avg - ref_avg;
          let delta_relative = delta / ref_avg;

          var intent;
          if (m.smaller_is_better) {
            if (delta_relative > 0.01) intent = Intent.DANGER;
            else if (delta_relative < -0.01) intent = Intent.SUCCESS;
            else intent = Intent.DEFAULT;
          } else {
            if (delta_relative < -0.01) intent = Intent.DANGER;
            else if (delta_relative > 0.01) intent = Intent.SUCCESS;
            else intent = Intent.DEFAULT;
          }
          return (
            <MetricRow key={m.key}>
              <MetricTile>
                <h3>
                  {metric_formatter.format(m.scale * new_avg)}
                  {m.suffix}
                  <span style={{ color: "#ccc" }}> avg</span>
                </h3>
                <h5>{m.label}</h5>
                <SuccessBar success_frac={new_pc_good} />
              </MetricTile>

              <MetricTile>
                <h3 style={{ color: color_ref }}>
                  vs {metric_formatter.format(m.scale * ref_avg)}
                  {m.suffix}
                </h3>
                <h5>
                  <Tag intent={intent}>
                    {delta_relative > 0 ? "+" : ""}
                    {percent_formatter.format(100 * delta_relative)}%
                  </Tag>
                </h5>
                {!!ref_pc_good && <SuccessBar success_frac={ref_pc_good} />}
              </MetricTile>

              <HistogramComparaison
                ref_values={ref_values}
                new_values={new_values}
                metric={m}
                xaxis_labels={xaxis_labels}
              />
            </MetricRow>
          );
        })}
      </div>
    );
  }
}

export { HistogramComparaison, MetricsSummary, MetricTag };
