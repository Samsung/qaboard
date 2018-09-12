import React, { PureComponent } from "react";
import { get, all, CancelToken } from "axios";
import Plot from 'react-plotly.js';
import { Classes, Colors } from "@blueprintjs/core";


const colors = {
  groundtruth: `${Colors.GREEN2}dd`,
  new: `${Colors.ORANGE2}dd`,
  reference: `${Colors.BLUE2}dd`
};


const adapt = (trace, label) => {
  let width = (trace.line && trace.line.width) || 2;
  let size = (trace.marker && trace.marker.size) || 3;
  if (label === "reference") {
    width += 1;
    size += 1;
  }

  return {
    ...trace,
    name: label,
    legendgroup: label,
    line: {
      ...trace.line,
      color: colors[label],
      // the reference is wider to highlight unchanged results
      width,
    },
    marker: {
      ...trace.marker,
      color: colors[label],
      size,
    },
    // do we need other ajustments for other plot types?
  }
}


class PlotlyViewer extends PureComponent {
  constructor(props) {
    super(props);
    this.state = {
      is_loaded: false,
      error: null,
      cancel_source: CancelToken.source(),
      data: {},
      layouts: {},
      config: {},
    };
  }

  componentDidMount() {
    this.getData(this.props)
  }

  getData(props) {
    const { output_new, output_ref, path, path_groundtruth } = props;
    const { cancel_source } = this.state;
    if (!output_new.output_dir_url || !path) return;
    
    let results = []
    results.push(['new', `${output_new.output_dir_url}/${path}`])
    if (!!output_ref && !!output_ref.output_dir_url)
      results.push(['reference', `${output_ref.output_dir_url}/${path}`])
    if (!!path_groundtruth)
      results.push( ['groundtruth', `${output_new.output_dir_url}/${path_groundtruth}`] )

    const load_data = label => response => {
      this.setState((previous_state, props) => ({
        data: {
          ...previous_state.data,
          [label]: (response.data.data || []).map(t => adapt(t, label) ),
        },
        layouts: {
          ...previous_state.layouts,
          [label]: response.data.layout || {},                          
        }
      }))
    }

    all(results.map( ([label, url]) => {
      return () =>  get(url, {cancelToken: cancel_source.token})
                    .then(load_data(label))
                    .catch(response => {
                      // we don't really care about errors for reference / groundtruth outputs
                      if (label==='new' && !!response)
                        this.setState({error: response.data})
                    });
    }).map(f=>f()) )
    // now we loaded and parsed all the data
    .then( () => this.setState({is_loaded: true}) )
  }


  componentWillUnmount() {
    if (!!this.state.cancel_source)
      this.state.cancel_source.cancel();
  }


  render() {
    const { data, layouts, is_loaded, error } = this.state;
    if (!is_loaded) return <span/>;
    if (!!error) return <span>{JSON.stringify(error)}</span>

    let traces = [
      ...( data.groundtruth || []),
      ...( data.reference || [] ),
      ...( data.new || []),
    ]
    if (traces.length===0)
      return <span className={Classes.TEXT_MUTED}>no data</span>

    let layout_ = {
      ...layouts['new'],
      ...this.props.layout,
    };
    return <Plot data={traces} layout={layout_}/>;
  }
}

export default PlotlyViewer;
