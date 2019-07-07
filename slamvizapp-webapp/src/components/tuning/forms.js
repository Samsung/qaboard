import React, { Component } from "react";
import { connect } from 'react-redux'
import { get, post } from "axios";

import { updateTuningForm } from "../../actions/tuning";

import MonacoEditor from 'react-monaco-editor';

import {
  Classes,
  Callout,
  Intent,
  Button,
  FormGroup,
  HTMLSelect,
  Radio,
  RadioGroup,
  Switch,
  Tag,
  Toaster,
  Tooltip,
  Icon,
} from "@blueprintjs/core";

import templates from './templates'
export const toaster = Toaster.create();


const editor_options = {
  selectOnLineNumbers: true,
  seedSearchStringFromSelection: true,
  //renderSideBySide: false
};


const wrap_values_in_array = object => {
  let output = {};
  Object.keys(object).forEach(key => {
    output[key] = wrap_in_array(object[key]);
  });
  return output;
};

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
};

const eval_function = text => {
  try {
    /*eslint-disable no-new-func */
    return Function(text)();
  } catch (e) {
    return null;
  }
};

const eval_combinations = param_search_text => {
  /*Parses a string describing a tuning set into an object.*/
  if (param_search_text === '') return {combinations: {}, language: 'javascript'};

  let combinations = null;
  // users can directly provide tuning sets via objects or arrays of objects
  try {
    combinations = JSON.parse(param_search_text);
    var language = "yaml" // no json support out of the box, yaml is superset so..
  } catch (e) {
    // or they can provide a function that returns a tuning set
    combinations = eval_function(param_search_text);
    language = "javascript"
  }
  if (Array.isArray(combinations)) {
    combinations = combinations.map(wrap_values_in_array);
  } else {
    combinations = wrap_values_in_array(combinations)
  };
  return {combinations, language}
};

const grid_combinations = param_search => {
  if (param_search === null || param_search === undefined) return null;
  if (Array.isArray(param_search))
    return param_search
      .map(search_set => grid_combinations(search_set))
      .reduce((a, v) => a + v, 0);
  return Object.values(param_search)
    .map(param_array => param_array.length)
    .reduce((a, v) => a * v, 1);
};


class TuningForm extends Component {
  constructor(props) {
    super(props);
    let qatools_config = ((this.props.project_data || {}).data || {}).qatools_config || {}
    let default_user = this.props.user || (qatools_config.lsf || {}).user || 'arthurf';
    this.state = {
      submitted: false,
      experiment_name: this.props.experiment_name || "",
      platform: this.props.platform || "lsf",
      overwrite: false,

      selected_group: this.props.selected_group || "",
      selected_group_info: {
        number_of_tests: 0
      },
      selected_group_info_loading: false,

      search_type: this.props.search_type || "grid",
      search_options: {
        n_iter: 50
      },
      parameter_search: this.props.parameter_search ? JSON.parse(this.props.parameter_search) : templates["default"],
      parameter_search_auto: this.props.parameter_search_auto
        ? JSON.parse(this.props.parameter_search_auto)
        : templates['optimize'](qatools_config, this.props.project_data.data.qatools_metrics),

      user: this.props.user || default_user,
      android_device: "openstf",

    };
  }

  componentDidMount() {
    const { selected_group } = this.state;
    if (selected_group) this.getGroupInfo(selected_group);

    // we used to store large cookies... no more
    // FIXME: remove this code we everyone has run it once :)    
    document.cookie.split(";").forEach(function(c) { document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/"); });
  }

  componentDidUpdate(prevProps, prevState) {
    const { selected_group } = this.state;
    const has_commit = this.props.commit !== undefined && this.props.commit !== null;
    let updated_commit = has_commit && (prevProps.commit === null || prevProps.commit === undefined || prevProps.commit.id !== this.props.commit.id);
    if (updated_commit && selected_group) this.getGroupInfo(selected_group);
  }

  getGroupInfo(group) {
  	const commit_part = !!this.props.commit ? `&commit=${this.props.commit.id}` : '';
  	this.setState({selected_group_info_loading: true})
    get(`/api/v1/tests/group?project=${this.props.project}&name=${group}${commit_part}`, {})
      .then(response => {
        this.setState({
          selected_group_info_loading: false,
          selected_group_info: response.data
        });
      })
      .catch(error => {
        this.setState({
          selected_group_info_loading: false,
          selected_group_info: { number_of_tests: 0, tests: [] }
        });
      });
  }

  updateSelectedGroup = e => {
    // for some reason, trailing spaces are removed when making the request.
    let selected_group = e.target.value.replace(/ *$/, "");
    this.getGroupInfo(selected_group);
    this.setState({ selected_group });
    this.props.dispatch(updateTuningForm(this.props.project, {selected_group}))
  };

  updateExperimentName = e => {
    let experiment_name = e.target.value.replace(/[^\w_.@:=]/g, "-")
    this.setState({experiment_name});
    this.props.dispatch(updateTuningForm(this.props.project, {experiment_name}))
  };

  update = name => e => {
    this.setState({[name]: e.target.value});
    this.props.dispatch(updateTuningForm(this.props.project, {[name] : e.target.value}))
  }

  updateOverwrite = e => {
      let overwrite = e.target.checked ? "on" : "off";
      this.setState({ overwrite });
      this.props.dispatch(updateTuningForm(this.props.project, {overwrite}))
  };

  updateParameterSearch = new_parameter_search => {
    this.setState({ parameter_search: new_parameter_search });
    this.props.dispatch(updateTuningForm(this.props.project, {parameter_search: JSON.stringify(new_parameter_search)}))
  };

  updateParameterSearchAuto = new_parameter_search => {
    this.setState({ parameter_search_auto: new_parameter_search, search_type: 'optimize' });
    this.props.dispatch(updateTuningForm(this.props.project, {parameter_search_auto: JSON.stringify(new_parameter_search), search_type: 'optimize'}))
  };

  useAutoTuning = e => {
    let search_type = e.target.checked ? "optimize" : "grid";
    this.setState({ search_type });
    this.props.dispatch(updateTuningForm(this.props.project, {search_type}))
  };

  updateIterations = e => {
    let search_options = { n_iter: parseFloat(e.target.value) }
    this.setState({ search_options } );
    this.props.dispatch(updateTuningForm(this.props.project, {search_options}))
  };

  onSubmit = e => {
    const {
      experiment_name,
      platform,
      android_device,
      groups,
      selected_group,
      overwrite,
      user
    } = this.state;
    const { parameter_search, parameter_search_auto, search_type, search_options } = this.state;
    this.setState({ submitted: true });
    toaster.show({
      message: "The tuning experiment was sent!",
      intent: Intent.PRIMARY
    });
    post(`/api/v1/commit/${this.props.commit.id}/batch?project=${this.props.project}`, {
      project: this.props.project,
      batch_label: experiment_name,
      platform,
      configuration: 'xxxxxxxxx',
      tuning_search: {
        search_type,
        search_options: search_type!=='grid' ? search_options : {},
        parameter_search: search_type==='optimize' ? parameter_search_auto : eval_combinations(parameter_search).combinations,
      },
      selected_group,
      groups,
      user,
      android_device,
      overwrite: overwrite
    })
      .then(response => {
        this.setState({ submitted: false });
        toaster.show({
          message: "...Acknowledged!",
          intent: Intent.SUCCESS
        });
      })
      .catch(error => {
        this.setState({ submitted: false });
        toaster.show({
          message: `Something wrong happened ${JSON.stringify(error.response)}`,
          intent: Intent.DANGER
        });
      });
    e.preventDefault();
  };

  render() {
    let qatools_config = ((this.props.project_data || {}).data || {}).qatools_config || {}
    const {
      platform,
      android_device,
      selected_group,
      selected_group_info,
      experiment_name,
      user
    } = this.state;
    const { search_type, parameter_search, search_options } = this.state;
    const { number_of_tests, tests } = selected_group_info;
    try {
      var {combinations: tuning_sets, language} = eval_combinations(parameter_search);
      var combinations = grid_combinations(tuning_sets);
      if (combinations === null || combinations === 'optimize')
        combinations = "invalid";
      else
        combinations = (search_options.n_iter < 0 || search_type==='grid') ? combinations : Math.min(search_options.n_iter, combinations);
    } catch (e) {
      combinations = "invalid";
      language = 'javascript'
    }
    let total_runs = combinations * number_of_tests;
    let time_intent =
      (combinations === "invalid" || total_runs===0)
        ? Intent.DANGER
        : total_runs < 100
          ? Intent.PRIMARY
          : Intent.WARNING;

    return (
      <form onSubmit={this.onSubmit}>
        <FormGroup
          helperText={
            <span>
              Re-using a name adds more results. The <code className={Classes.CODE}>default</code> batch
              corresponds to the CI results
            </span>
          }
          label="Experiment name:"
          labelFor="batch-label"
          intent={Intent.PRIMARY}
       >
          <input
            id="batch-label"
            className={Classes.INPUT}
            intent={Intent.PRIMARY}
            style={{ width: "300px" }}
            placeholder="search-radius-sensibility"
            value={experiment_name}
            onChange={this.updateExperimentName}
            type="text"
            dir="auto"
          />
        </FormGroup>

        <FormGroup
          label="Tests and configurations:"
          intent={Intent.PRIMARY}
          helperText={<>
            {number_of_tests > 0 ? <Tooltip>
              <span style={{borderBottom: '1px dotted #000', textDecoration: 'none'}}>{number_of_tests} tests. </span>
              <ul>{tests.map(t => <li key={t.test}>
              	<span style={{marginRight: '5px'}}>{t.test}</span>
              	{t.configuration.map(c =>
                    <Tag key={JSON.stringify(c)} intent={Intent.PRIMARY} round style={{marginRight: '5px'}}>
                    	{typeof(c) === 'string' ? c : JSON.stringify(c)}
                    </Tag>
                )}
              </li>)}</ul>
            </Tooltip>
            : <span>To know your options, go to the "Tests" tab. </span>
            }
            {this.state.selected_group_info_loading && <Icon icon="time"/>}
          </>}
          labelFor="selected-group"
        >
          <input
            id="selected-group"
            className={Classes.INPUT}
            intent={Intent.PRIMARY}
            style={{ width: "300px" }}
            placeholder="Loop_closure_set"
            onChange={this.updateSelectedGroup}
            value={selected_group}
            type="text"
            dir="auto"
          />
        </FormGroup>

        {(this.props.project==='dvs/psp_swip' || this.props.project==='tof/swip_tof' ) && 
        <RadioGroup
          // label=""
          // helperText={<span><strong>lsf</strong> is the default. <strong>s8</strong> is </span>}
          onChange={this.update('platform')}
          selectedValue={platform}
        >
          <Radio labelElement={<span>Linux</span>} value="lsf" large />
          <Radio label={<span>Android</span>} value="s8" large/>
        </RadioGroup>}

        {platform === "s8" && (
          <FormGroup
            label="Android device"
            helperText="Choose a device from the openstf farm, or your own (host:port)"
            labelFor="input-android-device"
          >
            <input
              id="input-android-device"
              className={Classes.INPUT}
              style={{ width: "300px" }}
              value={android_device}
              placeholder="openstf"
              onChange={this.update('android_device')}
              type="text"
              dir="auto"
            />
          </FormGroup>
        )}

        <h4 className={Classes.HEADING}>Manual tuning</h4>
        <Callout title="Syntax examples" icon="info-sign" style={{marginBottom: '15px'}}>
	        <p>
	          {["default", "simple-combinations", "list-of-combinations", "function"].map(x => (
	            <Button
	              style={{margin: '4px'}}
	              key={x}
	              onClick={e =>
	                this.setState({ parameter_search: templates[x] })
	              }
	            >
	              {x}
	            </Button>
	          ))}
	        </p>
	      </Callout>
        <FormGroup
          inline
          labelFor="select-search-type"
          helperText={
            search_type === "optimize" ? '' :
              search_type === "grid"
              ? `Explores ${combinations} combination${combinations > 1 ? "s" : ""}`
              : `Uniform sampling of ${combinations} combinations`
          }
        >
            <HTMLSelect
              id="select-search-type"
              value={search_type}
              onChange={this.update('search_type')}
              minimal
            >
              <option key="grid" value="grid">
                Grid search
              </option>
              <option key="sampler" value="sampler">
                Sampling
              </option>
              <option key="optimize" value="optimize">
                Automated tuning
              </option>
            </HTMLSelect>
            {(search_type === "sampler") && (
              <input
                id="input-iterations"
                value={search_options.n_iter}
                className={Classes.INPUT}
                style={{ marginLeft: "30px", width: "70px" }}
                placeholder="50"
                onChange={this.updateIterations}
                type="numeric"
                dir="auto"
              />
            )}
        </FormGroup>
        <MonacoEditor
          readonly
          height={200}
          language={language || 'javascript'}
          value={this.state.parameter_search || ''}
          options={editor_options}
          name="editor-tuning-set"
          onChange={this.updateParameterSearch}
        />
        {this.state.search_type !== "optimize" && <Callout
          intent={time_intent}
        >
          {total_runs} total runs
        </Callout>}
        <Button
          disabled={
            this.state.search_type === "optimize" ||
            this.state.submitted ||
            this.state.experiment_name.length === 0 ||
            !total_runs
          }
          type="submit"
          intent={total_runs < 1000 ? Intent.PRIMARY : Intent.DANGER}
        >
          Send
        </Button>

        <FormGroup
            label="Overwrite previous runs"
            labelFor="overwrite-old-outputs"
            inline
        >
          <Switch
            id="overwrite-old-outputs"
            onChange={this.updateOverwrite}
            defaultChecked={false}
          />
        </FormGroup>

        <FormGroup
          label="Run as"
          helperText="Get faster results by running as your own user."
          labelFor="input-user"
          inline
        >
          <input
            id="input-user"
            className={Classes.INPUT}
            style={{ width: "300px" }}
            value={user}
            placeholder={(qatools_config.lsf || {}).user || 'arthurf'}
            onChange={this.update('user')}
            type="text"
            dir="auto"
          />
        </FormGroup>

        <h4 className={Classes.HEADING}>Automated tuning <Tag intent={Intent.WARNING}>Experimental</Tag></h4>
        <Callout icon="info-sign" title="What solver is used?">
          <p><a href="https://github.com/scikit-optimize/scikit-optimize">scikit-optimize</a>. There are lots of other choices (RoBo, MOE, Ray, hyperopt, SMAC, BayesOpt, spearmint, dlib...), all with varying features, algorithms and popularity.</p>
          <p><strong>Get in touch if you have experience/opinions.</strong></p>
        </Callout>
        <FormGroup
            label="Enable"
            labelFor="use-auto-tuning"
            inline
        >
          <Switch
            id="use-auto-tuning"
            onChange={this.useAutoTuning}
            checked={search_type === "optimize"}
          />
        </FormGroup>
        <Button onClick={e => this.setState({ parameter_search_auto: templates['optimize'](qatools_config, this.props.project_data.data.qatools_metrics) })}>Show Example</Button>
        <MonacoEditor
          height={200}
          language='yaml'
          options={editor_options}
          name="editor-tuning-auto"
          onChange={this.updateParameterSearchAuto}
          value={this.state.parameter_search_auto || ''}
        />
        <Button
          type="submit"
          intent={Intent.PRIMARY}
          disabled={this.state.search_type !== "optimize" || this.state.submitted || this.state.experiment_name.length === 0 || !total_runs}
        >
          Start tuning
        </Button>
      </form>
    );
  }
}



const mapStateToProps = (state, ownProps) => {
  return {
      ...(state.tuning[ownProps.project] || {})
  }
}


const TuningForm_ = connect(mapStateToProps)(TuningForm);
export { TuningForm_ as TuningForm };
