import React from "react";
import { get } from "axios";

import Moment from "react-moment";
import sanitizeHtml from 'sanitize-html';

import {
  Classes,
  Collapse,
  Callout,
  Button,
  NonIdealState,
  Tooltip,
} from "@blueprintjs/core";

import { StatusTag, style_skeleton } from './tags'
import { OutputHeader } from '../viewers/OutputCard'
import { pretty_label } from '../utils'

var Convert = require('ansi-to-html');
var convert = new Convert();



class OutputLog extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      is_loaded: false,
      is_open: false,
      error: null,
      logs: null,
      logs_html: null,
    };
  }

  componentDidUpdate(prevProps) {
    const has_logs = !!this.props.output && !!this.props.output_dir_url
    if (!has_logs) return
    const had_logs = !!prevProps.output && !!prevProps.output_dir_url
    if (had_logs && this.props.output_dir_url !==prevProps.output.output_dir_url)
      this.getLog()
  }

  refreshLog = () => {
    if ((!!this.props.output && !this.props.output.is_pending) || !this.state.is_open) {
      clearInterval(this.refreshLogInterval);
    } else {
      this.getLog();
    }
  }

  handleClick = () => {
    if (!this.state.is_loaded) this.getLog();
    this.setState({ is_open: !this.state.is_open });

    if (!!this.refreshLogInterval) clearInterval(this.refreshLogInterval);
    if (!!this.props.output && this.props.output.is_pending) {
      // console.log(this.props.output)
      this.refreshLogInterval = setInterval(this.refreshLog, 2500);
    }
  };

  componentWillUnmount(){
    if (!!this.refreshLogInterval) clearInterval(this.refreshLogInterval);
  }

  getLog(log_file) {
    const { output } = this.props;
    if (!!!output || !!!output.output_dir_url) return
    this.setState({is_loaded: false});
    // console.log(`[logs] fetch ${output.test_input_path}`)
    // console.log(`       => ${output.output_dir_url}/${log_file || 'log.txt'}`)

    get(`${output.output_dir_url}/${log_file || 'log.txt'}`)
      .then(response => {
        const logs = response.data;
        // https://stackoverflow.com/questions/4842424/list-of-ansi-color-escape-sequences
        // https://github.com/rburns/ansi-to-html/blob/master/test/ansi_to_html.js
        // https://github.com/rburns/ansi-to-html/blob/master/src/ansi_to_html.js
        const sanitizeHtml_options = {
          // allowedTags: ['b', 'i', 'em', 'strong', 'a'],
          // allowedAttributes: {
          //   a: ['href', 'target']
          // }
        }
        let logs_safe = sanitizeHtml(logs, sanitizeHtml_options);
        let ansi_to_html_options =  {
          //fg: '#fff',
          // bg: '#000',
          // colors: {
          //   0: '#fff',
          //   30: '#fff',
          //   232: '#fff',
          // },
          // pre: style={{background: '#000'}} 
        }
        var logs_html_safe;
        try {
          logs_html_safe = !!logs && convert.toHtml(logs_safe, ansi_to_html_options);
        } catch {
          logs_html_safe = !!logs && logs_safe;
        }
        this.setState({
          is_loaded: true,
          // logs,
          logs_html_safe,
          error: null,
        });
      })
      .catch(error => {
        console.log(error)
        this.setState({ is_loaded: true, error });
      });
  }

  render() {
    const { output } = this.props;
    const { is_open, is_loaded, error, logs_html_safe } = this.state;
    // console.log(`[logs] render ${output.test_input_path}`)
    // console.log(sanitizeHtml("<Config>test</Config>"));

    const button_text = is_open ? "Hide" : is_loaded ? "Loading" : "Show";
    const show_button = (
      <Button title={button_text} onClick={this.handleClick}>
        {button_text} logs
      </Button>
    );


    const header_prefix = <>
      {show_button} {output.output_type !== "batch" && <StatusTag output={output}/>}
    </>
    return (
      <div>
        <OutputHeader
          project={this.props.project}
          commit={this.props.commit}
          output={output}
          mismatch={output.reference_mismatch}
          dispatch={this.props.dispatch}
          prefix={header_prefix}
          tags_first
        />
        <Collapse isOpen={is_open}>
          {error ? 
            <NonIdealState
              title="No logs."
              description={
                error.response ? (!!error.response.data && error.response.data.includes('404') ? '404: Not found' : JSON.stringify(error.response.data)) : error
              }
            />
          : <div>
              <pre
                className={Classes.CODE_BLOCK}
                dangerouslySetInnerHTML={{
                  __html: logs_html_safe || ""
                }}
                style={{
                  maxHeight: '500px',
                  overflow: 'scroll',
                  ...(output.is_pending ? style_skeleton : {}),
                }}
              />
            </div>
          }
        </Collapse>
      </div>
    );
  }
}




class BatchLogs extends React.Component {
  render() {
    const { batch } = this.props;
    if (batch === null || batch === undefined  || batch.batch_dir_url === undefined)
      return <span></span>

    let batch_mock_output = {
      is_failed: false,
      is_pending: false,
      is_running: false,
      extra_parameters: {},
      output_type: "batch",
      output_dir_url: batch.batch_dir_url,
      test_input_metadata: batch.data,
      configurations: [],
    }

    let commands = Object.values((batch.data || {}).commands || {});
    const some_tuning_commands = commands.some(c => !c.job_url)

    const title = pretty_label(batch)
    return <>
      {batch.filtered.outputs.map(id => batch.outputs[id])
            .filter( o => o.output_type !== "optim_iteration")
            .map(output => <OutputLog
              key={output.id}
              project={this.props.project}
              commit={this.props.commit}
              output={output}
              dispatch={this.props.dispatch}
            />)}
      <h2 style={{marginTop: '25px'}} className={Classes.HEADING}>Batch logs: {title}</h2>
      {some_tuning_commands && <OutputLog
        key={batch.batch_dir_url}
        project={this.props.project}
        commit={this.props.commit}
        output={batch_mock_output}
        dispatch={this.props.dispatch}
      />}
      <div>{commands.map( (command, id) => {
        return <Callout style={{marginBottom: '5px'}} key={id} title={
          <>
            {!!command.job_url && <a style={{marginRight: '12px'}} href={command.job_url} target="_blank" rel="noopener noreferrer"><Button icon="share">Open Logs</Button></a>}
          	<Tooltip>
              <Moment fromNow utc>{command.command_created_at_datetime}</Moment>
              <Moment utc>{command.command_created_at_datetime}</Moment>
            </Tooltip>
            {!!command.user && ` as ${command.user}`}{!!command.HOST && ` @${command.HOST}`}
          </>}>
          <code>{command.argv.join(" ")}</code>
        </Callout>
      })}
      </div>
    </>

	}
}


export { BatchLogs };
