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
          intent: Intent.DANGER
        });
      });
  };

  render() {
    const { isLoaded, error, groups } = this.state;
    if (!isLoaded) return <Spinner />;
    if (error)
      return (
        <NonIdealState
          title="An error occurred"
          description={JSON.stringify(error.response)}
        />
      );

    const qatools_config = this.props.project_data.information.qatools_config || {};
    let commit_groups_files = (((qatools_config.inputs || {}) || {}).groups || []);

    let project_repo = (((this.props.project_data || {}).information || {}).git || {}).path_with_namespace;
    const gitlab_commit_url = `http://gitlab-srv/${project_repo}/tree/${this.props.commit.id}`;

    if (!Array.isArray(commit_groups_files))
      commit_groups_files = [commit_groups_files]
    return (
      <form onSubmit={this.onSubmit}>
        <Callout title="How to define groups of tests" icon='info-sign' style={{marginBottom: '10px'}}>
          <p>Tuning experiments can use the custom groups <a href="#custom-groups">below</a>, or the defaults from:</p>
          <ul className={Classes.LIST}>
           {commit_groups_files.map(file => <React.Fragment key={file}>
             <li><a href={`${gitlab_commit_url}/${file}`}>{file}</a></li>
            </React.Fragment>)}
          </ul>
          <p><b>Tip:</b> The <a href="http://gitlab-srv/common-infrastructure/qatools/wikis/defining-groups-of-tests">wiki</a> provides many examples to help get the syntax right.</p>
          <p>
            <em>All filepaths are relative to <code>{(((qatools_config.inputs || {}) || {}).database || {}).windows}</code></em>
            <CopyToClipboard
              text={((qatools_config.inputs || {}).database || {}).windows}
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

        <div id="custom-groups" className={`${Classes.INLINE} ${Classes.FORM_GROUP}`} />
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
