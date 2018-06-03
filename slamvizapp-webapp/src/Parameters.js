import React, { Component, Fragment } from "react";
import { get, all } from "axios";
import { Spinner, NonIdealState } from "@blueprintjs/core";

import { slam_configurations } from "./slam/configurations";

import AceEditor from 'react-ace';

/*eslint-disable no-alert, no-console */
import brace from 'brace'; // eslint-disable-line no-unused-vars
import 'brace/mode/json';
import 'brace/mode/yaml';
import 'brace/theme/github';
import 'brace/ext/searchbox';
// import 'brace/mode/diff';
// import 'brace/ext/language_tools';
// https://github.com/securingsincity/react-ace/blob/master/docs/Ace.md5




class CommitParameters extends Component {
  constructor(props) {
    super(props);
    this.state = {
      isLoaded: false,
      parameters: {},
    };
  }

  componentDidMount() {
    this.getParameters()
  }

  getParameters() {
   all([
     slam_configurations.forEach( c=> {
       get(`${this.props.new_commit.commit_dir_url}/${c}.json`,
           {transformResponse: response=>response}) // avoid json parsing
        .then(response => {
          let previous_parameters = this.state.parameters;
          this.setState({
            parameters: {...previous_parameters, [c]: response.data},
          })
        })
     })
   ])
   .then( () => this.setState({isLoaded: true}))
   .catch( error => {this.setState({isLoaded: true, error})})
  }

  render() {
    const { isLoaded, error, parameters } = this.state;

    if (!isLoaded) return <Spinner />
    if (error) return <NonIdealState title="An error occurred" description={JSON.stringify(error.response)}/>
    let configuration_parameters = slam_configurations.map( c =>
      <Fragment key={c}>
        <h4>{c}.json</h4>
        <AceEditor
          mode="json"
          theme="github"
          readOnly
          onChange={()=>{}}
          width='100%'
          maxLines={40}
          name={`${c}-json`}
          value={parameters[c] || ''}
          editorProps={{$blockScrolling: true}}
        />    
      </Fragment>
    )
    return <Fragment>
      {configuration_parameters}
      Adding more files is easy, talk to Arthur 
    </Fragment>
  }
}

export { CommitParameters };
