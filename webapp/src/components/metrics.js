import React, { Component, Fragment } from "react";
import Plot from 'react-plotly.js';
import styled from "styled-components";

import {
  Classes,
  Tag,
  Button,
  Icon,
  Intent,
  Callout,
  MenuItem,
  Colors,
  Tooltip,
} from "@blueprintjs/core";
import { MultiSelect } from "@blueprintjs/select";

import { noMetrics } from "./metricSelect";
import { RunBadge } from "./tags";
import { format, median, plotly_palette, match_query } from "../utils";



// todo: we should use the colors defined by @blueprint, and JS helpers to alpha-ize, darken, etc.
const color = "rgba(255, 157, 0, 1)";
const color_ref = "rgba(55, 126, 184, 1)";
const colors = [color, color_ref];

const color_a = "rgba(255, 157, 0, .4)";
const color_ref_a = "rgba(55, 126, 184, .4)";
const colors_a = [color_a, color_ref_a];

const metric_formatter = (value, metric) => {
  if (isNaN(value)) {
    return value
  }
  // 3 significant digits by default
  // https://mathjs.org/docs/reference/functions/format.html
  return format(value, {precision: metric?.precision ?? 3})
  // This doesn't support scientific notation.. but above there
  // are not thousant separators... ^^
  // return value.toLocaleString({
  //   minimumSignificantDigits: metric?.precision ?? 3,
  //   maximumSignificantDigits: metric?.precision ?? 3,
  // })
}
const percent_formatter = new Intl.NumberFormat("en-US", {
  style: "decimal",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});

const MetricTag = ({ metrics_new, metrics_ref, metric_info }) => {
  const value = metrics_new[metric_info.key]
  let formatted_valued = (
    <span>
      {metric_info.short_label}:{" "}
      <strong>
        {isNaN(value) ? <RunBadge badge={value}/> : metric_formatter(metric_info.scale * value, metric_info)}{metric_info.suffix}
      </strong>
    </span>
  );
   
  let intent =
    (metrics_new[metric_info.key] > metric_info.target &&
      metric_info.smaller_is_better) ||
    (metrics_new[metric_info.key] < metric_info.target &&
      !metric_info.smaller_is_better)
      ? Intent.DANGER
      : Intent.SUCCESS;
  let metric_tag = <Tooltip>
    <Tag style={{margin: '3px'}} minimal intent={!!metric_info.target ? intent : null}>
      {formatted_valued}
    </Tag>
    <span>{!isNaN(value) ? `${metric_info.scale * metrics_new[metric_info.key]}${metric_info.suffix}` : JSON.stringify(value)}</span>
  </Tooltip>;

  if (metric_info.key === 'is_failed' && !metrics_new.is_failed) {
    metric_tag = <span/>
  }

  if (metrics_ref !== undefined && metrics_ref[metric_info.key] && metrics_ref[metric_info.key] !== metrics_new[metric_info.key]) {
    let delta = metrics_new[metric_info.key] - metrics_ref[metric_info.key];
    let delta_relative = delta / metrics_ref[metric_info.key];
    var intent_compare;
    const neutral_threshold = metric_info.target_passfail ? 0 : 0.01
    if (delta_relative > neutral_threshold)
      intent_compare = metric_info.smaller_is_better ? Intent.DANGER : Intent.SUCCESS;
    else if (delta_relative < -neutral_threshold)
      intent_compare = metric_info.smaller_is_better ? Intent.SUCCESS : Intent.DANGER;
    else intent_compare = Intent.DEFAULT;
    var compare_tag = <Tag style={{margin: '3px'}} minimal intent={intent_compare}>{delta_relative >= 0 ? '+' : ''}{percent_formatter.format(100 * delta_relative)}%</Tag>;
  } else {
    compare_tag = <span/>;
  }
  return (
    <>
      {metric_tag}
      {compare_tag}
    </>
  );
};


class MetricsTags extends React.PureComponent {
  render() {
    const { metrics_new, metrics_ref } = this.props;
    const { available_metrics={}, selected_metrics=[] } = this.props;
    return selected_metrics
      .filter(key => metrics_new[key] !== undefined)
      .map(key =>
          <MetricTag key={key}
            metrics_new={metrics_new}
            metrics_ref={metrics_ref}
            metric_info={available_metrics[key]}
          />
      )
  }
}




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

const HistogramComparaison = ({ series, metric, xaxis_labels, layout, use_plotly_default_colors }) => {
  const xdata = xaxis_labels || ["New", "Reference"];
  let plot_scale = metric["plot_scale"] || "log";
  let layout_ = {
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
    paper_bgcolor: "rgba(0,0,0,0)",
    ...layout,
  };

  let all_values = [];
  series.forEach(values => {
    values.forEach(v => all_values.push(v));
  });
  all_values = all_values.filter(
    x => x !== null && x !== undefined && !isNaN(x)
  );

  if (!!metric.target) {
    let min_y = Math.min(...all_values) * metric.scale;
    let max_y = Math.max(...all_values) * metric.scale;
    let threshold = metric.target * metric.scale;
    let all_success = metric.smaller_is_better
      ? max_y <= threshold
      : min_y <= threshold;
    let all_failed = metric.smaller_is_better
      ? min_y >= threshold
      : max_y >= threshold;
    if (!all_success)
      layout_.shapes.push({
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
      layout_.shapes.push({
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
  }

  var ydata = series.map(values => values.map(x => metric.scale * x));

  var data = [];
  for (var i = 0; i < xdata.length; i++) {
    var result = {
      type: "box",
      y: ydata[i],
      name: xdata[i],
      namelength: -1,
      boxpoints: "all",
      jitter: 0.5,
      whiskerwidth: 0.3,
      boxmean: true,
      fillcolor: use_plotly_default_colors ? undefined : colors_a[i],
      marker: {
        size: 8,
        color: use_plotly_default_colors ? undefined : colors_a[i],
      },
      line: {
        width: 2,
        color: use_plotly_default_colors ? undefined : colors[i],
      }
    };
    data.push(result);
  }
  // layout.xaxis.title = metric.label;
  return (
    <Plot
      data={data}
      layout={layout_}
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
const run_type = output => `${output.test_input_path}-${output.platform}-${JSON.stringify(output.configurations)}`;

const pc_under_threshold = (array, threshold) => {
  if (threshold === null || threshold === undefined)
    return 0
  return array.filter(x => x <= threshold).length / array.length;
};
const pc_over_threshold = (array, threshold) => {
  if (threshold === null || threshold === undefined)
    return 0
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
    const { available_metrics={}, summary_metrics=[] } = props.metrics || {};
    const default_selected_metrics = summary_metrics.filter(k=>!!available_metrics[k]).map(k => available_metrics[k]) || [];
    let selected_metrics = props.selected_metrics || default_selected_metrics;
    this.state = {
      available_metrics,
      selected_metrics
    };
  }


  componentDidUpdate(prevProps) {
    if (this.props.metrics !== prevProps.metrics) {
      const { available_metrics={}, summary_metrics=[] } = this.props.metrics;
      const default_selected_metrics = summary_metrics.filter(k=>!!available_metrics[k]).map(k => available_metrics[k]) || [];
      let selected_metrics = this.props.selected_metrics || default_selected_metrics;
      this.setState({
        available_metrics,
        selected_metrics
      });
    }
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
    return match_query(query)(`${metric.key} ${metric.label} ${metric.short_label}`)
  };
  handleClearMetrics = () => this.setState({ selected_metrics: [] });
  handleRemoveMetric = (_tag, index) => {
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
    const { new_batch, ref_batch, breakdown_by_tag } = this.props;
    if (new_batch === null) return <span />;

    let xaxis_labels = this.props.xaxis_labels || ["New", "Reference"];
    let outputs_new = new_batch.filtered.outputs
                     .map(id => new_batch.outputs[id])
                     .filter(o => !o.is_pending)
                     .filter(o => o.output_type!=="optim_iteration");                    
    let run_types_new = new Set(outputs_new.map(o => run_type(o)));
    run_types_new = new Set(outputs_new.map(o => o.test_input_path));
    // we only how ref outputs with a matching input+config+platform
    // it's debatable, maybe we should show all, or filter also on tuning params...
    let outputs_ref = ref_batch.filtered.outputs
      .map(id => ref_batch.outputs[id])
      .filter(o => run_types_new.has(o.test_input_path))
      .filter(o => !o.is_pending);

    const { selected_metrics=[] } = this.state;

    const clearButton =
      selected_metrics.length > 0 ? (
        <Button icon="cross" minimal={true} onClick={this.handleClearMetrics} />
      ) : null;


    if (breakdown_by_tag) {
      var tags = {};
      Object.values(outputs_new).forEach(output => {
        if (output.test_input_metadata !== undefined && output.test_input_metadata.tags !== undefined)
          output.test_input_metadata.tags.forEach(tag => {
            if (tags[tag] === undefined) tags[tag] = 0;
            tags[tag] += 1;
          });
      });
      // console.log(tags)

      var outputs_by_tag = {};
      Object.values(outputs_new).forEach(output => {
        if (output.test_input_metadata !== undefined && output.test_input_metadata.tags !== undefined)
          output.test_input_metadata.tags.forEach(tag => {
            if (outputs_by_tag[tag] === undefined) outputs_by_tag[tag] = [];
            outputs_by_tag[tag].push(output);
          });
      });
      // console.log(outputs_by_tag)
    }

    let batch_data = new_batch.data || {};
    return (
      <div>
        {(!batch_data.optimization && new_batch.sorted_extra_parameters.length > 0) && (
          <Callout intent={Intent.WARNING}>
            The aggregation below contains all runs, possibly with tuning <strong>parameters mixed together.</strong>
          </Callout>
        )}
        <MultiSelect
          items={Object.values(this.state.available_metrics)}
          itemPredicate={this.filterMetric}
          itemRenderer={this.renderMetric}
          onItemSelect={this.handleMetricSelect}
          tagRenderer={m => m.label}
          tagInputProps={{
            onRemove: this.handleRemoveMetric,
            rightElement: clearButton
          }}
          noResults={noMetrics}
          selectedItems={selected_metrics}
          popoverProps={Classes.MINIMAL}
        />
        <br/>
        {breakdown_by_tag &&
          Object.entries(tags).map( (tag_count, idx) => {
            let [tag, count] = tag_count
            return <Tag style={{ margin: '5px', background: plotly_palette(idx) }} key={tag}>
              {count} @{tag}
            </Tag>
          })}
        {selected_metrics.map((m, idx) => {
          let new_values = outputs_new
            .map(o => o.metrics[m.key])
            .filter(x => x !== undefined && typeof x !== 'string' )
            .map(o => 1 * o);
          if (new_values.length === 0) return <Fragment key={idx} />;
          let ref_values = outputs_ref.map(o => o.metrics[m.key]).filter(v => v !== undefined && v !== null && typeof v !== 'string');
          let new_med = median(new_values);
          let ref_med = median(ref_values);
          let new_pc_good = m.smaller_is_better
            ? pc_under_threshold(new_values, m.target)
            : pc_over_threshold(new_values, m.target);
          let ref_pc_good = m.smaller_is_better
            ? pc_under_threshold(ref_values, m.target)
            : pc_over_threshold(ref_values, m.target);
          let delta = new_med - ref_med;
          let delta_relative = delta / ref_med;

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

          if (breakdown_by_tag) {
            var series_by_tag = Object.values(outputs_by_tag).map(outputs =>
              outputs
                .map(o => o.metrics[m.key])
                .filter(x => x !== undefined)
                .map(o => 1 * o)
            );
          }
          return (
            <MetricRow key={idx}>
              <MetricTile>
                <Tooltip>
                  <h3 className={Classes.HEADING}>
                    {metric_formatter(m.scale * new_med, m)}{m.suffix}
                    <span style={{ color: "#ccc" }}> median</span>
                  </h3>
                    <span>{m.scale * new_med}{m.suffix}</span>
                </Tooltip>
                <br/>
                <Tooltip>
                  <h5 className={Classes.HEADING}>{m.short_label}</h5>
                  <span>{m.label}</span>
                </Tooltip>
                <br/>
                {m.target !== undefined && <SuccessBar success_frac={new_pc_good} />}
              </MetricTile>

              {!breakdown_by_tag && (
                <>
                  {ref_values.length > 0 && <MetricTile>
                    <Tooltip>
                      <h3 className={Classes.HEADING} style={{ color: color_ref }}>
                        <Icon style={{verticalAlign: 'middle'}} icon="swap-horizontal" color="#ccc" iconSize={16}/> {metric_formatter(m.scale * ref_med, m)}{m.suffix}
                      </h3>
                      <span>{m.scale * ref_med}{m.suffix}</span>
                    </Tooltip>
                    <h5 className={Classes.HEADING}>
                      <Tooltip>
                      <Tag intent={intent}>
                        {delta_relative > 0 ? "+" : ""}
                        {percent_formatter.format(100 * delta_relative)}%
                      </Tag>
                      <span>{100 * delta_relative}</span>
                      </Tooltip>
                    </h5>
                    {(m.target !== undefined && !!ref_pc_good) && <SuccessBar success_frac={ref_pc_good} />}
                  </MetricTile>}
                  {new_values.length > 1 && <HistogramComparaison
                    series={ref_values.length > 0 ? [new_values, ref_values] : [new_values]}
                    metric={m}
                    xaxis_labels={xaxis_labels}
                  />}
                </>
              )}
              {breakdown_by_tag && (
                <Fragment>
                  <HistogramComparaison
                    series={series_by_tag}
                    metric={m}
                    xaxis_labels={Object.keys(outputs_by_tag)}
                    use_plotly_default_colors
                    layout={{
                      width: 850,
                      xaxis: { fixedrange: true, title: "", tickfont: { size: 8 }},
                    }}
                  />
                </Fragment>
              )}
            </MetricRow>
          );
        })}
      </div>
    );
  }
}

export {
  HistogramComparaison,
  MetricsSummary,
  MetricTag,
  MetricsTags,
  metric_formatter,
  percent_formatter,
};
