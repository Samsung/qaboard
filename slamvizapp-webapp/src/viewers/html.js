import React, { PureComponent } from "react";
import { get, all, CancelToken } from "axios";


class HtmlViewer extends PureComponent {
  constructor(props) {
    super(props);
    this.state = {
      is_loaded: false,
      error: null,
      cancel_source: CancelToken.source(),
      data: {},
    }
  }


  componentDidMount() {
  	this.Init(this.props);
  }
  componentWillUnmount() {
    if (!!this.state.cancel_source)
      this.state.cancel_source.cancel();
  }

  componentDidUpdate(prevProps, prevState) {
	  let updated_new =
	    prevProps.output_new !== undefined &&
	    prevProps.output_new !== null &&
	    (this.props.output_new == null ||
	      prevProps.output_new.id !== this.props.output_new.id);
	  let updated_ref =
	    prevProps.output_ref !== undefined &&
	    prevProps.output_ref !== null &&
	    (this.props.output_ref == null ||
	      prevProps.output_ref.id !== this.props.output_ref.id);
	  if (updated_new || updated_ref) {
	    this.Init(this.props);
	  }
  }


  Init() {
    const { path, output_new, output_ref } = this.props;
    const { cancel_source } = this.state;
    if (!output_new.output_dir_url || !path) return;

    let results = []
    results.push(['new', `${output_new.output_dir_url}/${path}`])
    const has_reference = !!output_new && !!output_new.output_dir_url;
    if (has_reference)
      results.push(['reference', `${output_ref.output_dir_url}/${path}`])

    const load_data = label => response => {
      this.setState((previous_state, props) => ({
        data: {
          ...previous_state.data,
          [label]: response.data.data,
        },
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


  render() {
    const { output_ref, style } = this.props;
    const { data, is_loaded, error } = this.state;

    if (!is_loaded) return <span/>;
    if (!!error) return <span>{JSON.stringify(error)}</span>

    const width = (!!style && style.width) || '400px';
    let no_reference = !!!output_ref || !!!output_ref.output_dir_url;
    return <>
      <div style={{width}} dangerouslySetInnerHTML={{__html: data.new || ""}} /> 
      {!no_reference && <div style={{width}} dangerouslySetInnerHTML={{__html: data.ref || ""}} />} 
    </>
  }


}


export default HtmlViewer;
