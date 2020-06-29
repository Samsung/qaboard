import React, { Component } from "react";
import { get, post } from "axios";

import { CopyToClipboard } from "react-copy-to-clipboard";

import MonacoEditor from 'react-monaco-editor';

import {
  Classes,
  Callout,
  Intent,
  Spinner,
  NonIdealState,
  Button,
  Tag,
  Toaster,
} from "@blueprintjs/core";

export const toaster = Toaster.create();

const editor_options = {
  selectOnLineNumbers: true,
  seedSearchStringFromSelection: true,
  //renderSideBySide: false
};





class AddRecordingsForm extends Component {
  constructor(props) {
    super(props);
    this.state = {
      isLoaded: true,
      error: null,
      groups: null,
      dirty: false,

      submitted: false,
      overwrite: false,
      selected_group: null,
      selected_group_info: {
        number_of_tests: 0
      },
      selected_group_info_loading: false
    };
  }

  componentDidMount() {
    this.getGroups();
  }

  getGroups() {
    get(`/api/v1/tests/groups?project=${this.props.project}`)
      .then(response => {
        this.setState({
          isLoaded: true,
          groups: response.data
        });
      })
      .catch(error => {
        this.setState({ isLoaded: true, error });
      });
  }

  updateGroups = newGroups => {
    this.setState({ groups: newGroups, dirty: true });
  };

  onSubmit = e => {
    e.preventDefault();
    const { groups } = this.state;
    this.setState({ submitted: true, dirty: false });
    toaster.show({
      message: "The request was sent!",
      intent: Intent.PRIMARY
    });
    post(`/api/v1/tests/groups?project=${this.props.project}`, {
      project: this.props.project,
      groups,
    })
      .then(response => {
        this.setState({ submitted: false });
        toaster.show({
          message: "...Acknowledged!",
          intent: Intent.SUCCESS
        });
      })
      .catch(error => {
        this.setState({ submitted: false, dirty: true });
        toaster.show({
          message: `Something wrong happened ${JSON.stringify(error.response)}`,
          intent: Intent.DANGER,
        });
      });
  };

  render() {
    const { commit, config, git } = this.props;
    const { isLoaded, error, groups } = this.state;
    if (!isLoaded) return <Spinner />;
    if (error)
      return (
        <NonIdealState
          title="An error occurred"
          description={JSON.stringify(error.response)}
        />
      );

    let commit_groups_files = config.inputs?.batches || config.inputs?.groups || []; // .groups for backward compat
    if (!Array.isArray(commit_groups_files))
      commit_groups_files = [commit_groups_files]
    return (
      <form onSubmit={this.onSubmit}>
        <Callout title="How to define groups of tests" icon='info-sign' style={{marginBottom: '10px'}}>
          <p>Tuning runs can use the custom groups below, <em>shared with all the project users</em>, or the defaults from:</p>
          <ul className={Classes.LIST}>
           {commit_groups_files.map(file => <React.Fragment key={file}>
             <li><a href={`${git?.web_url}/tree/${commit.id}/${file}`}>{file}</a></li>
            </React.Fragment>)}
          </ul>
          <p><b>Tip:</b> The <a href={`${process.env.REACT_APP_QABOARD_DOCS_ROOT}docs/defining-groups-of-tests`}>wiki</a> provides many examples to help get the syntax right.</p>
          <p>
            <em>Paths are relative to <code>{config.inputs?.database?.windows}</code> by default.</em>
            <CopyToClipboard
              text={config?.inputs?.database?.windows}
              style={{margin: '5px'}}
              onCopy={() => {
                toaster.show({
                  message: "Copied to clipboard!",
                  intent: Intent.PRIMARY
                });
              }}>
              <Tag interactive minimal round icon="duplicate">Copy</Tag>
            </CopyToClipboard>
          </p>
        </Callout>
        <div className={`${Classes.INLINE} ${Classes.FORM_GROUP}`}>
          <Button
            disabled={!this.state.dirty || this.state.submitted}
            type="submit"
            intent={Intent.PRIMARY}
          >
          <span>Update list of custom groups</span>
          </Button>
        </div>

        <div className={`${Classes.INLINE} ${Classes.FORM_GROUP}`} />
        <MonacoEditor
          height={400}
          language='yaml'
          options={editor_options}
          name="groups"
          onChange={this.updateGroups}
          value={groups || ""}
        />
      </form>
    );
  }
}


export { AddRecordingsForm };
