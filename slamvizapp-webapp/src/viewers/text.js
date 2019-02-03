import React from "react";
import { get, all, CancelToken } from "axios";

import { Classes, Tag } from "@blueprintjs/core";
import MonacoEditor from 'react-monaco-editor';
import { MonacoDiffEditor } from 'react-monaco-editor';



const language = filename => {    
  if (filename.endsWith('yaml') || filename.endsWith('yml'))
    return 'yaml'
  if (filename.endsWith('json'))
    return 'json'
  if (filename.endsWith('cde'))
    return 'python'
  return 'plaintext'
}


const editor_options = {
  selectOnLineNumbers: true,
  seedSearchStringFromSelection: true,
  //renderSideBySide: false
};



class GenericTextViewer extends React.PureComponent {
  constructor(props) {
    super(props);
    this.state = {
      data: {},
      is_loaded: false,
      error: null,
      cancel_source: CancelToken.source(),
    }
  }

  componentDidMount() {
    this.fetchData(this.props);
  }

  componentWillUnmount() {
    if (!!this.state.cancel_source)
      this.state.cancel_source.cancel();
  }

  componentDidUpdate(prevProps, prevState) {
    let had_new = prevProps.text_url_new !== undefined && prevProps.text_url_new !== undefined
    let had_ref = prevProps.text_url_ref !== undefined && prevProps.text_url_ref !== undefined

    let has_new = this.props.text_url_new !== undefined && this.props.text_url_new !== undefined
    let has_ref = this.props.text_url_ref !== undefined && this.props.text_url_ref !== undefined

    let updated_new = has_new && (!had_new || this.props.text_url_new !== prevProps.text_url_new)
    let updated_ref = has_ref && (!had_ref || this.props.text_url_ref !== prevProps.text_url_ref)
    if (updated_new || updated_ref) {
      console.log('fetch', updated_new, updated_ref)
      this.fetchData(this.props);
    }
  }

  fetchData() {
    const { text_url_new, text_url_ref } = this.props;
    if (text_url_new === undefined || text_url_new === null) return;

    let results = []
    results.push(['new', text_url_new])
    if (!!text_url_ref)
      results.push(['reference', text_url_ref])

    const load_data = label => response => {
      this.setState({
        data: {
          ...this.state.data,
          [label]: response.data,
        },
      })
    }

    all(results.map( ([label, url]) => {
      return () =>  get(url, {cancelToken: this.state.cancel_source.token, transformResponse: response => response})
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


  render() {
    const { is_loaded, error } = this.state;
    if (!is_loaded) return <span/>;
    if (!!error) return <span>{JSON.stringify(error)}</span>

    const { data } = this.state;
    if (this.props.only_diff && data.new === data.ref)
      return <span></span>

    const { filename, text_url_new, text_url_ref, width } = this.props;
    let no_reference = !!!text_url_ref || !!!data.reference || (!!text_url_new && text_url_new === text_url_ref);

    const lines = (data.new.match(/\r?\n/g) || '').length + 1
    const height = Math.min(18 * lines + 10, 400);
    const editor = !no_reference
      ? <MonacoDiffEditor
          readonly
          width={width}
          height={height}
          language={language(filename)}
          value={data.new || ''}
          original={data.reference || ''}
          options={editor_options}
        />
      : <MonacoEditor
          readonly
          width={width}
          height={height}
          language={language(filename)}
          value={data.new || ''}
          options={editor_options}
        />

    return <>
      <h3 className={Classes.HEADING}>{filename} <Tag>{!no_reference ? "reference ➡️ " : ""}new</Tag></h3>
      {editor}
    </>
  }


}

 
export default GenericTextViewer;
