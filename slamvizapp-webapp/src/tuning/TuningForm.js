import React, { Component } from "react";
import { get, post } from "axios";
import AceEditor from 'react-ace';
import { withCookies } from 'react-cookie';

/*eslint-disable no-alert, no-console */
import brace from 'brace'; // eslint-disable-line no-unused-vars
import 'brace/mode/json';
import 'brace/mode/javascript';
import 'brace/mode/yaml';
import 'brace/theme/github';
import 'brace/ext/searchbox';
// import 'brace/mode/diff';
// import 'brace/ext/language_tools';

import { Callout, Intent, Spinner, NonIdealState, Button, FormGroup, Radio, RadioGroup } from "@blueprintjs/core";
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
   get(`/api/v1/recordings/groups?project=${this.props.project}`, )
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
      project: this.props.project,
      batch_label: 'default',
      platform: 'lsf', configuration: 'serial-stereo',
      tuning_search: {},
      selected_group, groups,
      overwrite, android_device: 'openstf',
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
    post(`/metrics/${this.props.commit.id}?project=${this.props.project}`)
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
        {false && <label className="pt-label" htmlFor="selected-group">
          Requested Group
          <span className="pt-text-muted">(optionnal)</span>
        </label>}
        {false && <div className="pt-form-content">
          <input onChange={this.updateSelectedGroup} id="selected-group" className="pt-input" style={{width: '300px'}} placeholder="Go_around_set" type="text" dir="auto" />
          <div className="pt-form-helper-text">{number_of_recordings===0 ? 'Select a group of recordings from the list below' : `${number_of_recordings} recording${number_of_recordings>1?'s':''} selected`}</div>
        </div>}
        {false && <label className="pt-label" htmlFor="overwrite-old-outputs"></label>}
        {false && <div className="pt-form-content">
          <label className="pt-control pt-switch">
            <input onChange={this.updateOverwrite} defaultValue='off' id="overwrite-old-outputs" type="checkbox" />
            <span className="pt-control-indicator"></span>
            Overwrite previous runs
          </label>
          <div className="pt-form-helper-text">By default we won't run the SLAM twice on the same recordings </div>
        </div>}
        {false && <Button onClick={this.recomputeMetrics} disabled={this.state.submitted} type='button'>Recompute CI metrics</Button>}
        <Button disabled={this.state.submitted} type='submit' intent={Intent.PRIMARY} >{this.state.selected_group ? 'Run SLAM' : 'Update list'}</Button>
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



const wrap_values_in_array = object => {
  let output = {}
  Object.keys(object).forEach(key => {
   output[key] = wrap_in_array(object[key]);
  })
  return output;
}

const wrap_in_array = x => {
  if (Array.isArray(x)) return x;
  // the python backend expects *iterables*
  // so numeric values won't work, strings will be split, etc.
  // here we fix this unexpected behaviour
  // note: arrays are objects.
  if (typeof x !== "object") return [x];
  // note: the backend supports {type: "range", options: {from:0, to:100, step:1} }
  // for now we just ignore this
  return [];
}


const eval_function = text => {
  try {
    /*eslint-disable no-new-func */
    return Function(text)();
  } catch(e) {
    return null;
  }
}

const eval_combinations = param_search_text => {
  /*Parses a string describing a tuning set into an object.*/
  let output = null;
  // users can directly provide tuning sets via objects or arrays of objects
  try {
    output = JSON.parse(param_search_text)
  } catch (e) {
    // or they can provide a function that returns a tuning set
    output = eval_function(param_search_text)
  }
  if (Array.isArray(output)){
    return output.map(wrap_values_in_array)
  }
  else
    return wrap_values_in_array(output)
}

const grid_combinations = param_search => {
  if (param_search === null || param_search === undefined) return null
  if (Array.isArray(param_search))
    return param_search.map(search_set => grid_combinations(search_set) )
                       .reduce( (a,v) => a+v , 0);
  return Object.values(param_search)
               .map( param_array => param_array.length )
               .reduce( (a,v) => a*v , 1);
}


const tuning_templates = {
  none: '{}',
  basic: JSON.stringify({
    events_per_frame: [5e3, 10e3, 15e3, 20e3],
    'smart_frame_on': [0, 1],
  }, null, 2),
  list: JSON.stringify([
    {
      min_events_per_frame: 5e3,
      max_events_per_frame: 10e3,
    },
    {
      min_events_per_frame: 15e3,
      max_events_per_frame: 20e3,
    },
  ], null, 2),
  function: '// you use the output of any javascript function\nlet events = [10e3, 20e3, 30e3];\nlet delta = 5e3;\n\nreturn events.map(t => ({\n  min_events_per_frame: t,\n  max_events_per_frame: t + delta,\n  smart_frame_on: [0, 1],\n}));\n',
}


class TuningForm extends Component {
  constructor(props) {
    super(props);
    const { cookies } = this.props;
    this.state = {
      submitted: false,
      experiment_name: cookies.get('experiment_name') || '',
      platform: cookies.get('platform') || 'lsf',
      android_device: 'openstf',
      configuration: cookies.get('configuration') || 'serial-stereo',
      selected_group: cookies.get('selected_group') || '',
      selected_group_info: {
        number_of_recordings: 0,
      },
      selected_group_info_loading: false,
      search_type: 'grid',
      search_options: {
        n_iter: 50,
      },
      overwrite: false,
      user: 'arthurf',
      parameter_search: cookies.get('parameter_search', {doNotParse: true}) ? JSON.parse(cookies.get('parameter_search', {doNotParse: true})) : tuning_templates['none'],
    };
  }

  componentDidMount() {
    const { selected_group } = this.state;
    if (selected_group)
      this.getGroupInfo(selected_group);
  }
  getGroupInfo(group) {
    get(`/api/v1/recordings/group?project=${this.props.project}&name=${group}`, {})
    .then(response => {
      this.setState({selected_group_info_loading: false, selected_group_info: response.data})
    })
    .catch(error => {
      this.setState({selected_group_info_loading: false, selected_group_info: {number_of_recordings: 0}})
    })
  }
  updateSelectedGroup = e => {
    const { cookies } = this.props;
    let next_selected_group = e.target.value;
    cookies.set('selected_group', next_selected_group, { path: '/' });
    this.setState({selected_group: next_selected_group})
    this.getGroupInfo(next_selected_group);
  };
  updateExperimentName = e => {
    const { cookies } = this.props;
    cookies.set('experiment_name', e.target.value, { path: '/' });
    this.setState({experiment_name: e.target.value.replace(/[^\w_.@:=]/g, '-')})
  };
  updateAndroidDevice = e => {
    const { cookies } = this.props;
    cookies.set('android_device', e.target.value, { path: '/' });
    this.setState({android_device: e.target.value})
  };
  updateConfiguration = e => {
    const { cookies } = this.props;
    cookies.set('configuration', e.target.value, { path: '/' });
    this.setState({configuration: e.target.value})
  };
  updateUser = e => {
    const { cookies } = this.props;
    cookies.set('user', e.target.value, { path: '/' });
    this.setState({user: e.target.value})
  };
  updatePlatform = e => {
    const { cookies } = this.props;
    this.setState({platform: e.target.value})
    cookies.set('platform', e.target.value, { path: '/' });
    if (e.target.value==='s8') {
      this.setState({configuration: 'parallel-stereo'})
      cookies.set('configuration', 'parallel-stereo', { path: '/' });
    }
    if (e.target.value==='lsf' && this.state.configuration==='parallel-stereo') {
      this.setState({configuration: 'serial-stereo'})
      cookies.set('configuration', 'serial-stereo', { path: '/' });
    }
  };
  updateOverwrite = e => {this.setState({overwrite: e.target.checked? 'on' : 'off'})}
  updateParameterSearch = new_parameter_search => {
    const { cookies } = this.props;
    cookies.set('parameter_search', JSON.stringify(new_parameter_search), { path: '/' });
    this.setState({parameter_search: new_parameter_search})
  };

  selectSearchType = e => {this.setState({search_type: e.target.value})};
  updateIterations = e => {this.setState({search_options: {'n_iter': parseFloat(e.target.value)}})};


  onSubmit = e => {
    const { experiment_name, platform, android_device, configuration, groups, selected_group, overwrite, user } = this.state;
    const { parameter_search, search_type, search_options } = this.state;
    this.setState({ submitted: true })
    OurToaster.show({ message: "The tuning experiment was sent!", intent: Intent.PRIMARY});
    post(`/api/v1/commit/${this.props.commit.id}/batch`, {
      project: this.props.project,
      batch_label: experiment_name,
      platform, configuration,
      tuning_search: {
        search_type,
        search_options,
        parameter_search: eval_combinations(parameter_search),
      },
      selected_group, groups,
      user,
      android_device,
      overwrite: overwrite,
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
    const { platform, android_device, configuration, selected_group, selected_group_info, experiment_name, user } = this.state;
    const { search_type, parameter_search, search_options } = this.state;
    let number_of_recordings = selected_group_info.number_of_recordings
    try {
      var tuning_sets = eval_combinations(parameter_search);
      var combinations = grid_combinations(tuning_sets);
      if (combinations === null)
        combinations = 'invalid';
      else
        combinations = search_type === 'grid' ? combinations : Math.min(search_options.n_iter, combinations);
    } catch (e) {
      combinations = 'invalid';
    }
    let total_runs = combinations * number_of_recordings;
    let time_intent = combinations==='invalid' ? Intent.DANGER : (total_runs < 100 ? Intent.SUCCESS : (total_runs < 200 ? Intent.PRIMARY : Intent.WARNING));
    return (
    <form onSubmit={this.onSubmit}>
      <FormGroup
          helperText={<span>Re-using a name adds more results. The <code>default</code> batch corresponds to the CI results</span>}
          label="Choose a name for the batch/tuning experiment"
          labelFor="batch-label"
          intent={Intent.PRIMARY}
          requiredLabel={true}
      >
          <input id="batch-label" className="pt-input" style={{width: '300px'}} placeholder="search-radius-sensibility" value={experiment_name} onChange={this.updateExperimentName}  type="text" dir="auto" />
      </FormGroup>

      <FormGroup
          label="Run on each recording in this group"
          helperText={`${number_of_recordings > 0 ? number_of_recordings+' recordings. ' : ''}Choose a small group of recordings if you want results quickly.`}
          labelFor="selected-group"
          requiredLabel={true}
      >
          <input id="selected-group" className="pt-input" style={{width: '300px'}} placeholder="Loop_closure_set" onChange={this.updateSelectedGroup} value={selected_group} type="text" dir="auto" />
      </FormGroup>

      <RadioGroup
          // label=""
          // helperText={<span><strong>lsf</strong> is the default. <strong>s8</strong> is </span>}
          onChange={this.updatePlatform}
          selectedValue={platform}
      >

          <Radio labelElement={<span>Linux</span>} value="lsf" large/>
          <Radio label={<span>Android<br/>
                              <span className="pt-text-muted">
                                Available on <code>develop</code> or if you ran the <a href="http://gitlab-srv/dvs/psp_swip/pipelines"><code>performance:android:manual</code> job</a>
                              </span></span>} value="s8" large/>
      </RadioGroup>

      {platform==='s8' && <FormGroup
          label="Android device"
          helperText='Choose a device from the openstf farm, or your own (host:port)'
          labelFor="input-android-device"
          requiredLabel={true}
      >
          <input id="input-android-device" className="pt-input" style={{width: '300px'}} value={android_device} placeholder="openstf" onChange={this.updateAndroidDevice}  type="text" dir="auto" />
      </FormGroup>}

      <FormGroup
          label="You can choose any of the available SLAM configuration"
          helperText='"stereo-serial" is the default. Configurations are saved as $configuration.json, e.g. "mono_mode".'
          labelFor="input-configuration"
          requiredLabel={true}
      >
          <input id="input-configuration" className="pt-input" style={{width: '300px'}} value={configuration} placeholder="stereo-serial" onChange={this.updateConfiguration}  type="text" dir="auto" />
      </FormGroup>

      <h3>Tuning search</h3>
      <p>Be inspired by those tuning templates: {['basic', 'list', 'function'].map(x => 
       <Button key={x} onClick={e=>this.setState({parameter_search: tuning_templates[x]})}>{x}</Button> 
      )}</p>
      <FormGroup inline labelFor="select-search-type" helperText={search_type === 'grid' ? `Explores all the ${combinations} combination${combinations>1 ? 's' : ''}` : `Uniform sampling of ${combinations} combinations`}>
        <div className="pt-select pt-minimal">
          <select id='select-search-type' defaultValue='grid' onChange={this.selectSearchType}>
            <option key="grid" value="grid">Grid search</option>
            <option key="sampler" value="sampler">Sampling</option>
          </select>
          {search_type === 'sampler' && <input id="input-iterations" value={search_options.n_iter} className="pt-input" style={{marginLeft:'30px', width: '70px'}} placeholder="50" onChange={this.updateIterations}  type="numeric" dir="auto" />}
        </div>
      </FormGroup>
      <AceEditor
        mode="javascript"
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
  
      <label className="pt-label" htmlFor="overwrite-old-outputs"></label>
      <div className="pt-form-content">
        <label className="pt-control pt-switch">
          <input onChange={this.updateOverwrite} defaultValue='off' id="overwrite-old-outputs" type="checkbox" />
          <span className="pt-control-indicator"></span>
          Overwrite previous runs if already computed.
        </label>
      </div>

      <FormGroup
          label="Run as"
          helperText='Be nice.'
          labelFor="input-user"
          inline
      >
          <input disabled id="input-user" className="pt-input" style={{width: '300px'}} value={user} placeholder="arthurf" onChange={this.updateUser}  type="text" dir="auto" />
      </FormGroup>

    </form>)
  }

}

const TuningForm_ = withCookies(TuningForm)
export { TuningForm_ as TuningForm, AddRecordingsForm };
