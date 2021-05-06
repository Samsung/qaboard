import React from "react";
import { get } from "axios";
import copy from 'copy-to-clipboard';

import { linux_to_windows } from '../utils'

import {
  Intent,
  Tag,
  Callout,
  FormGroup,
  ControlGroup,
  InputGroup,
  Button,
} from "@blueprintjs/core";

import { Toaster } from "@blueprintjs/core";
export const toaster = Toaster.create();


class ExportPlugin extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      path: this.props.path || '*.bmp',
      edited: false,
      is_loading: false,
    }
  }

  componentDidUpdate(prevProps) {
    if (!this.state.edited && prevProps.config !== this.props.config) {
      let visualizations = this.props.config?.outputs?.visualizations || []
      let path = (visualizations[0] || {}).path || '*.bmp'
      // for projects using dynamic outputs we should
      path = path.replace(/:[a-zA-Z0-9_]+/, '*')
      this.setState({path})
    }
  }

  export_to_directory = () => {
    this.setState({is_loading: true})
    const params = {
      path: this.state.path,
      project: this.props.project,
      ref_project: this.props.ref_project,
      new_commit_id: this.props.new_commit_id,
      ref_commit_id: this.props.ref_commit_id,
      batch_new: this.props.selected_batch_new,
      batch_ref: this.props.selected_batch_ref,
      filter_new: this.props.filter_batch_new,
      filter_ref: this.props.filter_batch_ref,
    };
    get('/api/v1/export/', {params})
    .then(response => {
      const windows_export_dir = linux_to_windows(response.data.export_dir);
      copy(windows_export_dir);
      this.setState({
        is_loading: false,
        linux_export_dir: response.data.export_dir,
        windows_export_dir,
      })
      toaster.show({
        message: "Export directory copied to clipboard!",
        intent: Intent.SUCCESS,
      });

    })
    .catch(error => {
        this.setState({is_loading: false})
        toaster.show({
          message: `Network error: ${JSON.stringify(error)}`,
          intent: Intent.DANGER,
        });
    })
  }

  render() {
    return <Callout style={{marginBottom: '20px', marginTop: '15px'}}>
      <FormGroup
        labelFor="pluging-copy"
        helperText={<span>Files will be exported to a shared directory. You can use <a href="https://docs.python.org/3/library/fnmatch.html">wildcard globs</a>, eg '*.txt' or '*/*.jpg'</span>}
      >
        <ControlGroup>
           <Button disabled={this.state.is_loading} icon="download" onClick={this.export_to_directory}>Export</Button>
           <InputGroup onChange={e => this.setState({path: e.target.value, edited: true})} value={this.state.path} placeholder={'*.bmp'} />
        </ControlGroup>
        {this.state.linux_export_dir && <div style={{marginTop: '10px'}}>
          <p><Tag>Windows</Tag> <code>{this.state.windows_export_dir}</code></p>
          <p><Tag>Linux</Tag> <code>{this.state.linux_export_dir}</code></p>
        </div>}
      </FormGroup>
    </Callout>
  }
}


export { ExportPlugin };
