import React, { PureComponent } from "react";
import { get, all, CancelToken } from "axios";
import Plot from 'react-plotly.js';
import { Colors } from "@blueprintjs/core";


const colors = {
  groundtruth: `${Colors.GREEN2}dd`,
  new: `${Colors.ORANGE2}dd`,
  reference: `${Colors.BLUE2}dd`
};


const adapt = (trace, label, side_by_side) => {
  // if (trace.type === 'heatmap')
  //   trace.type = 'heatmapgl'
  if (side_by_side)
    return trace

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

  getData(props, label) {
    const { output_new, output_ref, path, path_groundtruth, side_by_side } = props;
    const { cancel_source } = this.state;
    if (!output_new.output_dir_url || !path) return;

    let results = [];
    const should_get_all = label === undefined || label === null;
    if (should_get_all || label === 'new') {
      results.push(['new', `${output_new.output_dir_url}/${path}`])
    }
    if (should_get_all || label === 'reference') {
      if (!!output_ref && !!output_ref.output_dir_url)
        results.push(['reference', `${output_ref.output_dir_url}/${path}`])
      if (!!path_groundtruth)
        results.push( ['groundtruth', `${output_new.output_dir_url}/${path_groundtruth}`] )
    }

    const load_data = label => response => {
      this.setState((previous_state, props) => ({
        data: {
          ...previous_state.data,
          [label]: (response.data.data || []).map(t => adapt(t, label, side_by_side) ),
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

  componentDidUpdate(prevProps, prevState) {
      const has_new = this.props.output_new !== undefined && this.props.output_new !== null;
      const has_ref = this.props.output_ref !== undefined && this.props.output_ref !== null;
      let updated_new = has_new && (prevProps.output_new === null || prevProps.output_new === undefined || prevProps.output_new.id !== this.props.output_new.id);
      let updated_ref = has_ref && (prevProps.output_ref === null || prevProps.output_ref === undefined || prevProps.output_ref.id !== this.props.output_ref.id);
      if (updated_new) {
        this.getData(this.props, 'new');
      }
      if (updated_ref) {
        this.getData(this.props, 'reference');
      }
  }

  render() {
    const { data, layouts, is_loaded, error } = this.state;
    const { side_by_side } = this.props;
    if (!is_loaded) return <span/>;
    if (!!error) return <span>{JSON.stringify(error)}</span>

    const { style } = this.props;
    const width = (!!style && style.width) || '400px';

    if (!side_by_side) {
      let layout_ = {
        width: parseFloat(width.substring(0, width.length-2)),
        // height: parseFloat(style.heigth),
        ...layouts['new'],
        ...this.props.layout,
      };
      let traces = [
        ...( data.groundtruth || []),
        ...( data.reference || [] ),
        ...( data.new || []),
      ]
      if (traces.length===0)
        return <span></span>
      return <Plot data={traces} layout={layout_}/>;
    }

    if (side_by_side) {
      let width_full = parseFloat(width.substring(0, width.length-2))
      let layout_ = {
        width:  !!data.reference ? width_full / 2 : width_full,
        ...layouts['new'],
        ...this.props.layout,
      };
      return <>
        <Plot key="new" data={data.new} layout={layout_}/>;
        {!!data.reference && <Plot key="reference" data={data.reference} layout={layout_}/>};
      </>      
    }




  }
}

export default PlotlyViewer;
