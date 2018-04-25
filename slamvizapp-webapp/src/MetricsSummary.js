/* global Plotly:true */
// import Plot from 'react-plotly.js'
import React, { Component, Fragment } from "react";
import styled from "styled-components";

import { Tag, Button, Intent, Callout, MenuItem } from "@blueprintjs/core";
import { MultiSelect, Classes } from "@blueprintjs/select";


import { slam_metrics } from "./slam/metrics";
import { noMetrics } from "./common/metricSelect";

import createPlotlyComponent from 'react-plotly.js/factory'
const Plot = createPlotlyComponent(Plotly);

// todo: we should use the colors defined by @blueprint, and JS helpers to alpha-ize, darken, etc.
const color = 'rgba(255, 157, 0, 1)';
const color_ref = 'rgba(55, 126, 184, 1)';
const colors = [color, color_ref];

const color_a = 'rgba(255, 157, 0, .4)';
const color_ref_a = 'rgba(55, 126, 184, .4)';
const colors_a = [color_a, color_ref_a];

const xdata = ['New', 'Reference'];

const metric_formatter = new Intl.NumberFormat('en-US', {style:'decimal', minimumFractionDigits:2, maximumFractionDigits:2});
const percent_formatter = new Intl.NumberFormat('en-US', {style:'decimal', minimumFractionDigits:0, maximumFractionDigits:0});


const MetricTag = ({metrics, metrics_ref, metric}) => {
  const metric_info = slam_metrics[metric];
  let formatted_valued = <span>{metric_info.short_label}: <strong>{metric_formatter.format(metric_info.scale*metrics[metric])}{metric_info.suffix}</strong></span>;
  let intent = metrics[metric]>metric_info.threshold ? Intent.DANGER : Intent.SUCCESS;
  let metric_tag = <Tag className="pt-minimal" intent={intent}>{formatted_valued}</Tag>

  if (metrics_ref!==undefined && metrics_ref[metric]) {
    let delta = metrics[metric] - metrics_ref[metric];
    let delta_relative = delta / metrics_ref[metric];
    var intent_compare;
    if (delta_relative>.01)
      intent_compare = Intent.DANGER;
    else if (delta_relative<-.01)
      intent_compare = Intent.SUCCESS;
    else
      intent_compare = Intent.DEFAULT;
    var compare_tag = <Tag className="pt-minimal" intent={intent_compare}>{percent_formatter.format(100*delta_relative)}%</Tag>
  } else {
    compare_tag = <Fragment/>;
  }
  return <Fragment>{metric_tag}{compare_tag}</Fragment>
}


const MetricRow = styled.div`
  display: flex;
  align-items: center;
  //margin-bottom: 35px;
  // justify-content: space-between;
`
const MetricTile = styled.div`
  flex: 0.1 0.1 auto;
  text-align: center;
  padding: 10px;
  min-width: 310px; // manuall adjusted with the largest title..
`


const HistogramComparaison = ({new_values, ref_values, metric}) => {
	let layout = {
	      bargap: 0., 
	      bargroupgap: 0., 
	      barmode: "overlay",
	      yaxis: {
	          type:'log',
	          autorange: true,

	          color: "rgba(0,0,0,0.8)",
	          tickcolor: "rgba(0,0,0,0.8)",
	          autotick: false,
	          dtick:0.69897000433,
	          exponentformat:'SI',

	          showgrid: false,
	          zeroline: false,
	          gridcolor: 'rgb(255, 255, 255)',
	          gridwidth: 1,
	      },
	      xaxis: {color: "rgba(0,0,0,0.8)", fixedrange: true, title:''},
	      showlegend: false,
	      // margin: {
	      //     l: 40,
	      //     r: 30,
	      //     b: 80,
	      //     t: 100
	      // },
	      // height: 400,
	      // width: 300,

	      margin: { // will eat into the drawing area
	          l: 40,
	          r: 30,
	          b: 25,
	          t: 0,
	          pad:0
	      },
	      width: 300,
	      height: 100,
	      autosize: false,
        plot_bgcolor: 'rgba(0,0,0,0)',
        paper_bgcolor: 'rgba(0,0,0,0)',
	  };

    var ydata = [
      new_values.map(x=>metric.scale*x),
      ref_values.map(x=>metric.scale*x),
    ];

    var data = [];
    for ( var i = 0; i < xdata.length; i ++ ) {
      var result = {
        type: 'box',
        y: ydata[i],
        name: xdata[i],
        boxpoints: 'all',
        jitter: 0.5,
        whiskerwidth: 0.3,
        fillcolor: colors_a[i],
        marker: {
          size: 8,
          color: colors_a[i],
        },
        line: {
          width: 2,
          color: colors[i],
        }
      };
      data.push(result);
    }
  // layout.xaxis.title = metric.label;
  return <Plot data={data} layout={layout} config={{displayModeBar:false}} useResizeHandler fit style={{marginLeft: 'auto', flex: '0 1 auto', position: 'relative', display: 'inline-block'}}/>
}


// -${JSON.stringify(output.extra_parameters)}
const run_type = output => `${output.recording_path}-${output.platform}-${output.configuration}`;

const average = array => {
  return array.reduce( (a,b) => (a+b) , 0) / array.length;
}
const pc_under_threshold = (array, threshold) => {
  return array.filter( x => x<=threshold).length / array.length;
}
const pc_over_threshold = (array, threshold) => {
  return array.filter( x => x>=threshold).length / array.length;
}


class MetricsSummary extends Component {
  constructor(props) {
    super(props);
    this.state = {
      selected_metrics: Object.values(slam_metrics),
    };
  }

  renderMetric = (metric, {handleClick, modifiers, query} ) => {
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
    let searched = `${metric.key} ${metric.label} ${metric.short_label}`.toLowerCase();
    let search = query.toLowerCase();
    return searched.indexOf(search) >= 0;
  }
  handleClear = () => this.setState({ selected_metrics: [] });
  handleTagRemove = (_tag, index) => {
    this.deselectMetric(index);
  };
  getSelectedMetricIndex = metric => {
    return this.state.selected_metrics.indexOf(metric);
  }
  isMetricSelected(metric) {
      return this.getSelectedMetricIndex(metric) !== -1;
  }
  deselectMetric = index => {
      this.setState({ selected_metrics: this.state.selected_metrics.filter( (metric, i) => i !== index) });
  }
  handleMetricSelect = metric => {
    if (!this.isMetricSelected(metric)) {
      this.setState({ selected_metrics: [...this.state.selected_metrics, metric] });
    } else {
      this.deselectMetric(this.getSelectedMetricIndex(metric));
    }
  };


  render() {
    const { new_batch, ref_batch, compare_cross_runtype } = this.props;
    let slam_outputs_new = Object.values(new_batch.slam_outputs)
                                 .filter(o => !o.is_pending && !o.is_failed);
    if (!compare_cross_runtype) {
      var run_types_new = new Set(slam_outputs_new.map(o => run_type(o)))
      var slam_outputs_ref = Object.values(ref_batch.slam_outputs)
                                   .filter(o => run_types_new.has(run_type(o)))
                                   .filter(o => !o.is_pending && !o.is_failed);
  } else {
      run_types_new = new Set(slam_outputs_new.map(o => o.recording_path))
      slam_outputs_ref = Object.values(ref_batch.slam_outputs)
                                   .filter(o => run_types_new.has(o.recording_path))
                                   .filter(o => !o.is_pending && !o.is_failed);
    }


    const { selected_metrics } = this.state;
    const clearButton = selected_metrics.length > 0 ? <Button icon="cross" minimal={true} onClick={this.handleClear} /> : null;

    return <div>
      {new_batch.label!=='default' && <Callout intent={Intent.WARNING}>If you tried multiple tuning parameters, the results below show <strong>all the results mixed together</strong>.</Callout>}
      <MultiSelect
          items={Object.values(slam_metrics)}
          itemPredicate={this.filterMetric}
          itemRenderer={this.renderMetric}
          onItemSelect={this.handleMetricSelect}
          tagRenderer={m => m.label}
          tagInputProps={{ onRemove: this.handleTagRemove, rightElement: clearButton }}
          noResults={noMetrics}
          selectedItems={selected_metrics}
          popoverProps={Classes.MINIMAL}
      />
      {selected_metrics.map( m => {
          let new_values = slam_outputs_new.map(o=>o.metrics[m.key]).filter(x => x);
          let ref_values = slam_outputs_ref.map(o=>o.metrics[m.key]).filter(x => x);
          let new_avg = average(new_values)
          let ref_avg = average(ref_values)
          let new_pc_good = m.smaller_is_better ? pc_under_threshold(new_values, m.threshold) : pc_over_threshold(new_values, m.threshold)
          let delta = new_avg - ref_avg;
          let delta_relative = delta / ref_avg;

          var intent;
          if (m.smaller_is_better) {
            if (delta_relative>0.01)
              intent = Intent.DANGER;
            else if (delta_relative<-0.01)
              intent = Intent.SUCCESS;
            else
              intent = Intent.DEFAULT;
          } else {
            if (delta_relative<-0.01)
              intent = Intent.DANGER;
            else if (delta_relative>0.01)
              intent = Intent.SUCCESS;
            else
              intent = Intent.DEFAULT;            
          }
          return (
            <MetricRow key={m.key}>
              <MetricTile>
               <h3>{metric_formatter.format(m.scale*new_avg)}{m.suffix}<span style={{color: '#ccc'}}> avg</span></h3>
               <h5>{m.label}</h5>
               <p className="pt-text-muted">{percent_formatter.format(100*new_pc_good)}% { m.smaller_is_better? 'under': 'over'} {metric_formatter.format(m.scale*m.threshold)}{m.suffix}</p>
              </MetricTile>

              <MetricTile>
               <h3 className="pt-text-muted">vs {metric_formatter.format(m.scale*ref_avg)}{m.suffix}</h3>
               <h5><Tag intent={intent}>{percent_formatter.format(100*delta_relative)}%</Tag></h5>
              </MetricTile>

              <HistogramComparaison ref_values={ref_values} new_values={new_values} metric={m} />
          </MetricRow>
          )


        }
      )}
    </div>
  }
}


export { HistogramComparaison, MetricsSummary, MetricTag, percent_formatter, metric_formatter};
