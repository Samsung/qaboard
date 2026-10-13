import React, { PureComponent } from "react";
import axios, { all, CancelToken } from "axios";
import { html_base_url, html_with_base } from "./htmlDocument";
const { get } = axios;


// An HTML output in its own document: its styles stay out of the app, and its relative links (images/1.jpg) resolve
// from its folder. No scripts: the sandbox only lets the frame be measured (same origin) and open links in a new tab.
// The frame grows to its document's height once it loaded, images included.
const HtmlFrame = ({ html, base, width, title }) => {
  const resize = e => {
    const document = e.currentTarget.contentDocument;
    if (document?.documentElement)
      e.currentTarget.style.height = `${document.documentElement.scrollHeight}px`;
  };
  return <iframe
    title={title}
    srcDoc={html_with_base(html, base)}
    sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
    onLoad={resize}
    style={{ width, height: '150px', border: 0, display: 'block' }}
  />
}


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

  componentDidUpdate(prevProps) {
    const has_path = this.props.path !== undefined && this.props.path !== null;
    let updated_path = has_path && (prevProps.path === null || prevProps.path === undefined || prevProps.path !== this.props.path);

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
	  if (updated_new || updated_ref || updated_path) {
	    this.Init(this.props);
	  }
  }


  Init() {
    const { path, output_new, output_ref } = this.props;
    const { cancel_source } = this.state;
    if (!output_new.output_dir_url || !path) return;

    let results = []
    results.push(['new', `${output_new.output_dir_url}/${path}`])
    const has_reference = !!output_ref && !!output_ref.output_dir_url;
    if (has_reference)
      results.push(['reference', `${output_ref.output_dir_url}/${path}`])

    const load_data = label => response => {
      this.setState(previous_state => ({
        data: {
          ...previous_state.data,
          [label]: response.data,
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
    }).map(f=>f()))
    // now we loaded and parsed all the data
    .finally( () => this.setState({is_loaded: true}) )
  }


  render() {
    const { output_new, output_ref, path, style } = this.props;
    const { data, is_loaded, error } = this.state;

    if (!is_loaded) return <span>loading</span>;
    if (!!error) return <span>{JSON.stringify(error)}</span>

    const width = (!!style && style.width) || '400px';
    let has_reference = !!output_ref && !!output_ref.output_dir_url;
    return <>
      {has_reference && <h3>New</h3>}
      <HtmlFrame html={data.new ?? ""} base={html_base_url(output_new.output_dir_url, path)} width={width} title={`${path} (new)`}/>
      {has_reference && <>
        <h3>Reference</h3>
        <HtmlFrame html={data.reference || ""} base={html_base_url(output_ref.output_dir_url, path)} width={width} title={`${path} (reference)`}/>
      </>}
    </>
  }


}


export default HtmlViewer;
