import React, { PureComponent } from "react";
import { get, all, CancelToken } from "axios";
import Plot from 'react-plotly.js';
import { Colors } from "@blueprintjs/core";


// TODO: keep the zoom in the state, like explained here
//        https://github.com/plotly/react-plotly.js/#state-management
//       and like we did in the history-over-time plot...
// TODO: sync zoom across new and ref
// TODO: sync zoom across all plots sharing the same path, like we do for images
// TODO: add magic to e.g. compare tables with a diff  

const colors = {
  groundtruth: `${Colors.GREEN2}dd`,
  new: `${Colors.ORANGE2}dd`,
  ref: `${Colors.BLUE2}dd`
};


const adapt = (trace, label, side_by_side) => {
  if (side_by_side)
    return trace

  let width = (trace.line && trace.line.width) || 2;
  let size = (trace.marker && trace.marker.size) || 3;
  if (label === "ref") {
    width += 1;
    size += 1;
  }
  const trace_has_colors = !!(trace.line || {}).color || !!(trace.marker || {}).color
  // console.log(trace)
  return {
    ...trace,
    opacity: (trace_has_colors && label === "ref") ? (!!trace.opacity ? trace.opacity / 2 : 0.4) : undefined,
    name: !!trace.name ? `${label} | ${trace.name}` : label,
    legendgroup: !!trace.legendgroup ? `${label} | ${trace.legendgroup}` : undefined,
    line: {
      ...trace.line,
      // FIXME: if we already use color, use some alpha like below, or dotted lines?
      color: !!(trace.line || {}).color ? trace.line.color : colors[label],
      dash: (!!(trace.line || {}).color && !!!trace.dash && label === "ref") ? 'dashdot' : trace.dash,
      // The reference is wider to make it easy to identify unchanged results
      width,
    },
    marker: {
      ...trace.marker,
      opacity: (!!trace_has_colors && label === "ref") ? (!!(trace.marker || {}).opacity ? trace.marker.opacity / 2 : 0.4) : (trace.marker || {}).opacity,
      color: !!(trace.marker || {}).color ? trace.marker.color : colors[label],
      size,
    },
    // TODO: make other ajustments for other plot types, like tables...
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
    if (should_get_all || label === 'ref') {
      if (!!output_ref && !!output_ref.output_dir_url)
        results.push(['ref', `${output_ref.output_dir_url}/${path}`])
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
                      // we don't really care about errors for ref / groundtruth outputs
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
      const has_path = this.props.path !== undefined && this.props.path !== null;
      let updated_path = has_path && (prevProps.path === null || prevProps.path === undefined || prevProps.path !== this.props.path);

      const has_new = this.props.output_new !== undefined && this.props.output_new !== null;
      const has_ref = this.props.output_ref !== undefined && this.props.output_ref !== null;
      let updated_new = has_new && (prevProps.output_new === null || prevProps.output_new === undefined || prevProps.output_new.id !== this.props.output_new.id);
      let updated_ref = has_ref && (prevProps.output_ref === null || prevProps.output_ref === undefined || prevProps.output_ref.id !== this.props.output_ref.id);
      // TODO: if we have a ref and didn't before, call adapt on the new
      //       and don't call adapt unless we have a ref...
      //       This would help preserve colors.  
      if (updated_new || updated_path) {
        this.getData(this.props, 'new');
      }
      if (updated_ref || updated_path) {
        this.getData(this.props, 'ref');
      }
  }

  render() {
    const { data, layouts, is_loaded, error } = this.state;
    const { side_by_side } = this.props;
    if (!is_loaded) return <span/>;
    if (!!error) return <span>{JSON.stringify(error)}</span>

    const { style } = this.props;
    const width = (!!style && style.width) || '840px';

    // console.log(this.props)
    if (!side_by_side) {
      let layout_ = {
        xaxis: {},
        yaxis: {},
        legend: {},
        width: parseFloat(width.substring(0, width.length-2)),
        // height: parseFloat(style.heigth),
        ...layouts['new'],
        ...this.props.layout,
      };
      layout_.xaxis.automargin = true;
      layout_.yaxis.automargin = true;
      layout_.legend.traceorder = 'reversed';
      let traces = [
        ...( data.groundtruth || []),
        ...( data.ref || [] ),
        ...( data.new || []),
      ]
      if (traces.length===0)
        return <span></span>
      return <Plot data={traces} layout={layout_}/>;
    }

    if (side_by_side) {
      let width_full = parseFloat(width.substring(0, width.length-2))
      let layout_ = {
        xaxis: {},
        yaxis: {},
        width:  !!data.ref ? (width_full / 2 - 40) : width_full,
        ...layouts['new'],
        ...this.props.layout,
      };
      layout_.xaxis.automargin = true;
      layout_.yaxis.automargin = true;
      return <>
        <Plot key="new" data={data.new} layout={layout_}/>
        {!!data.ref && <Plot key="ref" data={data.ref} layout={layout_}/>}
      </>      
    }
  }


}

export default PlotlyViewer;
