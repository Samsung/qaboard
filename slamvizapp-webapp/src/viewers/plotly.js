import React, { PureComponent } from "react";
import { get, all, CancelToken } from "axios";
import Plot from 'react-plotly.js';
import { Colors } from "@blueprintjs/core";


const colors = {
  groundtruth: `${Colors.GREEN2}dd`,
  new: `${Colors.ORANGE2}dd`,
  reference: `${Colors.BLUE2}dd`
};


const adapt = (trace, label, side_to_side) => {
  let out = {
    ...trace,
    name: label,
    legendgroup: label,
  } 
  if (side_to_side)
    return out 

  let width = (trace.line && trace.line.width) || 2;
  let size = (trace.marker && trace.marker.size) || 3;
  if (label === "reference") {
    width += 1;
    size += 1;
  }
  return {
    ...out,
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
    // TODO: do we need other ajustments for other plot types?
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
    const { output_new, output_ref, path, path_groundtruth, side_to_side } = props;
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
          [label]: (response.data.data || []).map(t => adapt(t, label, side_to_side) ),
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

  componentDidUpdate(nextProps, prevState) {
      let updated_new =
        nextProps.output_new !== undefined &&
        nextProps.output_new !== null &&
        (this.props.output_new == null ||
          nextProps.output_new.id !== this.props.output_new.id);
      let updated_ref =
        nextProps.output_ref !== undefined &&
        nextProps.output_ref !== null &&
        (this.props.output_ref == null ||
          nextProps.output_ref.id !== this.props.output_ref.id);

      if (updated_new || updated_ref) {
        this.Init(nextProps);
      }
      // if (!prevState.output_dir_url !== nextProps.show_debug) this.Init();
  }

  render() {
    const { data, layouts, is_loaded, error } = this.state;
    if (!is_loaded) return <span/>;
    if (!!error) return <span>{JSON.stringify(error)}</span>

    const { style } = this.props;
    const width = (!!style && style.width) || '400px';

    if (!side_to_side) {
      let layout_ = {
        width: parseFloat(width.substring(0, width.length-2)),
        // height: parseFloat(style.heigth),
        ...layouts['new'],
        ...this.props.layout,
      };

    }

    if (side_to_side) {
      return <>
        <Plot data={traces} layout={layout_}/>;    
      </>      
    }

    let traces = [
      ...( data.groundtruth || []),
      ...( data.reference || [] ),
      ...( data.new || []),
    ]
    if (traces.length===0)
      retu