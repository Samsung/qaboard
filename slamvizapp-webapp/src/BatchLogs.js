import React, { Component } from "react";
import { get } from "axios";

import { Collapse, Button, Tag, Intent, NonIdealState } from "@blueprintjs/core";


class OutputLog extends Component {
  constructor(props) {
    super(props);
    this.state = {
      is_loaded: false,
      is_open: false,
      error: null,
      logs: null,
    };
  }

  handleClick = () => {
    if (!this.state.is_loaded) this.getLog();
    this.setState({ is_open: !this.state.is_open });
  }

  getLog() {
    const { output } = this.props;
    if (output.output_type==='slam/6dof')
      var logfile = 'log.txt';
    else if (output.output_type==='cis/image') {
      logfile =  `command_line_sw_log_${output.data.config_folder}.txt`;
    } else {
      return;
    }
   get(`${this.props.output.output_dir_url}/${logfile}`)
    .then(response => {
      this.setState({
        is_loaded: true,
        logs: response.data,  
      })
    })
    .catch( error => {
      this.setState({is_loaded: true, error})
    })
  }

  render() {
    const { output } = this.props;
    const { is_open, is_loaded, error, logs } = this.state;

    console.log(output)

    const button_text = is_open ? "Hide" : (is_loaded ? "Loading" : "Show")
    const tag_text = output.is_failed ? '❌' : (output.is_pending ? '⏳' : '✅')
    // we may not know where to look for logs
    // for this type of output
    const is_supported = output.output_type==='cis/image' || output.output_type==='slam/6dof';
    const show_button = <Button
      disabled={!is_supported}
      title={is_supported ? button_text : "We don't know where to look for logs"}
      onClick={this.handleClick}>{button_text} logs
    </Button>;

    const intent = output.is_failed ? Intent.DANGER : (output.is_pending ? Intent.WARNING : Intent.SUCCESS);
    const tag_config = <Tag>{`${output.configuration} @${output.platform}`}</Tag>;
    const details = Object.entries(output.extra_parameters).map(([k,v]) =>
      <Tag key={k} intent={Intent.PRIMARY} className="pt-round pt-minimal">{k}:{v}</Tag>
    )
    return <div>
      <h6>{show_button} <Tag intent={intent}>{tag_text}</Tag> {tag_config} {output.test_input_path}</h6>
      {details}
      {is_supported && <Collapse isOpen={is_open}>
                         {error && <NonIdealState title="No logs (yet?)" description={error.response ? JSON.stringify(error.response.data) : error}/>}   
                         <pre>{logs || ''}</pre>
                       </Collapse>}
    </div>
  }
}


const BatchLogs = ({ batch }) =>  {
  let now = new Date(); 
  return Object.values( batch.outputs )
               .filter( o=> (!o.is_pending) || now - (new Date(o.created_date)) > 180e3  )
               .map( output => <OutputLog key={output.id} output={output} />)
}

export { BatchLogs };
