import React from "react";
import { get, all, CancelToken } from "axios";

import { Tag } from "@blueprintjs/core";
import MonacoEditor from 'react-monaco-editor';
import { MonacoDiffEditor } from 'react-monaco-editor';


class TextViewer extends React.PureComponent {
  constructor(props) {
    super(props);
    this.state = {
      data: {},
      is_loaded: false,
      error: null,
      cancel_source: CancelToken.source(),
    }
  }

  render() {
    const { is_loaded, error } = this.state;
    if (!is_loaded) return <span/>;
    if (!!error) return <span>{JSON.stringify(error)}</span>

    const { data } = this.state;
    const { output_new, output_ref, style } = this.props;
    let no_reference = !!!output_ref || !!!output_ref.output_dir_url || !!!data.reference || output_new.id === output_ref.id;

    const options = {
      //renderSideBySide: false
      selectOnLineNumbers: true,
      seedSearchStringFromSelection: true,
    };

    if (this.props.only_diff && data.new === data.ref)
      return <span></span>

    const width_px = (!!this.props.style && this.props.style.width) || '400px';
    const width = parseFloat(width_px.substring(0, width_px.length-2)) - 10;

    const { path } = this.props;
    let language = "plaintext";
    if (path.endsWith('yaml') || path.endsWith('yml'))
      language = 'yaml'
    if (path.endsWith('json'))
      language = 'json'
    if (path.endsWith('cde'))
      language = 'python'
    console.log(language)
    var editor;
    if(!no_reference) {
      editor = <MonacoDiffEditor
        readonly
        width={width}
        height="400"
        language={language}
        value={data.new || ''}
        original={data.reference || ''}
        options={options}
      />
    } else {
      editor = <MonacoEditor
        readonly
        width={width}
        height="400"
        language={language}
        value={data.new || ''}
        options={options}
      />
    }
    return <>
      <h3>{path} <Tag>{!no_reference ? "reference ➡️ " : ""}new</Tag></h3>
      {editor}
    </>
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
      // console.log(response)
      this.setState({
        data: {
          ...this.state.data,
          [label]: response.data,
        },
      })
    }

    all(results.map( ([label, url]) => {
      return () =>  get(url, {cancelToken: cancel_source.token, transformResponse: response => response})
                    .then(load_data(label))
                    .catch(response => {
                      // we don't really care about errors for reference logs
                      if (label==='new' && !!response)
                        this.setState({error: response.data})
                    });
    }).map(f=>f()) )
    // now we loaded and parsed all the data
    .then( () => this.setState({is_loaded: true}) )
  }

}
 
export default TextViewer;
