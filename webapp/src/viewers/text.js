import React from "react";
import { get, all, CancelToken } from "axios";

import { Classes, Tag, Tooltip } from "@blueprintjs/core";
import MonacoEditor from 'react-monaco-editor';
import { MonacoDiffEditor } from 'react-monaco-editor';

import { hash_color } from '../utils'

// TODO: Implement a way to hide identical lines in the diff viewer
// 1. We could use the diffNavigator
// https://microsoft.github.io/monaco-editor/playground.html#creating-the-diffeditor-navigating-a-diff
// https://github.com/react-monaco-editor/react-monaco-editor/issues/84
// https://github.com/react-monaco-editor/react-monaco-editor#how-to-get-value-of-editor    
// 2. Or try to the get the diff and remove everything bu those lines...

const ansi_pattern = [
  '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)',
  '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))'
].join('|');
const ansi_regexp = new RegExp(ansi_pattern, 'g');

const language = filename => {    
  if (filename.endsWith('yaml') || filename.endsWith('yml'))
    return 'yaml';
  if (filename.endsWith('json'))
    return 'json';
  if (filename.endsWith('js'))
    return 'javascript';
  if (filename.endsWith('py'))
    return 'python';
  if (filename.endsWith('cde'))
    return 'python';
  return 'plaintext';
}


const editor_options = {
  selectOnLineNumbers: true,
  seedSearchStringFromSelection: true,
  readOnly: true,
  //renderSideBySide: false
};



class GenericTextViewer extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      data: {},
      is_loaded: false,
      error: null,
      cancel_source: CancelToken.source(),
      shown_left: "reference",
    }
  }

  componentDidMount() {
    this.fetchData(this.props);
    window.addEventListener("keypress", this.keyboard, { passive: true });
  }

  componentWillUnmount() {
    window.removeEventListener('keypress', this.keypress);
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
          [label]: response.data.replace(ansi_regexp, ''),
        },
      })
    }

    all(results.map( ([label, url]) => {
      return () =>  get(url, {cancelToken: this.state.cancel_source.token, transformResponse: response => response})
                    .then(load_data(label))
                    .catch(response => {
                      // we don't really care about errors for reference logs
                      this.setState({data: {...this.state.data, [label]: ''}})
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
    if (!!error && !this.props.always_show_diff) return <span>{JSON.stringify(error)}</span>

    const { data, shown_left } = this.state;
    console.log("render", shown_left)
    if (!!!data.new && !this.props.always_show_diff)
      return <span></span>

    if (this.props.only_diff && data.new === data.ref)
      return <span></span>

    const { filename, text_url_new, text_url_ref, width, hash } = this.props;
    let no_reference = !!!text_url_ref || !!!data.reference || (!!text_url_new && text_url_new === text_url_ref);

    const max_lines = this.props.max_lines || 40
    let lines_new = ((data.new || '').match(/\r?\n/g) || '').length + 1
    let lines_ref = ((data.reference || '').match(/\r?\n/g) || '').length + 1
    const height = 18 * Math.min(Math.max(lines_new, lines_ref), max_lines) + 10;
    const editor = (!no_reference || this.props.always_show_diff)
      ? <MonacoDiffEditor
          readonly
          width={width}
          height={height}
          language={this.props.language || language(filename)}
          value={shown_left==='reference' ? data.new : data.reference}
          original={shown_left==='reference' ? data.reference : data.new}
          options={editor_options}
        />
      : <MonacoEditor
          readonly
          width={width}
          height={height}
          language={this.props.language || language(filename)}
          value={data.new || ''}
          options={editor_options}
        />

    return <>
      <h3 className={Classes.HEADING}>{filename} <Tag>{(!no_reference || this.props.always_show_diff) ? `${shown_left} ➡️ ` : ""}{shown_left==="reference" ? "new" : "reference"}</Tag> {hash && <Tooltip><Tag style={{backgroundColor: hash_color(hash)}}>hash: {hash.slice(0,8)}</Tag><span>Hash of the new file</span></Tooltip>}</h3>
      {editor}
    </>
  }


  switch = e => {
    let shown_left = this.state.shown_left === 'reference' ? 'new' : 'reference';
    this.setState({ shown_left })
  }
  keyboard = ev => {
    if (ev.target.nodeName === 'INPUT')
      return;
    switch (ev.id || String.fromCharCode(ev.keyCode || ev.charCode)) {
      case "t":
        this.switch()
        break
      default:
        return;
    }
  }


}

 
export default GenericTextViewer;
