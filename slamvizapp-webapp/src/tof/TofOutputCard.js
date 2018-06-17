/* global Plotly:true */
// import Plot from 'react-plotly.js'
import React, { Component } from "react";
// import { get, all, spread } from "axios";
import { Card, Icon, Tag, Intent, Popover, Colors } from "@blueprintjs/core";
import { MetricTag } from "../MetricsSummary";
import { main_metrics, available_metrics } from "./metrics";

import createPlotlyComponent from 'react-plotly.js/factory'
const Plot = createPlotlyComponent(Plotly);



var colors = {
  groundtruth : `${Colors.GREEN2}dd`,
  new : `${Colors.GOLD2}dd`,
  reference : `${Colors.BLUE2}dd`,
}


var make_traces = function(metrics_over_frames, label) {
  return {
    x: Object.keys(metrics_over_frames),
    y: Object.values(metrics_over_frames).map(m=>m.rmse),
    line: {
      color: colors[label],
      width: label === 'reference' ? 3 : 2, // ref wider to highlight bit accuracy
    },
    marker: {
      color: colors[label],
      size: 5
    },
    mode: 'lines',
    name: label, legendgroup:label,
    showlegend: true,
  }
}


class TofOutputCard extends Component {
  constructor(props) {
    super(props);
    this.state = {
      is_loaded: false,
    }
  }

  render() {
    const { output_new, output_ref, warning, no_header } = this.props;
    let metrics_new = output_new && output_new.metrics ? output_new.metrics : {};
    let metrics_ref = output_ref && output_ref.metrics ? output_ref.metrics : {};

    let tags = <span>
      {Object.entries(output_new.extra_parameters).map(([k,v]) =>
        <Tag key={k} intent={Intent.PRIMARY} className="pt-round pt-minimal">{k}:{v}</Tag>
      )}
      <a title="Show output files" style={{paddingLeft: '5px'}} target="_blank" href={output_new.output_dir_url}><Icon icon="download"/></a>
      {warning && <Popover interactionKind='hover'><Icon intent={Intent.WARNING} icon='warning-sign' /><span>{warning}</span></Popover>}      
    </span>


    console.log(output_new.metrics)
    console.log(output_ref.metrics)
    let traces = [
      make_traces(output_new.metrics.frames, 'new'),
      make_traces(output_ref.metrics.frames, 'reference'),
    ]
    let layout = this.props.layout || {};
    let card_width = layout.width!==undefined ? `${layout.width}px` : '440px';
    let layout_ = {
      height: 150,
      // width: layout.width || 400,
      margin: { l: 50, r: 10, b: 50, t: 50, pad: 5 },
      xaxis: {
        title: 'frame'
      },
      legend: {
        x:0,
        y:1,
        bgcolor: 'rgba(255,255,255,0.5)',
        traceorder:'grouped',
        tracegroupgap: 0
      },
      ...layout,
    }
    const output_types = ['depth', 'intensity'];
    return <div style={{flex: '0 0 auto', marginBottom: '20px', card_width}}>
      <Card className="output-card">
        {!no_header &&<div>
          <h5 style={{fontSize:'.7rem', fontWeight: 500, lineHeight: 1.6, letterSpacing: '-1px'}}>{output_new.test_input_path} <Tag className="pt-minimal" style={{marginRight:'10px'}}>{output_new.data.frames.length} frames</Tag> {tags}</h5>
          {main_metrics
           .filter( key => metrics_new[key] !== undefined)
           .map(key =>  <p key={key}>
                          <MetricTag metrics_new={metrics_new} metrics_ref={metrics_ref} metric_info={available_metrics[key]}/>
                        </p>)}

        </div>}

        <h4>RMSE</h4>
        <Plot data={traces} layout={layout_}/>

        {output_new.data.frames.map( (f, index) => {
          return  <div key={index}>
            <h4><a href={`${output_ref.output_dir_url}/Frame${index}`} target="_blank">Frame {index}</a></h4>
            {output_types.map(output_type => {
              let img_new = `${output_new.output_dir_url}/Frame${index}/${output_type}.png`;
              let img_ref = `${output_ref.output_dir_url}/Frame${index}/${output_type}.png`;
              return <div key={output_type}>
                <a href={img_new}><img width={400} alt='New' src={img_new} /></a>
                <a href={img_ref}><img width={400} alt='Reference' src={img_ref} /></a>
              </div>
            })}
          </div>
        })}


        {false && <p>{JSON.stringify(output_new.data)}</p>}
      </Card>
    </div>
  }

}


export { TofOutputCard };
