import React, { Component } from "react";
import { get } from "axios";

import { CopyToClipboard } from "react-copy-to-clipboard";
import Moment from "react-moment";
import "moment-timezone";
// import sanitizeHtml from 'sanitize-html';

import {
  Classes,
  Colors,
  Collapse,
  Callout,
  Button,
  Tag,
  Intent,
  NonIdealState,
  Tooltip,
  Toaster,
  Icon
} from "@blueprintjs/core";

import { PlatformTag, ConfigurationsTags, ExtraParametersTags } from './tags'
import { linux_to_windows } from '../utils'

var Convert = require('ansi-to-html');
var convert = new Convert();


const toaster = Toaster.create();


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
      this.refreshLogInterval = setInterval(this.refreshLog, 1000);
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
          logs: response.data
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

    const tag_config = <ConfigurationsTags configuration={output.configuration}/>
    const tag_platform = <PlatformTag platform={output.platform} />
    const extra_parameters_tags = !!output.extra_parameters ? <ExtraParametersTags parameters={output.extra_parameters} /> : <span/>
    const download_link = <a
        title="Show output files"
        target="_blank"
        rel="noopener noreferrer"
        href={output.output_dir_url}
        style={{color: Colors.GRAY1, marginRight: '5px'}}
      >
        <Icon icon="folder-shared" />
    </a>;

    const windows_path = linux_to_windows(output.output_dir_url);
    const copy_to_clipboard = <Tooltip>
        <CopyToClipboard
          text={windows_path}
          onCopy={() => {
            toaster.show({
              message: "Copied the output directory's windows-path to clipboard!",
              intent: Intent.PRIMARY
            });
          }}
        >
          <Icon
            title="copy to clipboard"
            intent={Intent.PRIMARY}
            iconSize={Icon.SIZE_SMALL}
            icon="duplicate"
            style={{ marginLeft: "4px", marginRight: "4px", color: Colors.GRAY1}}
          />
        </CopyToClipboard>
        <span>Copy to the clipboard the Windows directory </span>
    </Tooltip>


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

    return (
      <div>
        <h6 className={Classes.HEADING}>
          {show_button} {output.output_type !== "batch" && <Tag intent={intent}>{tag_text}</Tag>} {tag_platform} {tag_config}{" "}{copy_to_clipboard}{" "}{download_link}{" "}
          {output.test_input_path} {extra_parameters_tags}
        </h6>
          <Collapse isOpen={is_open}>
            {error ? 
              <NonIdealState
                title="No logs (yet?)"
                description={
                  error.response ? (!!error.response.data && error.response.data.includes('404') ? '404: Not found' : JSON.stringify(error.response.data)) : error
                }
              />
            : <pre className={Classes.CODE_BLOCK} dangerouslySetInnerHTML={{__html: safe_formatted_logs || ""}} />}
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
      output_type: "batch",
      output_dir_url: batch.output_dir_url,
      configuration: '',
    }

    let commands = (batch.data || {}).commands || {};

    if ((batch.data || {}).type !== 'local') {
      var title = batch.label === "default" ? "CI" : batch.label;
    } else {
      var [user, _label] = batch.label.replace('@', '').split('|');
      title = `🏠 ${user} 🚧 ${_label}`;
    }

    return <>
      {Object.values(batch.outputs)
            .filter( output => output.output_type !== "optim_iteration")
            .map(output => <OutputLog key={output.id} output={output} />)}
      <h2 style={{marginTop: '25px'}} class={Classes.HEADING}>Batch logs: {title}</h2>
      <OutputLog key={batch.output_dir_url} output={batch_mock_output} />
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
