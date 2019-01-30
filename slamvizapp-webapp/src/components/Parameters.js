import React, { Component, Fragment } from "react";
import { get, all } from "axios";
import { Classes, NonIdealState } from "@blueprintjs/core";

import AceEditor from "react-ace";

/*eslint-disable no-alert, no-console */
import brace from "brace"; // eslint-disable-line no-unused-vars
import "brace/mode/json";
import "brace/mode/yaml";
import "brace/theme/github";
import "brace/ext/searchbox";
// import 'brace/mode/diff';
// import 'brace/ext/language_tools';
// https://github.com/securingsincity/react-ace/blob/master/docs/Ace.md5


class CommitParameters extends Component {
  constructor(props) {
    super(props);
    this.state = {
      isLoaded: false,
      parameters: {}
    };
  }


  getConfigurations() {
    get(`/api/v1/commit/${this.props.new_commit.id}?project=${this.props.project}&artifacts=configurations`)
    .then( response => {
      // to be user-friendly we show at the top the base configuration
      // this will be a list of configurations, the "default" ones at the beginning
      var configurations = [];
      // we separate the base/default configurations from the rest
      var base_configurations = [];
      response.data.forEach(c => {
        let is_base_configuration = (
          c === 'params.json' ||
          c.includes('base.json') ||
          c.includes('default.json') ||
          c.includes('base.yaml') ||
          c.includes('default.yaml')
        )
        if (is_base_configuration)
          base_configurations.push(c);
        else
          configurations.push(c);
      })
      configurations.unshift(...base_configurations)
      this.setState({configurations}, this.getParameters)      
    })
  }

  componentDidMount() {
    if (this.props.project === undefined || this.props.project === null)
      return
    if (this.props.new_commit === undefined || this.props.new_commit === null)
      return
    if (this.props.new_commit.id === undefined || this.props.id === null)
      return
    this.getConfigurations()
  }

  componentDidUpdate(previousProps) {
    let changed_project = this.props.project !== previousProps.project
    let changed_commit = (!!this.props.new_commit && !!this.props.new_commit.id) && (!!!previousProps.new_commit || !!!previousProps.new_commit.id || (this.props.new_commit.id !== previousProps.new_commit.id));
    if (changed_project || changed_commit)
    this.getConfigurations()
  }

  getParameters() {
    all([
      this.state.configurations.forEach(c => {
        get(`${this.props.new_commit.commit_dir_url}/${c}`, {
          transformResponse: response => response
        }) // avoid json parsing
          .then(response => {
            let previous_parameters = this.state.parameters;
            if (response.data.length > 0)
              this.setState({
                parameters: { ...previous_parameters, [c]: response.data }
              });
          });
      })
    ])
      .then(() => this.setState({ isLoaded: true }))
      .catch(error => {
        this.setState({ isLoaded: true, error });
      });
  }

  render() {
    const { isLoaded, error, parameters } = this.state;

    if (!isLoaded) return <span />;
    if (error)
      return (
        <NonIdealState
          title="An error occurred"
          description={JSON.stringify(error.response)}
        />
      );
    let configuration_parameters = this.state.configurations.map(c => (
      <Fragment key={c}>
        <h4 className={Classes.HEADING}>{c}</h4>
        <AceEditor
          mode={c.includes('json') ? "json" : 'yaml'}
          theme="github"
          readOnly
          onChange={() => {}}
          width="100%"
          maxLines={40}
          name={`${c}`}
          value={parameters[c] || ""}
          editorProps={{ $blockScrolling: true }}
        />
      </Fragment>
    ));
    return (
      <Fragment>
        {configuration_parameters}
      </Fragment>
    );
  }
}

export { CommitParameters };
