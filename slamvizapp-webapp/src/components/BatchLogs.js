import React, { Component } from "react";
import { get } from "axios";

import Moment from "react-moment";
import "moment-timezone";
// import sanitizeHtml from 'sanitize-html';

import {
  Classes,
  Collapse,
  Callout,
  Button,
  Tag,
  Intent,
  NonIdealState,
  Spinner,
  Tooltip,
} from "@blueprintjs/core";

import { OutputHeader } from '../viewers/OutputCard'
import { pretty_label } from '../utils'

var Convert = require('ansi-to-html');
var convert = new Convert();



class OutputLog extends Component {
  constructor(props) {
    super(props);
    this.state = {
      is_loaded: false,
      is_open: false,
      error: null,
      logs: null
    };
  }

  componentDidUpdate(prevProps) {
    if (!!!this.props.output || !!!this.props.output_dir_url)
      return
    if (!!!prevProps.output || !!!prevProps.output.output_dir_url)
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
      this.refreshLogInterval = setInterval(this.refreshLog, 2000);
    }
  };

  componentWillUnmount(){
    if (!!this.refreshLogInterval) clearInterval(this.refreshLogInterval);
  }

  getLog() {
    const { output } = this.props;
    if (!!!output || !!!output.output_dir_url) return
    this.setState({is_loaded: false});

    get(`${output.output_dir_url}/log.txt`)
      .then(response => {
        this.setState({
          is_loaded: true,
          logs: response.data,
          error: null,
        });
      })
      .catch(error => {
        this.setState({ is_loaded: true, error });
      });
  }

  render() {
    const { output } = this.props;
    const { is_open, is_loaded, error, logs } = this.state;
    const button_text = is_open ? "Hide" : is_loaded ? "Loading" : "Show";
    const tag_text = output.is_failed ? "❌" : output.is_pending ? "⏳" : "✅";

    const show_button = (
      <Button title={button_text} onClick={this.handleClick}>
        {button_text} logs
      </Button>
    );

    const intent = output.is_failed
      ? Intent.DANGER
      : output.is_pending ? Intent.WARNING : Intent.SUCCESS;

    // https://stackoverflow.com/questions/4842424/list-of-ansi-color-escape-sequences
    // https://github.com/rburns/ansi-to-html/blob/master/test/ansi_to_html.js
    // https://github.com/rburns/ansi-to-html/blob/master/src/ansi_to_html.js
    let ansi_to_html_options =  {
      //fg: '#fff',
      // bg: '#000',
      // colors: {
      //   0: '#fff',
      //   30: '#fff',
      //   232: '#fff',
      // },
    }
    let formatted_logs = !!logs && convert.toHtml(logs, ansi_to_html_options);
    let safe_formatted_logs = formatted_logs;
    // TODO
    // let safe_formatted_logs = sanitizeHtml(formatted_logs, {
    //   allowedTags: ['b', 'i', 'em', 'strong', 'a'],
    //   allowedAttributes: {
    //     a: ['href', 'target']
    //   }
    // });
    // pre: style={{background: '#000'}} 
    const header_prefix = <>{show_button} {output.output_type !== "batch" && <Tag intent={intent}>{tag_text}</Tag>}</>
    return (
      <div>
        <OutputHeader
          project={this.props.project}
          project_data={this.props.project_data}
          commit={this.props.commit}
          output={output}
          warning={output.reference_warning}
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
          : <><pre className={Classes.CODE_BLOCK} dangerouslySetInnerHTML={{__html: safe_formatted_logs || ""}} />{output.is_pending && <Spinner small/>}</>}
        </Collapse>
      </div>
    );
  }
}




class BatchLogs extends Component {
  constructor(props) {
    super(props);
    this.state = {
    };
  }


  render() {
    const { batch } = this.props;
    if (batch === null || batch === undefined  || batch.output_dir_url === undefined)
      return <span></span>

    let batch_mock_output = {
      is_failed: false,
      is_pending: false,
      is_running: false,
      extra_parameters: {},
      output_type: "batch",
      output_dir_url: batch.output_dir_url,
      test_input_metadata: batch.data,
      configuration: '',
    }

    let commands = (batch.data || {}).commands || {};

    const title = pretty_label(batch)

    return <>
      {Object.values(batch.outputs)
            .filter( output => output.output_type !== "optim_iteration")
            .map(output => <OutputLog
              key={output.id}
              project={this.props.project}
              project_data={this.props.project_data}
              commit={this.props.commit}
              output={output}
              dispatch={this.props.dispatch}
            />)}
      <h2 style={{marginTop: '25px'}} className={Classes.HEADING}>Batch logs: {title}</h2>
      <OutputLog
        key={batch.output_dir_url}
        project={this.props.project}
        project_data={this.props.project_data}
        commit={this.props.commit}
        output={batch_mock_output}
        dispatch={this.props.dispatch}
      />
      <div>{Object.entries(commands).map( ([id, command]) => {
        return <Callout style={{marginBottom: '5px'}} key={id} title={
          <>
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
