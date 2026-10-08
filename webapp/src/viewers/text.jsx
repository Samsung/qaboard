import React from "react";
import axios, { all, CancelToken, isCancel } from "axios";
const { get } = axios;

import { Classes, Tag } from "@blueprintjs/core";
import MonacoEditor, { MonacoDiffEditor } from "../components/MonacoEditor";

import { is_same_data } from "../utils"

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
  if (filename.endsWith('json') || filename.endsWith('tuneset0'))
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
};



class GenericTextViewer extends React.Component {
  constructor(props) {
    super(props);
    // cancellation token kept on the instance (not state) so it's updated
    // synchronously when a new fetch supersedes the previous one
    this.cancel_source = CancelToken.source();
    this.state = {
      data: {},
      is_loaded: false,
      error: null,
      shown_left: "reference",
      renderSideBySide: props.renderSideBySide ?? true,
    }
  }

  componentDidMount() {
    this.fetchData(this.props);
    window.addEventListener("keypress", this.keyboard, { passive: true });
  }

  componentWillUnmount() {
    window.removeEventListener('keypress', this.keyboard);
    this.cancel_source.cancel();
  }

  componentDidUpdate(prevProps) {
    let had_new = prevProps.text_url_new !== undefined && prevProps.text_url_new !== null
    let had_ref = prevProps.text_url_ref !== undefined && prevProps.text_url_ref !== null

    let has_new = this.props.text_url_new !== undefined && this.props.text_url_new !== null
    let has_ref = this.props.text_url_ref !== undefined && this.props.text_url_ref !== null

    let updated_new = has_new && (!had_new || this.props.text_url_new !== prevProps.text_url_new)
    let updated_ref = has_ref && (!had_ref || this.props.text_url_ref !== prevProps.text_url_ref)
    if (updated_new || updated_ref) {
      this.fetchData(this.props);
    }
  }

  fetchData() {
    const { text_url_new, text_url_ref } = this.props;
    if (text_url_new === undefined || text_url_new === null) return;

    // cancel any in-flight requests from a previous selection and reset state,
    // so stale content or errors don't leak into the new selection
    if (!!this.cancel_source)
      this.cancel_source.cancel();
    const cancel_source = CancelToken.source();
    this.cancel_source = cancel_source; // synchronous: new fetch supersedes the previous one
    this.setState({ data: {}, is_loaded: false, error: null });

    let results = []
    results.push(['new', text_url_new])
    if (!!text_url_ref)
      results.push(['reference', text_url_ref])

    const is_current = () => this.cancel_source === cancel_source;
    const load_data = label => response => {
      if (!is_current()) return; // a newer selection superseded this fetch
      // functional form: merges must build on the latest state, otherwise
      // responses resolving in the same tick (e.g. cached) overwrite each other
      this.setState(prevState => ({
        data: {
          ...prevState.data,
          [label]: response.data.replace(ansi_regexp, ''),
        },
      }))
    }

    all(results.map( ([label, url]) => {
      return () =>  get(url, {cancelToken: cancel_source.token, transformResponse: response => response})
                    .then(load_data(label))
                    .catch(response => {
                      // ignore requests cancelled by a newer selection
                      if (isCancel(response)) return;
                      if (!is_current()) return;
                      // we don't really care about errors for reference logs
                      this.setState(prevState => ({data: {...prevState.data, [label]: ''}}))
                      if (label==='new' && !!response)
                        this.setState({error: response.data})
                    });
    }).map(f=>f()) )
    // now we loaded and parsed all the data
    .then( () => { if (is_current()) this.setState({is_loaded: true}) })
  }

  render() {
    const { is_loaded, error, renderSideBySide } = this.state;
    if (!is_loaded) return <span/>;
    if (!!error && !this.props.always_show_diff) return <span>{JSON.stringify(error)}</span>

    const { data, shown_left } = this.state;
    if (!!!data.new && !this.props.always_show_diff)
      return <span></span>

    if (this.props.only_diff && data.new === data.ref)
      return <span></span>

    const { filename, text_url_new, text_url_ref, width } = this.props;
    const has_same_data = is_same_data(filename, this.props.manifests?.new?.[filename], this.props.manifests?.reference?.[filename])
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
          options={{
            ...editor_options,
            renderSideBySide,
          }}
          editorDidMount={this.editorDidMount}
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
      <h3 className={Classes.HEADING}>
        <span style={{marginRight: "5px"}}>{filename}</span>
        <Tag>{(!no_reference || this.props.always_show_diff) ? `${shown_left} ➡️ ` : ""}{shown_left==="reference" ? "new" : "reference"}</Tag>
        {!no_reference && <Tag interactive style={{marginLeft: "5px", verticalAlign: "bottom"}} icon={renderSideBySide ? "comparison" : "align-justify"} minimal onClick={() => this.setState({renderSideBySide: !renderSideBySide})}>
          {renderSideBySide ? "Side-by-side" : "Inline diff"}
        </Tag>}
        {!no_reference && !has_same_data && <Tag interactive style={{marginLeft: "5px", verticalAlign: "bottom"}} icon="double-chevron-right" minimal onClick={this.next_diff}>
          Next Diff
        </Tag>}
        {!no_reference && has_same_data && <Tag style={{marginLeft: "5px", verticalAlign: "bottom"}} icon="duplicate" minimal>
          Same Content
        </Tag>}
      </h3>
      {editor}
    </>
  }

  editorDidMount = editor => {
    this.editor = editor
  }
  next_diff = () => {
    this.editor?.goToDiff('next')
  }
  switch = () => {
    let shown_left = this.state.shown_left === 'reference' ? 'new' : 'reference';
    this.setState({ shown_left })
  }
  keyboard = ev => {
    if (ev.target.nodeName === 'INPUT' || 
        ev.target.nodeName === 'TEXTAREA' ||
        ev.target.isContentEditable) {
      return;
    }
    
    if (ev.ctrlKey || ev.metaKey || ev.altKey) {
      return;
    }
    
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
