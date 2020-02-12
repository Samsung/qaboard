import React, { Component } from "react";
import { connect } from 'react-redux'
import { get, post } from "axios";

import { updateTuningForm } from "../../actions/tuning";
import { fetchCommit } from "../../actions/commit";

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
  Popover,
  Icon,
  Tab,
  Tabs,
} from "@blueprintjs/core";

import templates from './templates'
export const toaster = Toaster.create();


const editor_options = {
  selectOnLineNumbers: true,
  seedSearchStringFromSelection: true,
};


const wrap_values_in_array = object => {
  let output = {};
  Object.keys(object).forEach(key => {
    output[key] = wrap_in_array(object[key]);
  });
  return output;
};

const wrap_in_array = x => {
  if (Array.isArray(x))
    return x;
  else
    return [x];
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
  return { combinations, language }
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


const combinations_info = (parameter_search, search_options, search_type) => {
  try {
    var { combinations: tuning_sets, language } = eval_combinations(parameter_search);
    var combinations = grid_combinations(tuning_sets);
    if (combinations === null || combinations === 'optimize')
      combinations = "invalid";
    else
      combinations = (search_options.n_iter < 0 || search_type==='grid') ? combinations : Math.min(search_options.n_iter, combinations);
  } catch (e) {
    combinations = "invalid";
    language = 'javascript'
  }
  // console.log(tuning_sets, combinations, language)
  return { combinations, language }
}




class TuningForm extends Component {
  constructor(props) {
    super(props);
    let qatools_config = ((this.props.project_data || {}).data || {}).qatools_config || {}
    let default_user = this.props.user || ((qatools_config.runners || qatools_config).lsf || {}).user;

    let search_type = this.props.search_type || "grid"
    let parameter_search = this.props.parameter_search ? this.props.parameter_search : templates["no tuning"];
    let search_options = {
      n_iter: 50,
    }
    this.state = {
      submitted: false,
      experiment_name: this.props.experiment_name || "",
      platform: this.props.platform || "lsf",
      overwrite: this.props.overwrite==='on' || true,

      selected_group: this.props.selected_group || "",
      selected_group_info: {
        tests: [],
      },
      selected_group_info_loading: false,

      search_type,
      parameter_search,
      search_options,
      ...combinations_info(parameter_search, search_options, search_type),
      parameter_search_auto: this.props.parameter_search_auto
        ? this.props.parameter_search_auto
        : templates['optimize'](qatools_config, this.props.project_data.data.qatools_metrics),

      user: this.props.user || default_user,
      android_device: "openstf",

    };
  }

  componentDidMount() {
    const { selected_group } = this.state;
    if (selected_group) this.getGroupInfo(selected_group);

    // TODO: remove at some point, or expose via tuning.runners.lsf.forbidden_users...
    if (this.props.user === 'ispq') {
      this.update('user')('')
      toaster.show({
        message: <span>Sorry, using the <strong>ispq</strong> user for tuning is not allowed anymore!</span>,
        intent: Intent.WARNING,
        timeout: 10000,
      });
    }
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
          selected_group_info: { tests: [] }
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
    let value = !!e.target ? e.target.value : e
    // console.log(name, value)
    this.setState({
      [name]: value,
    }, () => {
      this.setState({...combinations_info(this.state.parameter_search, this.state.search_options, this.state.search_type)})
    }); 
    this.props.dispatch(updateTuningForm(this.props.project, {[name] : value}))
  }

  updateOverwrite = e => {
      let overwrite = e.target.checked;
      this.setState({ overwrite });
      this.props.dispatch(updateTuningForm(this.props.project, {overwrite}))
  };

  updateParameterSearch = new_parameter_search => {
    // console.log(new_parameter_search)
    this.setState({
      parameter_search: new_parameter_search,
      ...combinations_info(new_parameter_search, this.state.search_options, this.state.search_type),
    });
    this.props.dispatch(updateTuningForm(this.props.project, {parameter_search: new_parameter_search}))
  };

  updateParameterSearchAuto = new_parameter_search => {
    this.setState({ parameter_search_auto: new_parameter_search });
    this.props.dispatch(updateTuningForm(this.props.project, {parameter_search_auto: new_parameter_search}))
  };

  updateSearchTab = new_tab => {
    let search_type = new_tab === "search-manual" ? "grid" : "optimize";
    this.setState({ search_type});
    this.props.dispatch(updateTuningForm(this.props.project, {search_type}))
  };

  updateIterations = e => {
    let search_options = { n_iter: parseFloat(e.target.value) }
    this.setState({
      search_options,
      ...this.combinations_info(this.state.parameter_search, search_options, this.state.search_type),
    });
    this.props.dispatch(updateTuningForm(this.props.project, {search_options}))
  };

  onSubmit = () => {
    const { project, commit, dispatch } = this.props;
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
      message: "Sent!",
      intent: Intent.PRIMARY
    });
    post(`/api/v1/commit/${commit.id}/batch?project=${project}`, {
      project,
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
      overwrite,
    })
      .then(response => {
        this.setState({ submitted: false });
        toaster.show({
          message: "Acknowledged! You can select the batch here ➡️",
          intent: Intent.SUCCESS
        });
        const refresh = () => {
          dispatch(fetchCommit({project, id: commit.id}))
        }
        setTimeout(refresh,  1*1000)
        setTimeout(refresh,  5*1000)
        setTimeout(refresh, 10*1000)
      })
      .catch(error => {
        this.setState({ submitted: false });
        toaster.show({
          message: `Something wrong happened ${JSON.stringify(error.response)}`,
          intent: Intent.DANGER
        });
      });
  };

  render() {
    const { project, project_data } = this.props;
    let qatools_config = ((project_data || {}).data || {}).qatools_config || {}
    const { search_type, search_options } = this.state;
    const { experiment_name, selected_group, selected_group_info } = this.state;
    const { user, platform, android_device } = this.state;
    const { tests, message } = selected_group_info;
    const { combinations, language } = this.state
    let total_runs = combinations * tests.length;
    let time_intent =
      (combinations === "invalid" || total_runs===0)
        ? Intent.DANGER
        : total_runs < 100
          ? Intent.PRIMARY
          : Intent.WARNING;

    // console.log(this.state.parameter_search)
    const panel_manual = <>
      <Callout title="Examples for parameter tuning" icon="info-sign" style={{marginBottom: '15px'}}>
        <p>
        {["no tuning", "simple-combinations", "list-of-combinations", "1x2 matrix", "function"].map(x => (
          <Button
            style={{margin: '4px'}}
            key={x}
            onClick={() => this.updateParameterSearch(templates[x])}
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
          !this.state.parameter_search ? '' : (
          search_type === "optimize" ? '' :
            search_type === "grid"
            ? `Explores ${combinations} combination${combinations > 1 ? "s" : ""}`
            : `Uniform sampling of ${combinations} combinations`
          )
        }
      >
        <HTMLSelect
          id="select-search-type"
          value={search_type}
          onChange={this.update('search_type')}
          minimal
        >
          <option key="grid" value="grid">All combinations</option>
          <option key="sampler" value="sampler">Sampling</option>
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
        language={language || 'json'}
        value={this.state.parameter_search || ''}
        options={editor_options}
        name="editor-tuning-set"
        onChange={this.updateParameterSearch}
      />
      {this.state.search_type !== "optimize" && <Callout intent={time_intent} >{total_runs} total runs</Callout>}
    </>
   

    const panel_auto = <>
      <Callout icon="info-sign" title="What solver is used?">
        <p><a href="https://github.com/scikit-optimize/scikit-optimize">scikit-optimize</a>. There are lots of other choices (RoBo, MOE, Ray, hyperopt, SMAC, BayesOpt, spearmint, dlib...), all with varying features, algorithms and popularity.</p>
        <p><strong>Get in touch if you have experience/opinions.</strong></p>
        </Callout>
      <Button onClick={e => this.setState({ parameter_search_auto: templates['optimize'](qatools_config, project_data.data.qatools_metrics) })}>Show Example</Button>
      <MonacoEditor
        height={200}
        language='yaml'
        options={editor_options}
        name="editor-tuning-auto"
        onChange={this.updateParameterSearchAuto}
        value={this.state.parameter_search_auto || ''}
      />
    </>

    const available_platforms = ((qatools_config.inputs || {}).platforms || [])

    return <>
      <FormGroup
        helperText={!experiment_name ? "(required)" : "Tip: You can add runs to an existing experiment"}
        label={`Experiment name:`}
        labelFor="batch-label"
        intent={!experiment_name ? Intent.DANGER : Intent.PRIMARY}
     >
        <input
          id="batch-label"
          className={Classes.INPUT}
          style={{ width: "300px" }}
          placeholder="my-tuning-experiment"
          value={experiment_name}
          onChange={this.updateExperimentName}
          type="text"
          dir="auto"
        />
      </FormGroup>

      <FormGroup
        label="Batch of inputs+configurations:"
        intent={!selected_group ? Intent.DANGER : Intent.PRIMARY}
        helperText={<>
          {tests.length > 0 ? <Popover inheritDarkTheme portalClassName={Classes.DARK} position="right" hoverCloseDelay={300} interactionKind={"hover"}>
            <span style={{borderBottom: '1px dotted #000', textDecoration: 'none'}}>{tests.length} tests. </span>
            <div style={{padding: '10px'}}>
              <ul style={{maxWidth: "1200px", maxHeight: "800px", overflow: "auto"}} >
                {tests.map((t, idx) => <li key={idx} style={{marginBottom: '5px'}}>
              	  <span style={{marginRight: '5px'}}>{t.input_path}</span>
              	  {t.configurations.map(c =>
                    <Tag key={JSON.stringify(c)} intent={Intent.PRIMARY} round style={{marginRight: '5px', marginBottom: '5px'}}>
                    	{typeof(c) === 'string' ? c : JSON.stringify(c)}
                    </Tag>
                  )}
              </li>)}
              </ul>
            </div>
          </Popover>
          : <span>
              {message && <Tooltip><Icon intent={Intent.WARNING} icon="warning-sign"/><span dangerouslySetInnerHTML={{__html: message}}></span></Tooltip>}
              To know your options, go to the "Tests" tab.
            </span>
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

      {(project!=='dvs/psp_swip' && project!=='tof/swip_tof' && available_platforms.length > 0) &&
      <RadioGroup onChange={this.update('platform')} selectedValue={platform}>
        {available_platforms.map(p => <Radio
          labelElement={<span>{p.label || p.name || 'undefined name/label!'}</span>}
          value={p.name}
          large
        />)}
      </RadioGroup>}

      {((project==='dvs/psp_swip' || project==='tof/swip_tof' )&& available_platforms.length === 0) &&
      <RadioGroup onChange={this.update('platform')} selectedValue={platform}>
        <Radio labelElement={<span>Linux</span>} value="lsf" large />
        <Radio label={<span>Android</span>} value="s8" large/>
      </RadioGroup>}

      {platform.startsWith("s8") && (
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


      <Tabs renderActiveTabPanelOnly id="search-type" selectedTabId={search_type !== "optimize" ? "search-manual" : "search-optimize"} onChange={this.updateSearchTab}  defaultSelectedTabId="search-manual">
        <Tab id="search-manual" title="Manual tuning" panel={panel_manual} />
        <Tab id="search-optimize" title={<>Automated tuning <Tag>Experimental</Tag></>} panel={panel_auto} />
      </Tabs>

      <FormGroup
        helperText={!user ? "Please provide a user in the input below"
                          : (this.state.experiment_name.length === 0 ? 'Please give a name to the tuning experiment (the input is above)' : undefined)}
        intent={(!user || this.state.experiment_name.length === 0 || !total_runs) ? Intent.DANGER : undefined}
      >
      <Button
        onClick={this.onSubmit}
        disabled={
          this.state.submitted ||
          !user ||
          this.state.experiment_name.length === 0 ||
          !total_runs
        }
        large
        intent={search_type !== "optimize" ? (total_runs < 1000 ? Intent.PRIMARY : Intent.DANGER) : Intent.PRIMARY}
      >
        Send
      </Button>
      </FormGroup>

      <FormGroup
          label="Overwrite previous identical runs"
          labelFor="overwrite-old-outputs"
          inline
      >
        <Switch
          id="overwrite-old-outputs"
          checked={this.state.overwrite}
          onChange={this.updateOverwrite}
        />
      </FormGroup>

      <FormGroup
        label="Run as"
        helperText="(required)"
        labelFor="input-user"
        intent={!user ? Intent.DANGER : undefined}
        inline
      >
        <input
          id="input-user"
          className={Classes.INPUT}
          style={{ width: "300px" }}
          value={user}
          placeholder='user'
          onChange={this.update('user')}
          type="text"
          dir="auto"
        />
      </FormGroup>
    </>;
  }
}



const mapStateToProps = (state, ownProps) => {
  return {
      ...(state.tuning[ownProps.project] || {})
  }
}


const TuningForm_ = connect(mapStateToProps)(TuningForm);
export { TuningForm_ as TuningForm };
