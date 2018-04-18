import React, { Component, Fragment } from "react";
import { withRouter } from "react-router";
import { get, all } from "axios";
import queryString from "query-string";
// import List from 'react-virtualized'

import AceEditor from 'react-ace';
import { FormGroup, Switch } from "@blueprintjs/core";
import { Button, MenuItem, Tag, InputGroup, Tooltip, Callout, Card, NonIdealState, Spinner, Tab, Tabs, Intent } from "@blueprintjs/core";

import { Container, Section } from "./Common";
import { MetricsSummary } from "./Metrics";
import { TableCompare, TableKpi } from "./Tables";
import { OutputCard } from "./slam/OutputCard";
import { CommitInfoCompareCard } from "./CommitInfoCompareCard";
import { slam_configurations } from "./slam/configurations";
import { main_metrics, slam_metrics } from "./slam/metrics";
import { AddRecordingsForm, TuningForm } from "./tuning/TuningForm";
import { TuningExploration } from "./tuning/TuningExploration";
import { SelectBatches } from "./tuning/SelectBatches";

import { MultiSelect, Classes } from "@blueprintjs/select";
import { noMetrics } from "./metricSelect";


/*eslint-disable no-alert, no-console */
import brace from 'brace'; // eslint-disable-line no-unused-vars
import 'brace/mode/json';
import 'brace/mode/yaml';
import 'brace/theme/github';
import 'brace/ext/searchbox';
// import 'brace/mode/diff';
// import 'brace/ext/language_tools';
// https://github.com/securingsincity/react-ace/blob/master/docs/Ace.md5


class CommitLogs extends Component {
  constructor(props) {
    super(props);
    this.state = {
      batch_label: 'default',
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
    const { batch_label, commit } = this.props;
    const { isLoaded, error, logs_lsf } = this.state;

    if (batch_label !== 'default') {
      return Object.values( commit.batches[batch_label].slam_outputs )
             .filter( o=>!o.is_pending )
             .map( o=> <li key={o}><strong>{!o.is_failed && <Tag intent={Intent.SUCCESS}>OK</Tag>}{o.is_failed && <Tag intent={Intent.DANGER}>Crashed</Tag>}{o.recording_path}</strong>
                         <br/>{o.configuration} @{o.platform}
                         <br/>{Object.keys(o.extra_parameters).length>0 ? JSON.stringify(o.extra_parameters) : ''} 
                         <span> <a href={`${o.output_dir_url}/lsf.log`}>(link to logs)</a></span>
                       </li>)
    }

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

      selected_metrics: main_metrics.map(k=>slam_metrics[k]),

      commit_logs: {},
    };
  }

  renderMetric = (metric, {handleClick, modifiers, query} ) => {
    if (!modifiers.matchesPredicate) {
      return null;
    }
    return (
        <MenuItem
            active={modifiers.active}
            icon={this.isMetricSelected(metric) ? "tick" : "blank"}
            key={metric.key}
            label={metric.key}
            text={`${metric.label} [${metric.suffix}]`}
            onClick={handleClick}
            shouldDismissPopover={false}
        />
    );
  };
  filterMetric = (query, metric) => {
    let searched = `${metric.key} ${metric.label} ${metric.short_label}`.toLowerCase();
    let search = query.toLowerCase();
    return searched.indexOf(search) >= 0;
  }
  handleClear = () => this.setState({ selected_metrics: [] });
  handleTagRemove = (_tag, index) => {
    this.deselectMetric(index);
  };
  getSelectedMetricIndex = metric => {
    return this.state.selected_metrics.indexOf(metric);
  }
  isMetricSelected(metric) {
      return this.getSelectedMetricIndex(metric) !== -1;
  }
  deselectMetric = index => {
      this.setState({ selected_metrics: this.state.selected_metrics.filter( (metric, i) => i !== index) });
  }
  handleMetricSelect = metric => {
    if (!this.isMetricSelected(metric)) {
      this.setState({ selected_metrics: [...this.state.selected_metrics, metric] });
    } else {
      this.deselectMetric(this.getSelectedMetricIndex(metric));
    }
  };

  updateState() {
    const params = new URLSearchParams(this.props.location.search);
    const new_commit_id = params.get('commit_folder') || this.props.match.params[0]
    const ref_commit_id = this.state.ref_commit_id || params.get('reference') || params.get('commit_ref_folder') || 'default';
    document.title = new_commit_id;
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
    var { commits, new_commit_id, ref_commit_id, selected_batch_new, selected_batch_ref, selected_metrics } = this.state;

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

    let new_batch = new_commit.batches[selected_batch_new];
    let ref_batch = ref_commit.batches[selected_batch_ref];
    let status_messages = (
      <Section>
       {new_commit.batches[selected_batch_new].running_slam_outputs>0 &&
          <Callout
            icon="info-sign"
            intent={Intent.SUCCESS}
            title={
              <Tooltip>
              <span>{new_batch.pending_slam_outputs} result{new_batch.running_slam_outputs>1 ? 's' : ''} running</span>
              <ul>{Object.values(new_batch.slam_outputs).filter(o=>o.is_running).map(o=><li key={o}>{o.recording_path} {Object.keys(o.extra_parameters).length>0 ? JSON.stringify(o.extra_parameters) : ''}<br/>@{o.configuration} on {o.platform}</li>)}</ul>
              </Tooltip>
          }>
          </Callout>}
       {new_batch.pending_slam_outputs-new_batch.running_slam_outputs>0 &&
          <Callout
            icon="info-sign"
            intent={Intent.WARNING}
            title={
              <Tooltip>
              <span>{new_batch.pending_slam_outputs-new_batch.running_slam_outputs} result{new_batch.pending_slam_outputs-new_batch.running_slam_outputs>1 ? 's' : ''} pending</span>
              <ul>{Object.values(new_batch.slam_outputs).filter(o=> o.is_pending && !o.is_running).map(o=><li key={o}>{o.recording_path} {Object.keys(o.extra_parameters).length>0 ? JSON.stringify(o.extra_parameters) : ''}<br/>@{o.configuration} on {o.platform}</li>)}</ul>
              </Tooltip>
          }>
          </Callout>}
       {new_batch.failed_slam_outputs>0 &&
          <Callout
            icon="error"
            intent={Intent.DANGER}
            title={`${new_batch.failed_slam_outputs} crashed`}
          >
            {new_batch.label==='default' && <p>Maybe the <a href={`${new_commit.commit_dir_url}/lsf.log`}>LSF logs</a> can help debug this.</p>}
            <p>Consider running the <a href="http://gitlab-srv/dvs/psp_swip/pipelines"><code>debug</code></a> manual CI job, or adding <a href="http://gitlab-srv/dvs/psp_swip/blob/develop/CMakeLists.txt#L43">instrumentation flags</a> for the compiler.</p>
            <ul>
              {Object.values( new_batch.slam_outputs )
                     .filter( o=>o.is_failed )
                     .map( o=> <li key={o}><strong>{o.recording_path}</strong>
                                            <br/>{o.configuration} @{o.platform}
                                            <br/>{Object.keys(o.extra_parameters).length>0 ? JSON.stringify(o.extra_parameters) : ''} 
                                            {new_batch.label!=='default' && <span> <a href={`${o.output_dir_url}/lsf.log`}>(logs)</a></span>}</li>)}
            </ul>

          </Callout>}
      </Section>
    );

    let new_batch_filtered = this.filter_batch(new_batch)
    let ref_batch_filtered = this.filter_batch(ref_batch)

    let compare_cross_runtype= new_commit.type==='local' && ref_commit.type==='git';


    let clearButton = selected_metrics.length > 0 ? <Button icon="cross" minimal={true} onClick={this.handleClear} /> : null;
    let metricTableSelect = <MultiSelect
      items={Object.values(slam_metrics)}
      itemPredicate={this.filterMetric}
      itemRenderer={this.renderMetric}
      onItemSelect={this.handleMetricSelect}
      tagRenderer={m => m.label}
      tagInputProps={{ onRemove: this.handleTagRemove, rightElement: clearButton }}
      noResults={noMetrics}
      selectedItems={selected_metrics}
      popoverProps={Classes.MINIMAL}
    />


    var result = (
      <Container>
        {warning_messages}
        <Section>
          <CommitInfoCompareCard
            new_commit={new_commit}
            ref_commit={ref_commit}
            new_label={selected_batch_new}
            ref_label={selected_batch_ref}
            onConfirmReference={this.handleSubmitReference}
          />
        </Section>

        { new_commit!==undefined && ref_commit!==undefined && <Fragment>
        <Section>
          <Card elevation={0}>
            <SelectBatches
              commit={new_commit}
              onChange={this.selectBatchNew}
              prefix={<Tag intent={Intent.WARNING}>New commit</Tag>}
            />
            <SelectBatches
              commit={ref_commit}
              onChange={this.selectBatchRef}
              prefix={<Tag intent={Intent.PRIMARY}>Reference commit</Tag>}
            />
            <FormGroup label="Filter results" labelFor="filter-input" helperText={`All the data on this page will update. (${Object.keys(new_batch_filtered.slam_outputs).length} selected)`}>
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
              <Tab id="logs" title="Logs" panel={<CommitLogs commit={new_commit} batch_label={new_batch.label}/>} />
              <Tab id="re-run" title="Add recordings" panel={<AddRecordingsForm commit={new_commit} />} />
              <Tab id="tuning" title="Create tuning experiment" panel={<TuningForm commit={new_commit} />} />
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
                  metrics={selected_metrics}
                  input={metricTableSelect}
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
                  metrics={selected_metrics}
                  compare_cross_runtype={compare_cross_runtype}
                  input={metricTableSelect}
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
            {ref_batch.label!=='default' && <Callout intent={Intent.WARNING}>We compare each output to <strong>any</strong> reference outputs with matching recording+configuration+platform, <strong>without looking at the tuning parameters</strong>.</Callout>}
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
