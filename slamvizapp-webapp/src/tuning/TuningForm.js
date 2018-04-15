import React, { Component } from "react";
import { get, post } from "axios";
import AceEditor from 'react-ace';

/*eslint-disable no-alert, no-console */
import brace from 'brace'; // eslint-disable-line no-unused-vars
import 'brace/mode/json';
import 'brace/mode/yaml';
import 'brace/theme/github';
import 'brace/ext/searchbox';
// import 'brace/mode/diff';
// import 'brace/ext/language_tools';

import { Callout, Intent, Spinner, NonIdealState, Button, FormGroup } from "@blueprintjs/core";
import { Toaster } from "@blueprintjs/core";



export const OurToaster = Toaster.create();

class AddRecordingsForm extends Component {
  constructor(props) {
    super(props);
    this.state = {
      isLoaded: true,
      error: null,
      groups: null,

      submitted: false,
      overwrite: false,
      selected_group: null,
      selected_group_info: {
        number_of_recordings: 0,
      },
      selected_group_info_loading: false,
    };
  }

  componentDidMount() {
    this.getGroups()
  }

  getGroups() {
   get('/api/v1/recordings/groups')
    .then(response => {
      this.setState({
        isLoaded: true,
        groups: response.data,
      })
    })
    .catch( error => {
      this.setState({isLoaded: true, error})
    })
  }

  updateGroups = newGroups => {this.setState({groups: newGroups})}
  updateOverwrite = e => {this.setState({overwrite: e.target.checked? 'on' : 'off'})}
  updateSelectedGroup = e => {
    let next_selected_group = e.target.value;
    this.setState({selected_group: next_selected_group})
    get(`/api/v1/recordings/group?name=${next_selected_group}`, {})
    .then(response => {
      this.setState({selected_group_info_loading: false, selected_group_info: response.data})
    })
    .catch(error => {
      this.setState({selected_group_info_loading: false, selected_group_info: {number_of_recordings: 0}})
    })
  };

  onSubmit = e => {
    const { selected_group, overwrite, groups } = this.state;
    this.setState({submitted: true})
    OurToaster.show({ message: "The request was sent!", intent: Intent.PRIMARY});
    post(`/api/v1/commit/${this.props.commit.id}/batch`, {
      batch_label: 'default',
      platform: 'lsf', configuration: 'serial-stereo',
      tuning_search: {},
      selected_group, groups,
      overwrite,
    })
    .then(response => {
      this.setState({submitted: false})
      OurToaster.show({ message: "...Acknowledged!", intent: Intent.SUCCESS});
    })
    .catch( error => {
      this.setState({submitted: false})
      OurToaster.show({ message: `Something wrong happened ${JSON.stringify(error.response)}`, intent: Intent.DANGER});
    })
    e.preventDefault();
  }

  recomputeMetrics = e => {
    this.setState({submitted: true})
    OurToaster.show({ message: "The request was sent!", intent: Intent.PRIMARY});
    post(`/metrics/${this.props.commit.id}`)
    .then(response => {
      this.setState({submitted: false})
      OurToaster.show({ message: "Done!", intent: Intent.SUCCESS});
    })
    .catch( error => {
      this.setState({submitted: false})
      OurToaster.show({ message: "Something wrong happened", intent: Intent.DANGER});
    })    
  }

  render() {
    const { isLoaded, error, groups } = this.state;
    if (!isLoaded)
      return <Spinner />
    if (error)
      return <NonIdealState title="An error occurred" description={JSON.stringify(error.response)}/>
    let number_of_recordings = this.state.selected_group_info.number_of_recordings
    return (
    <form onSubmit={this.onSubmit}>
      <div className="pt-form-group pt-inline">
        <label className="pt-label" htmlFor="selected-group">
          Requested Group
          <span className="pt-text-muted">(optionnal)</span>
        </label>
        <div className="pt-form-content">
          <input onChange={this.updateSelectedGroup} id="selected-group" className="pt-input" style={{width: '300px'}} placeholder="Go_around_set" type="text" dir="auto" />
          <div className="pt-form-helper-text">{number_of_recordings===0 ? 'Select a group of recordings from the list below' : `${number_of_recordings} recording${number_of_recordings>1?'s':''} selected`}</div>
        </div>
        <label className="pt-label" htmlFor="overwrite-old-outputs"></label>
        <div className="pt-form-content">
          <label className="pt-control pt-switch">
            <input onChange={this.updateOverwrite} defaultValue='off' id="overwrite-old-outputs" type="checkbox" />
            <span className="pt-control-indicator"></span>
            Overwrite previous runs
          </label>
          <div className="pt-form-helper-text">By default we won't run the SLAM twice on the same recordings </div>
        </div>
        <Button onClick={this.recomputeMetrics} disabled={this.state.submitted} type='button'>Recompute metrics</Button>
        <Button disabled={this.state.submitted} type='submit' intent={Intent.PRIMARY} >Send</Button>
      </div>

      <div className="pt-form-group pt-inline">
      </div>
      <AceEditor
        mode="yaml"
        theme="github"
        onChange={this.updateGroups}
        width='100%'
        name="groups"
        value={groups || ''}
        editorProps={{$blockScrolling: true}}
        setOptions={{
          tabSize: 2,
        }}
      />    
    </form>)
  }

}



class TuningForm extends Component {
  constructor(props) {
    super(props);
    this.state = {
      submitted: false,
      experiment_name: '',
      configuration: 'serial-stereo',
      platform: 'lsf',
      selected_group: null,
      selected_group_info: {
        number_of_recordings: 0,
      },
      selected_group_info_loading: false,
      search_type: 'grid',
      search_options: {
        n_iter: 50,
      },
      parameter_search: `{\n  "events_per_frame": [5000, 10000, 15000, 20000, 25000, 30000, 35000, 40000, 45000, 50000]\n}\n`,
    };
  }

  updateExperimentName = e => {this.setState({experiment_name: e.target.value.replace(/\W/g, '-')})};
  updateConfiguration = e => {this.setState({configuration: e.target.value})};
  updateParameterSearch = new_parameter_search => {this.setState({parameter_search: new_parameter_search})};
  updateSelectedGroup = e => {
    let next_selected_group = e.target.value;
    this.setState({selected_group: next_selected_group})
    get(`/api/v1/recordings/group?name=${next_selected_group}`, {})
    .then(response => {
      this.setState({selected_group_info_loading: false, selected_group_info: response.data})
    })
    .catch(error => {
      this.setState({selected_group_info_loading: false, selected_group_info: {number_of_recordings: 0}})
    })
  };
  selectSearchType = e => {this.setState({search_type: e.target.value})};
  updateIterations = e => {this.setState({search_options: {'n_iter': parseFloat(e.target.value)}})};


  onSubmit = e => {
    const { experiment_name, platform, configuration, groups, selected_group } = this.state;
    const { parameter_search, search_type, search_options } = this.state;
    this.setState({ submitted: true })
    OurToaster.show({ message: "The tuning experiment was sent!", intent: Intent.PRIMARY});
    post(`/api/v1/commit/${this.props.commit.id}/batch`, {
      batch_label: experiment_name,
      platform, configuration,
      tuning_search: {
        search_type,
        search_options,
        parameter_search: JSON.parse(parameter_search),
      },
      selected_group, groups,
      overwrite: false,
    })
    .then(response => {
      this.setState({submitted: false})
      OurToaster.show({ message: "...Acknowledged!", intent: Intent.SUCCESS});
    })
    .catch( error => {
      this.setState({submitted: false})
      OurToaster.show({ message: `Something wrong happened ${JSON.stringify(error.response)}`, intent: Intent.DANGER});
    })
    e.preventDefault();
  }

  render() {
    let number_of_recordings = this.state.selected_group_info.number_of_recordings
    try {
      let parameter_search = JSON.parse(this.state.parameter_search);
      if (this.state.search_type === 'grid')
        var combinations = Object.values(parameter_search)
                                 .map( param_array => param_array.length )
                                 .reduce( (a,v)=>a*v , 1);
      else
        combinations = this.state.search_options.n_iter;
    } catch (e) {
      combinations = 'invalid';
    }
    let total_runs = combinations * number_of_recordings;
    let time_intent = combinations==='invalid' ? Intent.DANGER : (total_runs < 100 ? Intent.SUCCESS : (total_runs < 200 ? Intent.PRIMARY : Intent.WARNING));
    return (
    <form onSubmit={this.onSubmit}>
      <FormGroup
          helperText="It should be descriptive. Re-using a name will add more results to the experiment."
          label="Choose a name for the tuning experiment"
          labelFor="experiment-name"
          intent={Intent.PRIMARY}
          requiredLabel={true}
      >
          <input id="experiment-name" className="pt-input" style={{width: '300px'}} placeholder="search-radius-sensibility" value={this.state.experiment_name} onChange={this.updateExperimentName}  type="text" dir="auto" />
      </FormGroup>

      <FormGroup
          label="Run on each recording in this group"
          helperText={`${number_of_recordings > 0 ? number_of_recordings+' recordings. ' : ''}Choose a small group of recordings if you want results quickly.`}
          labelFor="selected-group"
          requiredLabel={true}
      >
          <input id="selected-group" className="pt-input" style={{width: '300px'}} placeholder="Loop_closure_set" onChange={this.updateSelectedGroup}  type="text" dir="auto" />
      </FormGroup>

      <FormGroup
          label="You can choose any of the available SLAM configuration"
          helperText='"stereo-serial" is the default. Configurations are saved as $configuration.json, e.g. "mono_mode".'
          labelFor="input-configuration"
          requiredLabel={true}
      >
          <input id="input-configuration" className="pt-input" style={{width: '300px'}} value={this.state.configuration} placeholder="stereo-serial" onChange={this.updateConfiguration}  type="text" dir="auto" />
      </FormGroup>

      <h3>Tuning search</h3>
      <FormGroup inline labelFor="select-search-type" helperText={this.state.search_type === 'grid' ? `Explores all the ${combinations} combinations` : `Uniform sampling of ${this.state.search_options.n_iter} combinations`}>
        <div className="pt-select pt-minimal">
          <select id='select-search-type' defaultValue='translation_aape' onChange={this.selectSearchType}>
            <option key="grid" value="grid">Grid search</option>
            <option key="sampler" value="sampler">Sampling</option>
          </select>
          {this.state.search_type === 'sampler' && <input id="input-iterations" value={this.state.search_options.n_iter} className="pt-input" style={{marginLeft:'30px', width: '70px'}} placeholder="50" onChange={this.updateIterations}  type="numeric" dir="auto" />}
        </div>
      </FormGroup>
      <AceEditor
        mode="json"
        theme="github"
        onChange={this.updateParameterSearch}
        width='100%'
        height='200px'
        name="editor-tuning-set"
        value={this.state.parameter_search}
        editorProps={{$blockScrolling: true}}
        setOptions={{
          tabSize: 2,
        }}
      />

      <Callout icon={this.state.selected_group_info_loading ? 'dot' : 'time' } intent={time_intent}>{total_runs} total runs</Callout>
      <Button disabled={this.state.submitted || this.state.experiment_name.length===0 || !total_runs} type='submit' intent={total_runs < 1000 ? Intent.PRIMARY : Intent.DANGER}>Send</Button>
  
    </form>)
  }

}

export { TuningForm, AddRecordingsForm };
