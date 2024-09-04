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
  Icon,
  SegmentedControl,
} from "@blueprintjs/core";

import { toaster } from "../toaster"


class ExportPlugin extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      path: this.props.path || '*.png',
      export_dir: null,
      export_type: "link", // "copy"
      edited: false,
      is_loading: false,
      errors: [],
      nb_files_exported: null,
    }
  }

  componentDidUpdate(prevProps) {
    if (!this.state.edited && prevProps.config !== this.props.config) {
      let visualizations = this.props.config?.outputs?.visualizations || []
      let path = (visualizations[0] || {}).path || '*.png'
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
      export_dir: this.state.export_dir,
      export_type: this.state.export_type,
      edit_export_dir: false,
    };
    get('/api/v1/export/', {params})
    .then(response => {
      const windows_export_dir = linux_to_windows(response.data.export_dir);
      copy(windows_export_dir);
      this.setState({
        is_loading: false,
        linux_export_dir: response.data.export_dir,
        windows_export_dir,
        nb_files_exported: response.data.nb_files_exported,
        nb_outputs_exported: response.data.nb_outputs,
        errors: response.data.errors,
      })
      toaster.show({
        message: "Export directory copied to clipboard!",
        intent: Intent.SUCCESS,
      });

    })
    .catch(error => {
        this.setState({
          is_loading: false,
          errors: [JSON.stringify(error)],
        })
        toaster.show({
          message: error?.response?.data?.error ?? `Error: ${JSON.stringify(error)}`,
          intent: Intent.DANGER,
        });
    })
  }

  render() {
    const {
      path, export_dir, edit_export_dir, export_type,
      is_loading, errors, nb_files_exported, nb_outputs_exported,
      linux_export_dir, windows_export_dir
    } = this.state
    return <Callout style={{marginBottom: '20px', marginTop: '15px'}}>
      <FormGroup
        labelFor="pluging-copy"
        helperText={<p>
          Files will be exported as
            {edit_export_dir ? <SegmentedControl
              style={{
                marginLeft: "5px",
                marginRight: "5px",
                marginBottom: "5px",
                background: "none",
                boxShadow: "none",
                border: "1px solid rgba(28, 33, 39, 0.2)",
                boxSizing: "border-box",
              }}
              options={[{label: "link", value: "link"}, {label: "copy", value: "copy"}]}
              onValueChange={value => this.setState({export_type: value})}
              value={export_type}
              inline small outlined
            /> : " links "}
          in a shared directory. {!edit_export_dir && <Button onClick={() => this.setState({edit_export_dir: true})} small outlined icon="edit">Edit where</Button>}<br/>
          {edit_export_dir && <InputGroup onChange={e => this.setState({export_dir: e.target.value})} value={export_dir} placeholder={'/linux or \\windows path on the shared storage'} />}
          You can use <a href="https://docs.python.org/3/library/fnmatch.html">wildcard globs</a>, eg '*.txt' or '**/*.jpg' ('**/' matches 0 or more)
        </p>}
      >
        <ControlGroup>
           <Button disabled={is_loading} icon="download" onClick={this.export_to_directory}>Export</Button>
           <InputGroup
             onChange={e => this.setState({path: e.target.value, edited: true})}
             value={path}
             placeholder={'*.png'}
             intent={nb_files_exported === 0 ? "warning" : undefined}
            />
        </ControlGroup>
        {linux_export_dir && <div style={{marginTop: '10px'}}>
          <p><Tag>Windows</Tag> <code>{windows_export_dir}</code></p>
          <p><Tag>Linux</Tag> <code>{linux_export_dir}</code></p>
          {export_type === "link" && nb_files_exported !== 0 && <Tag minimal intent="warning" icon="warning-sign">The files are links to the original files, not copies!</Tag>}
        </div>}
        {nb_files_exported !== null && <Tag
            minimal
            icon={nb_files_exported === 0 ? "warning-sign" : "tick"}
            intent={nb_files_exported === 0 ? "warning" : "success"}
          >
          {nb_files_exported} files exported from {nb_outputs_exported} runs{nb_files_exported === 0 && <span>: check files match the pattern <code>{path}</code></span>}.</Tag>}
        {errors.length > 0 && <Callout icon="issue" intent="danger" title="Errors when exporting">
          <ul>{errors.map(e=> {
            return <li><code>{e}</code></li>
          })}</ul>
          </Callout>}
      </FormGroup>
    </Callout>
  }
}


export { ExportPlugin };
