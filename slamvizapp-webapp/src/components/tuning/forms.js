import React, { Component } from "react";
import { connect } from 'react-redux'
import { get, post } from "axios";

import { CopyToClipboard } from "react-copy-to-clipboard";
import { updateTuningForm } from "../../actions/tuning";

import AceEditor from "react-ace";
/*eslint-disable no-alert, no-console */
import brace from "brace"; // eslint-disable-line no-unused-vars
import "brace/mode/json";
import "brace/mode/javascript";
import "brace/mode/yaml";
import "brace/theme/github";
import "brace/ext/searchbox";
// import 'brace/mode/diff';
// import 'brace/ext/language_tools';

import {
  Classes,
  Callout,
  Intent,
  Spinner,
  NonIdealState,
  Button,
  FormGroup,
  HTMLSelect,
  Radio,
  RadioGroup,
  Switch,
  Tag,
  Toaster,
} from "@blueprintjs/core";

import templates from './templates'
export const toaster = Toaster.create();

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
  let output = null;
  // users can directly provide tuning sets via objects or arrays of objects
  try {
    output = JSON.parse(param_search_text);
  } catch (e) {
    // or they can provide a function that returns a tuning set
    output = eval_function(param_search_text);
  }
  if (Array.isArray(output)) {
    return output.map(wrap_values_in_array);
  } else return wrap_values_in_array(output);
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
    let configuration = this.props.configuration || this.props.project_data.information.qatools_config.inputs.configuration;
    let default_user = this.props.user || this.props.project_data.information.qatools_config.lsf.user || 'arthurf';
    this.state = {
      submitted: false,
      experiment_name: this.props.experiment_name || "",
      platform: this.props.platform || "lsf",
      configuration,
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
      parameter_search: this.props.parameter_search ? JSON.parse(this.props.parameter_search) : templates["none"],
      parameter_search_auto: this.props.parameter_search_auto
        ? JSON.parse(this.props.parameter_search_auto)
        : templates['optimize'](this.props.project_data.information.qatools_config, this.props.project_data.information.qatools_metrics),

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

  getGroupInfo(group) {
    get(`/api/v1/tests/group?project=${this.props.project}&name=${group}`, {})
      .then(response => {
        this.setState({
          selected_group_info_loading: false,
          selected_group_info: response.data
        });
      })
      .catch(error => {
        this.setState({
          selected_group_info_loading: false,
          selected_group_info: { number_of_tests: 0 }
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
      configuration,
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
      configuration,
      tuning_search: {
        search_type,
        search_options,
        parameter_search: search_type==='optimize' ? parameter_search_auto : eval_combinations(parameter_search),
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
    const {
      platform,
      android_device,
      configuration,
      selected_group,
      selected_group_info,
      experiment_name,
      user
    } = this.state;
    const { search_type, parameter_search, search_options } = this.state;
    let number_of_tests = selected_group_info.number_of_tests;
    try {
      var tuning_sets = eval_combinations(parameter_search);
      var combinations = grid_combinations(tuning_sets);
      if (combinations === null || combinations === 'optimize') combinations = "invalid";
      else
        combinations = search_options.n_iter < 0 ? combinations : Math.min(search_options.n_iter, combinations);
    } catch (e) {
      combinations = "invalid";
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
          label="Name the experiment:"
          labelFor="batch-label"
          intent={Intent.PRIMARY}
          labelInfo="(required)"
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
          label="Run on those tests:"
          intent={Intent.PRIMARY}
          helperText={`${
            number_of_tests > 0
              ? number_of_tests + " tests. "
              : ""
          }Path, or one of the groups defined in the "Available Recordings" tab.`}
          labelFor="selected-group"
          labelInfo="(required)"
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
          <Radio
            label={
              <span>
                Android<br />
                <span className={Classes.TEXT_MUTED}>
                  Available on <code className={Classes.CODE}>develop</code> or if you ran the{" "}
                  <a href={`http://gitlab-srv/${this.props.project}/pipelines`}>
                    <code className={Classes.CODE}>performance:android:manual</code> job
                  </a>
                </span>
              </span>
            }
            value="s8"
            large
          />
        </RadioGroup>}

        {platform === "s8" && (
          <FormGroup
            label="Android device"
            helperText="Choose a device from the openstf farm, or your own (host:port)"
            labelFor="input-android-device"
            labelInfo="(required)"
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

        <FormGroup
          label="Configuration"
          helperText="Configurations are saved as $configuration.json/yaml"
          labelFor="input-configuration"
        >
          <input
            id="input-configuration"
            className={Classes.INPUT}
            style={{ width: "300px" }}
            value={configuration}
            placeholder={this.props.project_data.information.qatools_config.inputs.configuration}
            onChange={this.update('configuration')}
            type="text"
            dir="auto"
          />
        </FormGroup>

        <h3 className={Classes.HEADING}>Manual tuning search</h3>
        <p>
          Click to see examples:{" "}
          {["simple-combinations", "list-of-combinations", "function"].map(x => (
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
        <FormGroup
          inline
          labelFor="select-search-type"
          helperText={
            search_type === "optimize" ? '' :
              search_type === "grid"
              ? `Explores all the ${combinations} combination${combinations > 1 ? "s" : ""}`
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
            {(search_type === "sampler" || search_type === "grid") && (
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
        <AceEditor
          mode="javascript"
          theme="github"
          onChange={this.updateParameterSearch}
          width="100%"
          height="200px"
          name="editor-tuning-set"
          value={this.state.parameter_search}
          editorProps={{ $blockScrolling: true }}
          setOptions={{
            tabSize: 2
          }}
        />

        {this.state.search_type !== "optimize" && <Callout
          icon={this.state.selected_group_info_loading ? "dot" : "time"}
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
            placeholder={this.props.project_data.information.qatools_config.lsf.user || 'arthurf'}
            onChange={this.update('user')}
            type="text"
            dir="auto"
          />
        </FormGroup>

        <h3 className={Classes.HEADING}>Automated tuning search <Tag intent={Intent.WARNING}>Experimental</Tag></h3>
        <Callout icon="info-sign">
          <p>We use <a href="https://github.com/scikit-optimize/scikit-optimize">scikit-optimize</a>.</p>
          <p>There are lots of other choices (RoBo, MOE, Ray, hyperopt, SMAC, BayesOpt, spearmint, dlib...), all with varying features, algorithms and popularity.</p>
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
        <Button onClick={e => this.setState({ parameter_search_auto: templates['optimize'](this.props.project_data.information.qatools_config, this.props.project_data.information.qatools_metrics) })}>Show Example</Button>
        <AceEditor
          mode="yaml"
          theme="github"
          onChange={this.updateParameterSearchAuto}
          width="100%"
          height="200px"
          name="editor-tuning-set"
          value={this.state.parameter_search_auto}
          editorProps={{ $blockScrolling: true }}
          setOptions={{
            tabSize: 2
          }}
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
    this.setState({ groups: newGroups });
  };

  onSubmit = e => {
    e.preventDefault();
    const { groups } = this.state;
    this.setState({ submitted: true });
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
        this.setState({ submitted: false });
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
    // let number_of_tests = this.state.selected_group_info.number_of_tests;
    return (
      <form onSubmit={this.onSubmit}>
        <div className={`${Classes.INLINE} ${Classes.FORM_GROUP}`}>
          <Button
            disabled={this.state.submitted}
            type="submit"
            intent={Intent.PRIMARY}
          >
          <span>Update list</span>
          </Button>
        </div>

        <div>
          <span>Paths are relative to <CopyToClipboard
                                        text={this.props.project_data.information.qatools_config.inputs.database.windows}
                                        onCopy={() => {
                                          toaster.show({
                                            message: "Copied to clipboard!",
                                            intent: Intent.PRIMARY
                                          });
                                        }}
                                      ><pre>{this.props.project_data.information.qatools_config.inputs.database.windows}</pre>
                                      </CopyToClipboard>
          </span>
        </div>

        <div className={`${Classes.INLINE} ${Classes.FORM_GROUP}`} />
        <AceEditor
          mode="yaml"
          theme="github"
          onChange={this.updateGroups}
          width="100%"
          name="groups"
          value={groups || ""}
          editorProps={{ $blockScrolling: true }}
          setOptions={{
            tabSize: 2
          }}
        />
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
export { TuningForm_ as TuningForm, AddRecordingsForm };
