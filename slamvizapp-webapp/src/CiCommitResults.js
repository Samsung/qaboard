import React, { Component, Fragment } from "react";
import { withRouter } from "react-router";
import { Link } from "react-router-dom";
import { get, post, all } from "axios";
import queryString from "query-string";


import AceEditor from 'react-ace';
import { FormGroup, Switch, EditableText } from "@blueprintjs/core";
import { Tooltip, Callout, Icon, Card, NonIdealState, Spinner, Tab, Tabs, Intent } from "@blueprintjs/core";
import { Button, Tag, InputGroup } from "@blueprintjs/core";
import { Toaster } from "@blueprintjs/core";

import Avatar from "./Avatar";
// import List from 'react-virtualized'

import { Container, Section } from "./Common";
import { OutputCard } from "./OutputCard";
import { DoneAtTag } from "./DoneAtTag";
import { MetricsSummary } from "./Metrics";
import { TableCompare, TableKpi } from "./Tables";
import { TuningExploration } from "./TuningExploration";

/*eslint-disable no-alert, no-console */
import brace from 'brace'; // eslint-disable-line no-unused-vars
import 'brace/mode/json';
import 'brace/mode/yaml';
import 'brace/theme/github';
import 'brace/ext/searchbox';
// import 'brace/mode/diff';
// import 'brace/ext/language_tools';

export const OurToaster = Toaster.create();
// https://github.com/securingsincity/react-ace/blob/master/docs/Ace.md5



class AddRecordings extends Component {
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


class Tuning extends Component {
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
      <Button disabled={this.state.submitted} type='submit' intent={total_runs < 1000 ? Intent.PRIMARY : Intent.DANGER}>Send</Button>
  
    </form>)
  }

}


class CommitLogs extends Component {
  constructor(props) {
    super(props);
    this.state = {
      isLoaded: true,
      error: null,
      logs_lsf: null,
    };
  }

  componentDidMount() {
    this.getLogs()
  }

  getLogs() {
   get(`${this.props.commit.commit_dir_url}/lsf.log`)
    .then(response => {
      this.setState({
        isLoaded: true,
        logs_lsf: response.data
      })
    })
    .catch( error => {
      this.setState({isLoaded: true, error})
    })
  }

  render() {
    const { isLoaded, error, logs_lsf } = this.state;
    if (!isLoaded)
      return <Spinner />
    if (error)
      return <NonIdealState title="An error occurred" description={JSON.stringify(error.response)}/>
    return <AceEditor
      mode="text"
      theme="github"
      readOnly
      onChange={()=>{}}
      width='100%'
      name="logs-lsf"
      value={logs_lsf || ''}
      editorProps={{$blockScrolling: true}}
    />    
  }
}



var configurations = ['params', 'mono_mode'];
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
     configurations.forEach( c=> {
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
    let configuration_parameters = configurations.map( c =>
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



class CiCommitResults extends Component {
  constructor(props) {
    super(props);
    this.state = {
      new_commit_id: null, // current commit to display
      ref_commit_id: null, // reference commit to display

      commits: { // store of commit information
        'default': {isLoaded: false}
      },

      selected_batch_new: 'default',
      selected_batch_ref: 'default',

      filter_values: '',
      sort_by: 'translation_aape',
      order: -1,

      show_videos: false,
      show_3d: false,
      show_debug: false,

      commit_logs: {},
    };
  }

  updateState() {
    const params = new URLSearchParams(this.props.location.search);
    const new_commit_id = params.get('commit_folder') || this.props.match.params[0]
    const ref_commit_id = this.state.ref_commit_id || params.get('reference') || params.get('commit_ref_folder') || 'default';
    this.setState((previous_state, props) => {
      return {
        new_commit_id,
        ref_commit_id,
        commits: {
          ...previous_state.commits,
          [new_commit_id]:{isLoaded:false},
          [ref_commit_id]:{isLoaded:false},
        }
      }
    });
    this.getCiCommit(new_commit_id, 'new_commit_id');
    this.getCiCommit(ref_commit_id, 'ref_commit_id');
  }

  componentDidMount() {
    this.updateState();
  }

  componentWillUnmount() {
  }


  componentWillReceiveProps(nextProps) {
    if (this.props.match.url !== nextProps.match.url) {
      this.updateState();
    }
  }

  getCiCommit(commit_id, to_update) {
    // the API defaults to the latest commit on develop
    // we want to use this default 
    let query = commit_id==='default' ? '' : `/${commit_id}`;
    get(`/api/v1/commit${query}`, {params: {}})
      .then(response => {
        // we want to keep updated
        // we could use setInterval and update the reference but it makes the logic more complicated...
        if (to_update ==='new_commit_id')
          setTimeout(x=>this.getCiCommit(response.data.id, to_update), 60*1000)

        if (to_update ==='ref_commit_id') {
          let query = queryString.parse(this.props.location.search)
          if (query.reference && query.reference!==response.data.id) {
            this.props.history.push({
              pathname: this.props.location.pathname,
              search: queryString.stringify({...query, reference: response.data.id})
            })
          }
        }
        this.setState( (previous_state, props) => { 
          return {
          [to_update]: response.data.id,
          commits: {
            ...previous_state.commits,
            [response.data.id]: {
              data: response.data,
              isLoaded: true,
            }
          }
        }
        });
      })
      .catch(error => {
        this.setState( (previous_state, props) => {
          return {
            commits: {
              ...previous_state.commits,
              [commit_id]: {
                isLoaded: true,
              }
            }
          }
        });
        if (error.response) {
          this.setState( (previous_state, props) => {
            return {
              commits: {
                ...this.state.commits,
                [commit_id]: {
                  isLoaded: true,
                  error: error.response.data.error,
                }
              }
            }
          });
          // The request was made and the server responded with a status code
          // that falls out of the range of 2xx
          console.log(error.response.data);
          console.log(error.response.status);
          console.log(error.response.headers);
        } else if (error.request) {
          // The request was made but no response was received
          // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
          // http.ClientRequest in node.js
          console.log(error.request);
        } else {
          // Something happened in setting up the request that triggered an Error
          console.log("Error", error.message);
        }
        console.log(error.config);
      });
  }


  handleSubmitReference = (new_ref_commit_id) => {
    const { commits, ref_commit_id } = this.state;
    let is_git = commits[ref_commit_id].data.type==='git';
     // console.log(new_ref_commit_id.substring(0,8))
    // console.log(ref_commit_id.substring(0,8))
    if (
      ( is_git && new_ref_commit_id.substring(0,8) !== ref_commit_id.substring(0,8)) || 
      (!is_git && new_ref_commit_id !== ref_commit_id) ) {
      let query = queryString.parse(this.props.location.search);
      this.props.history.push({
        pathname: this.props.location.pathname,
        search: queryString.stringify({...query, reference: new_ref_commit_id})
      })
      this.setState( (previous_state, props) => {
        return {
          ref_commit_id: new_ref_commit_id,
          commits: {
            ...this.state.commits,
            [new_ref_commit_id]:{isLoaded:false},
          }
        }
      }, this.updateState);      
    }
  }

  filter_batch = batch => {
    const { filter_values } = this.state;
    if (filter_values.length===0)
      return batch;
    let filter_tokens = filter_values.split(' ');

    let batch_filtered = Object.create(batch)
    batch_filtered.slam_outputs = {}
    Object.entries(batch.slam_outputs).forEach( ([id, output])=> {
      let extra_parameters_s = Object.keys(output.extra_parameters).length>0 ? JSON.stringify(output.extra_parameters) : '';
      let extra_parameters = extra_parameters_s.replace(/"/g, '');
      let searched = `${output.recording_path} ${output.platform} ${output.configuration} ${extra_parameters}`.toLowerCase()
      let found = false;
      for (var i in filter_tokens) {
        let search = filter_tokens[i]
                     .toLowerCase()
                     .replace(/"/g, '')
                     .replace(/=+/g, ':');
        if (searched.includes(search)) {
          found=true;
          break
        }    
      }
      if (found)
        batch_filtered.slam_outputs[id] = output;      
    });
    return batch_filtered;
  }

  selectSortBy = e => {
    this.setState({sort_by: e.target.value})
  }
  selectOrder = e => {
    this.setState({order: e.target.value})
  }

  selectBatchNew = e => {
    this.setState({selected_batch_new: e.target.value})
  }

  selectBatchRef = e => {
    this.setState({selected_batch_ref: e.target.value})
  }

  toogleShowDebug = () => {
    let previous_value = this.state.show_debug;
    this.setState({
      show_debug: !previous_value,
    })
  }

  toogleShowVideos = () => {
    let previous_value = this.state.show_videos;
    this.setState({
      show_videos: !previous_value,
    })
  }

  toogleShow3d = () => {
    let previous_value = this.state.show_3d;
    this.setState({
      show_3d: !previous_value,
    })
  }

  sortOutputs = ([ka,a], [kb,b]) => {
    const { sort_by } = this.state;
    if (a[sort_by] > b[sort_by]) {
      return this.state.order;
    }
    if (a[sort_by] < b[sort_by]) {
      return -this.state.order;
    }
    // TODO: we may want to sort also by extra_parameters
    // the code below won't sort correctly numbers (5 vs 55)...
    // return JSON.stringify(a.extra_parameters) < JSON.stringify(b.extra_parameters);
    return 0;
  }

  render() {
    // console.log(this.state);
    var { commits, new_commit_id, ref_commit_id, selected_batch_new, selected_batch_ref } = this.state;

    if (!new_commit_id || !new_commit_id)
      return (
        <Container>
          <Section>
            <NonIdealState
              title="No commit selected"
              description="Please first select a commit."
              visual="pt-icon-folder-open"
            />
          </Section>
        </Container>)

    var new_commit_ = commits[new_commit_id];
    var ref_commit_ = commits[ref_commit_id];

    var warning_messages;
    if (new_commit_.error || ref_commit_.error) {
      var error_description = <span>
        {new_commit_.error && <span><strong>{new_commit_id}:</strong> {new_commit_.error}</span>}
        {new_commit_.error && ref_commit_.error && <br/>}
        {ref_commit_.error && <span><strong>{ref_commit_id}:</strong> {ref_commit_.error}</span>}
      </span>
      warning_messages = (
        <Section>
          <NonIdealState
            title="Network Error"
            description={error_description} visual="pt-icon-error"
          />
        </Section>)
    }

    if (!new_commit_.isLoaded || !ref_commit_.isLoaded)
      warning_messages = (
          <Section>
            <NonIdealState
              title="Loading"
              visual={<Spinner/>}
            />
          </Section>)

    var new_commit = new_commit_.data;
    var ref_commit = ref_commit_.data;

    if (new_commit===undefined || ref_commit===undefined || new_commit.batches[selected_batch_new]===undefined || ref_commit.batches[selected_batch_ref]===undefined)
      return <Container>{warning_messages}</Container>

    let status_messages = (
      <Section>
       {new_commit.batches[selected_batch_new].pending_slam_outputs>0 &&
          <Callout
            icon="info-sign"
            intent={Intent.WARNING}
            title={
              <Tooltip>
              <span>Still waiting for {new_commit.batches[selected_batch_new].pending_slam_outputs} result{new_commit.batches[selected_batch_new].pending_slam_outputs>1 ? 's' : ''}</span>
              <ul>{Object.values(new_commit.batches[selected_batch_new].slam_outputs).filter(o=>o.is_pending===true).map(o=><li key={o}>{o.recording_path} {Object.keys(o.extra_parameters).length>0 ? JSON.stringify(o.extra_parameters) : ''}<br/>@{o.configuration} on {o.platform}</li>)}</ul>
              </Tooltip>
          }>
          </Callout>}
       {new_commit.batches[selected_batch_new].failed_slam_outputs>0 &&
          <Callout
            icon="error"
            intent={Intent.DANGER}
            title={
              <Tooltip>
                <span>{new_commit.batches[selected_batch_new].failed_slam_outputs} crashed in this commit</span>
                <ul>{Object.values(new_commit.batches[selected_batch_new].slam_outputs).filter(o=>o.is_failed===true).map(o=><li key={o}>{o.recording_path}<br/>@{o.configuration} on {o.platform}</li>)}</ul>
              </Tooltip>
            }>
            <p>Maybe the <a href={`${new_commit.commit_dir_url}/lsf.log`}>LSF logs</a> can help debug this.
            <br/>Consider running the <a href="http://gitlab-srv/dvs/psp_swip/pipelines"><code>debug</code></a> manual CI job, or adding <a href="http://gitlab-srv/dvs/psp_swip/blob/develop/CMakeLists.txt#L43">instrumentation flags</a> for the compiler.</p>
          </Callout>}
      </Section>
    );

    let new_batch_filtered = this.filter_batch(new_commit.batches[selected_batch_new])
    let ref_batch_filtered = this.filter_batch(ref_commit.batches[selected_batch_ref])

    let compare_cross_runtype= new_commit.type==='local' && ref_commit.type==='git';

    var result = (
      <Container>
        {warning_messages}
        <CommitCompareCard new_commit={new_commit} ref_commit={ref_commit} onConfirmReference={this.handleSubmitReference}/>

        { new_commit!==undefined && ref_commit!==undefined && <Fragment>

        <Section>
          <Card elevation={0}>
            {Object.values(new_commit.batches).length>1 && <FormGroup label="You can view results from different tuning experiments" labelFor="batch-select" helperText="The CI results use the default parameters.">
              <div className="pt-select pt-minimal">
                <select id='batch-select' defaultValue="default" onChange={this.selectBatchNew}>
                  {Object.keys(new_commit.batches).map( label=> <option key={label} value={label}>{label==='default' ? 'CI results' : label} • {Object.keys(new_commit.batches[label].slam_outputs).length} outputs</option>)}
                </select>
              </div>
            </FormGroup>}
            <FormGroup label="Filter results" labelFor="batch-select" helperText={`All the data on this page will update. (${Object.keys(new_batch_filtered.slam_outputs).length} selected)`}>
              <InputGroup
                value={this.state.filter_values}
                placeholder="Recording, platform, configuration, or tuning parameters (key:value)"
                onChange={e => this.setState({ filter_values: e.target.value })}
                type="search"
                leftIcon="search"
              />
            </FormGroup>
          </Card>
         </Section>

        {status_messages}

        <Section>
          <Card elevation={2}>
          <Tabs id="tabs-summary">
              <Tab id="metrics" title="Performance Summary" panel={<MetricsSummary new_batch={new_batch_filtered} ref_batch={ref_batch_filtered} compare_cross_runtype={compare_cross_runtype} />} />
              <Tab id="parameters" title="Parameters" panel={<CommitParameters new_commit={new_commit}/>} />
              <Tab id="logs" title="Logs" panel={<CommitLogs commit={new_commit}/>} />
              <Tab id="re-run" title="Add recordings" panel={<AddRecordings commit={new_commit} />} />
              <Tab id="tuning" title="Create tuning experiment" panel={<Tuning commit={new_commit} />} />
          </Tabs>
          </Card>
        </Section>

        <Section>
          <Tabs renderActiveTabPanelOnly id="tabs-outputs">
            <Tab
              id="output-table-compare"
              title="Improvement"
              panel={
                <TableCompare
                  output_sort={this.sortOutputs}
                  new_batch={new_batch_filtered}
                  ref_batch={ref_batch_filtered}
                  compare_cross_runtype={compare_cross_runtype}
                />}
              />
            <Tab
              id="output-table-kpi"
              title="KPI report"
              panel={
                <TableKpi
                  output_sort={this.sortOutputs}
                  new_batch={new_batch_filtered}
                  ref_batch={ref_batch_filtered}
                  compare_cross_runtype={compare_cross_runtype}
                />}
              />
            <Tab
              id="output-list"
              title="6DoF Details"
              panel={
                <OutputList
                  output_sort={this.sortOutputs}
                  new_batch={new_batch_filtered}
                  ref_batch={ref_batch_filtered}
                  show_videos={this.state.show_videos}
                  show_3d={this.state.show_3d}
                  show_debug={this.state.show_debug}
                  compare_cross_runtype={compare_cross_runtype}
                />}
              />
            <Tab
              id="tuning-results"
              title="Tuning exploration"
              panel={
                <TuningExploration batch={new_batch_filtered}/>}
              />
            <Tabs.Expander />
            <Switch checked={this.state.show_debug} label="Debug" onChange={this.toogleShowDebug} />
            <Switch checked={this.state.show_videos} label="Videos" onChange={this.toogleShowVideos} />
            <Switch checked={this.state.show_3d} label="3d" onChange={this.toogleShow3d} />
            <div className="pt-select">
              <select defaultValue="translation_aape" onChange={this.selectSortBy}>
                <option value="translation_aape">Sort by AAPE</option>
                <option value="recording_path">Sort by recording path</option>
                <option value="rotation_mean">Sort by mean rotation error</option>
              </select>
              <select defaultValue="descending" onChange={this.selectOrder}>
                <option value={-1}>descending</option>
                <option value={1}>ascending</option>
              </select>
            </div>
          </Tabs>
        </Section>
        </Fragment>}

      </Container>
    );
    // <form onSubmit={this.handleReferenceSubmit}><input onChange={this.handleReferenceChange} className="pt-input" type="text" placeholder="Compare to a different commit..." /></form>
    return result;
  }
}


const CommitCompareCard = ({new_commit, ref_commit, onConfirmReference}) => {
  const empty_batch = {failed_slam_outputs: 0, valid_slam_outputs: 0, pending_slam_outputs: 0};
  let new_ci_batch = new_commit.batches.default || empty_batch;
  let ref_ci_batch = ref_commit.batches.default || empty_batch;
  return <Section>
    <Card elevation={4}>
      <div style={{display:'flex', justifyContent: 'space-between', alignItems: 'center'}}>
        <div style={{flex:'1 1 auto', minWidth: '450px'}}>
          <h1 style={{display: 'flex', alignItems: 'baseline'}}><Avatar href={`/committer/${new_commit.committer_name}`} alt={new_commit.committer_name} src={new_commit.committer_avatar_url} />{new_commit.type==='git' ? new_commit.id.substring(0,8) : new_commit.id} </h1>
            <Link to={`/branch/${new_commit.branch}`}><Button icon="git-branch">{new_commit.branch}</Button></Link><Icon icon='git-commit'/> {new_commit.parents.length>1 ? 'parents' : 'parent'}: {new_commit.parents.map(p => <Button key={p} onClick={e=>{console.log(p); onConfirmReference(p)}}>{p.substring(0,8)}</Button>)}
            <br/>
            <div style={{marginTop: '10px'}}><DoneAtTag commit={new_commit} /> <Tag>{new_ci_batch.valid_slam_outputs} outputs @CI</Tag> {new_ci_batch.failed_slam_outputs>0 && <Tag intent={Intent.DANGER}>{new_ci_batch.failed_slam_outputs} crashed @CI</Tag>} {new_ci_batch.pending_slam_outputs>0 && <Tag intent={Intent.WARNING}>{new_ci_batch.pending_slam_outputs} pending @CI</Tag>} <Tag intent={Intent.WARNING}>New</Tag></div>
            <p style={{marginTop: '10px', maxWidth:'450px'}} className="pt-monospace-text">{new_commit.message}</p>
          </div>
        <div style={{minWidth: '40px', textAlign: 'center'}}><Icon icon="small-cross"></Icon></div>
        <div style={{flex:'1 1 auto'}}>
            <h1 style={{display: 'flex', justifyContent: 'flex-end', alignItems: 'baseline'}}><EditableText style={{flex: '1 1 auto', margin:'auto', borderBottom: '2px solid rgb(100,100,100)'}} onConfirm={onConfirmReference} intent={Intent.PRIMARY} defaultValue={ref_commit.type==='git' ? ref_commit.id.substring(0,8) : ref_commit.id} /><Avatar href={`/committer/${ref_commit.committer_name}`} alt={ref_commit.committer_name} src={ref_commit.committer_avatar_url} /></h1>
            <span style={{display: 'flex', justifyContent: 'flex-end'}}><Link to={`/branch/${ref_commit.branch}`}><Button style={{flex: '1 1 auto', margin:'auto'}} icon="git-branch">{ref_commit.branch}</Button></Link></span>
            <div style={{marginTop: '10px', textAlign: 'right'}}><DoneAtTag commit={ref_commit} /> <Tag>{ref_ci_batch.valid_slam_outputs} outputs @CI</Tag> {ref_ci_batch.failed_slam_outputs>0 && <Tag intent={Intent.DANGER}>{ref_ci_batch.failed_slam_outputs} crashed @CI</Tag>} {ref_ci_batch.pending_slam_outputs>0 && <Tag intent={Intent.WARNING}>{ref_ci_batch.pending_slam_outputs} pending @CI</Tag>} <Tag intent={Intent.PRIMARY}>Reference</Tag></div>
            <p style={{display: 'flex', justifyContent: 'flex-end', textAlign: 'right', marginTop: '10px'}} className="pt-monospace-text">{ref_commit.message}</p>
        </div>
      </div>
    </Card>
  </Section>
}

class OutputList extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      select_debug: '',
    };
  }

  render() {
    const { new_batch, ref_batch, output_sort, compare_cross_runtype } = this.props;
    const { show_debug, show_videos, show_3d } = this.props;
    // FIXME: workaround to compare local commits versus git-ci commits
    // https://github.com/bvaughn/react-virtualized/blob/master/docs/List.md
    return <Fragment>
            {show_debug && <FormGroup
                              label="Show debug outputs matching"
                              labelFor="show-debug-input"
                              helperText="Separate the debug outputs by spaces."
                              style={{'marginBottom': '30px'}}
                            >
                              <InputGroup
                                value={this.state.select_debug_input}
                                placeholder="ransac points"
                                onChange={e => this.setState({ select_debug: e.target.value })}
                                leftIcon="series-add"
                                style={{width: '300px'}}
                              />
                            </FormGroup>}
            <div style={{display:'flex', justifyContent: 'space-between', flexFlow: 'row wrap'}}>
              {Object.entries(new_batch.slam_outputs)
                     .sort(output_sort)
                     .map( ([id, output]) => {
                        // we need to find a matching output - by path name for now...
                        // ideally we'd split the list of outputs by recording name and not id, 
                        // and display lsf/s8 curves serparately,,,
                        let matching_ref_outputs = Object.values(ref_batch.slam_outputs)
                          .filter(o => o.recording_path===output.recording_path)
                          .filter(o => o.platform===output.platform || compare_cross_runtype)
                          .filter(o => o.configuration===output.configuration || compare_cross_runtype)
                        let output_ref = matching_ref_outputs[0];
                        return <OutputCard
                          key={id}
                          output_new={output}
                          output_ref={output_ref}
                          show_debug={show_debug}
                          select_debug={this.state.select_debug}
                          show_videos={show_videos}
                          show_3d={show_3d}
                        />;
              })}
            </div>
           </Fragment>

  }
}



export default withRouter(CiCommitResults);
