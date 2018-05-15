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
   get(`${this.props.output.output_dir_url}/log.txt`)
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
    const intent = output.is_failed ? Intent.DANGER : (output.is_pending ? Intent.WARNING : Intent.SUCCESS);
    const button_text = is_open ? "Hide" : (is_loaded ? "Loading" : "Show")
    const tag_text = output.is_failed ? '❌' : (output.is_pending ? '⏳' : '✅')
    const details = Object.entries(output.extra_parameters).map(([k,v]) =>
      <Tag key={k} className="pt-round pt-minimal">{k}:{v}</Tag>
    )
    return <div>
      <h6><Button onClick={this.handleClick}>{button_text} logs</Button> <Tag intent={intent}>{tag_text}</Tag> <Tag>{`${output.configuration} @${output.platform}`}</Tag> {output.recording_path}</h6>
      {Object.keys(output.extra_parameters).length>0 ? JSON.stringify(output.extra_parameters) : ''} 
      {details}
      <Collapse isOpen={is_open}>
        {error && <NonIdealState title="No logs (yet?)" description={JSON.stringify(error.response.data)}/>}   
        <pre>{logs || ''}</pre>
      </Collapse>
    </div>
  }
}


const BatchLogs = ({ batch }) =>  {
  let now = new Date(); 
  return Object.values( batch.slam_outputs )
               .filter( o=> (!o.is_pending) || now - (new Date(o.created_date)) > 1800e3  )
               .map( output => <OutputLog key={output.id} output={output} />)
}

export { BatchLogs };
