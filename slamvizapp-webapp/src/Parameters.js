import React, { Component, Fragment } from "react";
import { get, all } from "axios";
import { Spinner, NonIdealState } from "@blueprintjs/core";

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


// var project_qatools_config = (localStorage.project_qatools_config !==undefined && new Map(JSON.parse(localStorage.project_qatools_config))) || new Map([])
// // for projects build without qatools
// const default_qatools_config = {
//   artifacts: {
//     configurations: {
//       glob: '*.json'
//     }
//   }
// }
// const hardcoded_qatools_config = new Map([
//   ["dvs/psp_swip", default_qatools_config],
//   ["tof/swip_tof", default_qatools_config]
// ]);
// project_qatools_config = new Map([...hardcoded_qatools_config, ...project_qatools_config])

// get list of artifact files
// read them

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
      console.log(response.data)
      var configurations = []
      // to be user-friendly
      // we show at the top the base configuration
      response.data.forEach(c => {
        let is_base_configuration = (
          c.includes('params.json') ||
          c.includes('base.json') ||
          c.includes('default.json') ||
          c.includes('base.yaml') ||
          c.includes('default.yaml')
        )
        if (is_base_configuration) return;
        configurations.append(c)
      })
      response.data.forEach(c => {
        configurations.append(c)
      })
      this.setState({configurations}, this.getParameters)      
    })
  }

  componentDidMount() {
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

    if (!isLoaded) return <Spinner />;
    if (error)
      return (
        <NonIdealState
          title="An error occurred"
          description={JSON.stringify(error.response)}
        />
      );
    let configuration_parameters = this.state.configurations.map(c => (
      <Fragment key={c}>
        <h4>{c}</h4>
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
