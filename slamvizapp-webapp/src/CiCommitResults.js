import React, { Component, Fragment } from "react";
import { withRouter } from "react-router";
import { get } from "axios";
import qs from "qs";
// import List from 'react-virtualized'

import { FormGroup, Switch } from "@blueprintjs/core";
import { Button, MenuItem, Tag, InputGroup, Tooltip, Callout, Card, NonIdealState, Spinner, Tab, Tabs, Intent } from "@blueprintjs/core";
import { MultiSelect, Classes } from "@blueprintjs/select";
import { noMetrics } from "./common/metricSelect";

import { Container, Section } from "./common/containers";
import { CommitInfoCompareCard } from "./CommitInfoCompareCard";
import { MetricsSummary } from "./MetricsSummary";

import { matching_output, sortOutputs } from "./common/utils";
import { TableCompare, TableKpi } from "./Tables";
import { BatchLogs } from "./BatchLogs";
import { CommitParameters } from "./Parameters";
import { SlamOutputCard } from "./slam/SlamOutputCard";
import { CisOutputCard } from "./cis/CisOutputCard";

import { main_metrics, slam_metrics, default_metric } from "./slam/metrics";

import { AddRecordingsForm, TuningForm } from "./tuning/TuningForm";
import { TuningExploration } from "./tuning/TuningExploration";
import { SelectBatches } from "./tuning/SelectBatches";


class CiCommitResults extends Component {
  constructor(props) {
    super(props);
    const params = new URLSearchParams(this.props.location.search);
    const project = params.get('project') || 'dvs/psp_swip';
    const is_slam = project === 'dvs/psp_swip';

    this.state = {
      project,
      available_metrics: is_slam ? slam_metrics : {},
      selected_metrics: is_slam ? main_metrics.map(k=>slam_metrics[k]) : [],

      new_commit_id: null, // current commit to display
      ref_commit_id: params.get('reference') || null, // reference commit to display

      commits: { // store of commit information
        'default': {isLoaded: false}
      },

      selected_batch_new: params.get('batch_new') || 'default',
      selected_batch_ref: params.get('batch_reference') || 'default',

      // for the kpi/improvement/details/tuningExplore tabs
      selectedTabId: project==='dvs/psp_swip' ? "output-table-compare" : 'output-list',

      filter_batch_new: params.get('filter') || '',
      filter_batch_ref: params.get('filter_ref') || '',
      sort_by: is_slam ? default_metric : 'input_test_path', // FIXME
      order: -1,

      // FIX: SLAM-specific
      show_videos: false,
      show_3d: false,
      show_debug: false,
    };
  }

  // these members help us define the metric selector 
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
    get(`/api/v1/commit${query}`, {params: {project: this.state.project}})
      .then(response => {
        // we want to keep updated
        // we could use setInterval and update the reference but it makes the logic more complicated...
        if (to_update ==='new_commit_id')
          setTimeout(x=>this.getCiCommit(response.data.id, to_update), 60*1000)

        if (to_update ==='ref_commit_id') {
          let query = qs.parse(this.props.location.search)
          if (query.reference && query.reference!==response.data.id) {
            this.props.history.push({
              pathname: this.props.location.pathname,
              search: qs.stringify({
                ...query,
                reference: response.data.id,
              })
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


  // callbacl used when the user want to change the reference commit
  handleSubmitReference = (new_ref_commit_id) => {
    const { commits, ref_commit_id } = this.state;
    let is_git = commits[ref_commit_id].data.type==='git';
    if (
      ( is_git && new_ref_commit_id.substring(0,8) !== ref_commit_id.substring(0,8)) || 
      (!is_git && new_ref_commit_id !== ref_commit_id) ) {
      let query = qs.parse(this.props.location.search);
      this.props.history.push({
        pathname: this.props.location.pathname,
        search: qs.stringify({
          ...query,
          reference: new_ref_commit_id,
        })
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

  filter_batch = (batch, filter_values) => {
    if (filter_values.length===0)
      return batch;
    let filter_tokens = filter_values.split(' ');

    let batch_filtered = Object.create(batch) // copy
    batch_filtered.outputs = {}

    Object.entries(batch.outputs).forEach( ([id, output])=> {
      let extra_parameters_s = Object.keys(output.extra_parameters).length>0 ? JSON.stringify(output.extra_parameters) : '';
      let extra_parameters = extra_parameters_s.replace(/"/g, '');
      let searched = `${output.test_input_path} ${output.platform} ${output.configuration} ${extra_parameters}`.toLowerCase()
      let found = false;
      // TODO: first check for exclude filter (-)
      // ..
      for (var i in filter_tokens) {
        let search = filter_tokens[i]
                     .toLowerCase()
                     .replace(/"/g, '')
                     .replace(/=+/g, ':');
        // let exclude = search.startswith('-')
        // if exclude and searched.includes(search[1:]) {found=false}
        if (searched.includes(search)) {
          found=true;
          break
        }    
      }
      if (found)
        batch_filtered.outputs[id] = output;      
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
    let query = qs.parse(this.props.location.search);
    this.props.history.push({
      pathname: this.props.location.pathname,
      search: qs.stringify({
        ...query,
        batch_new: e.target.value,
      })
    })
  }

  selectBatchRef = e => {
    this.setState({selected_batch_ref: e.target.value})
    let query = qs.parse(this.props.location.search);
    this.props.history.push({
      pathname: this.props.location.pathname,
      search: qs.stringify({
        ...query,
        batch_reference: e.target.value,
      })
    })
  }

  UpdateFilterBatchNew = e => {
    this.setState({filter_batch_new: e.target.value})
    let query = qs.parse(this.props.location.search);
    this.props.history.push({
      pathname: this.props.location.pathname,
      search: qs.stringify({
        ...query,
        filter: e.target.value,
      })
    })
  }
  UpdateFilterBatchRef = e => {
    this.setState({filter_batch_ref: e.target.value})
    let query = qs.parse(this.props.location.search);
    this.props.history.push({
      pathname: this.props.location.pathname,
      search: qs.stringify({
        ...query,
        filter_ref: e.target.value,
      })
    })
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


  render() {
    // console.log(this.state);
    var { project, commits, new_commit_id, ref_commit_id, selected_batch_new, selected_batch_ref, selected_metrics } = this.state;
    var { filter_batch_new, filter_batch_ref } = this.state;

    if (!new_commit_id || !new_commit_id)
      return (
        <Container>
          <Section>
            <NonIdealState
              title="No commit selected"
              description="Please first select a commit."
              visual="folder-open"
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
            description={error_description} visual="error"
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

    let new_batch_filtered = this.filter_batch(new_batch, filter_batch_new)
    let ref_batch_filtered = this.filter_batch(ref_batch, filter_batch_ref)
    let nb_running = Object.values(new_batch_filtered.outputs).filter( o=>o.is_running ).length;
    let nb_pending = Object.values(new_batch_filtered.outputs).filter( o=>o.is_pending && !o.is_running ).length;
    let nb_failed = Object.values(new_batch_filtered.outputs).filter( o=>o.is_failed ).length;

    let status_messages = (
      <Section>
       {nb_running>0 &&
          <Callout
            icon="info-sign"
            intent={Intent.SUCCESS}
            title={
              <Tooltip>
              <span>{nb_running} result{nb_running>1 ? 's' : ''} running</span>
              <ul>{Object.values(new_batch_filtered.outputs).filter(o=>o.is_running).map(o=><li key={o}>{o.test_input_path} {Object.keys(o.extra_parameters).length>0 ? JSON.stringify(o.extra_parameters) : ''}<br/>@{o.configuration} on {o.platform}</li>)}</ul>
              </Tooltip>
          }>
          </Callout>}
       {nb_pending>0 &&
          <Callout
            icon="info-sign"
            intent={Intent.WARNING}
            title={
              <Tooltip>
              <span>{nb_pending} result{nb_pending>1 ? 's' : ''} pending</span>
              <ul>{Object.values(new_batch_filtered.outputs).filter(o=> o.is_pending && !o.is_running).map(o=><li key={o}>{o.test_input_path} {Object.keys(o.extra_parameters).length>0 ? JSON.stringify(o.extra_parameters) : ''}<br/>@{o.configuration} on {o.platform}</li>)}</ul>
              </Tooltip>
          }>
          </Callout>}
       {nb_failed>0 &&
          <Callout
            icon="error"
            intent={Intent.DANGER}
            title={`${nb_failed} crashed`}
          >
            {new_batch_filtered.label==='default' && <p>Maybe the logs (below) can help debug this.</p>}
            {project==='dvs/psp_swip' && <p>Consider running the <a href="http://gitlab-srv/dvs/psp_swip/pipelines"><code>debug</code></a> manual CI job, or adding <a href="http://gitlab-srv/dvs/psp_swip/blob/develop/CMakeLists.txt#L43">instrumentation flags</a> for the compiler.</p>}
            <ul>
              {Object.values( new_batch_filtered.outputs )
                     .filter( o=>o.is_failed )
                     .map( o=> <li key={o.id}>
                                 <Tag intent={Intent.DANGER} className="pt-minimal">{`${o.configuration} @${o.platform}`}</Tag> <strong>{o.test_input_path}</strong>
                                 {Object.keys(o.extra_parameters).length>0 && <Fragment><br/><span>JSON.stringify(o.extra_parameters)</span></Fragment>} 
                                </li>
                      )}
            </ul>

          </Callout>}
      </Section>
    );

    let clearButton = selected_metrics.length > 0 ? <Button icon="cross" minimal={true} onClick={this.handleClear} /> : null;
    let metricTableSelect = <MultiSelect
      items={Object.values(this.state.available_metrics)}
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
            project={project}
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
            <div style={{display:'flex', justifyContent: 'space-between', alignItems: 'center'}}>
              <div style={{flex:'1 1 auto', minWidth: '500px', maxWidth: '500px'}}>
                <SelectBatches
                  commit={new_commit}
                  selected={selected_batch_new}
                  onChange={this.selectBatchNew}
                  prefix={<Tag intent={Intent.WARNING}>New commit</Tag>}
                />
                <FormGroup labelFor="filter-new-input" helperText={`${!this.state.filter_batch_new ? 'You can filter outputs by all their properties. ' : ''}${Object.keys(new_batch_filtered.outputs).length} selected`}>
                  <InputGroup
                    value={this.state.filter_batch_new}
                    placeholder="Input, platform, configuration, or tuning parameters (key:value)"
                    onChange={this.UpdateFilterBatchNew}
                    type="search"
                    leftIcon="search"
                  />
                </FormGroup>
              </div>
              <div style={{flex:'1 1 auto', minWidth: '450px', maxWidth: '450px',  textAlign: 'right'}}>
                <SelectBatches
                  commit={ref_commit}
                  selected={selected_batch_ref}
                  onChange={this.selectBatchRef}
                  prefix={<Tag intent={Intent.PRIMARY}>Reference commit</Tag>}
                />
                <FormGroup labelFor="filter-ref-input" helperText={`${Object.keys(ref_batch_filtered.outputs).length} selected.`}>
                <InputGroup
                  value={this.state.filter_batch_ref}
                  placeholder="Input, platform, configuration, or tuning parameters (key:value)"
                  onChange={this.UpdateFilterBatchRef}
                  type="search"
                  rightIcon="search"
                />
              </FormGroup>
            </div>
            </div>
          </Card>
         </Section>

        {status_messages}

        <Section>
          <Card elevation={2}>
          <Tabs id="tabs-summary">
              <Tab id="metrics" title="Performance Summary" panel={<MetricsSummary project={project} available_metrics={this.state.available_metrics} new_batch={new_batch_filtered} ref_batch={ref_batch_filtered} />} />
              {project==='dvs/psp_swip' && <Tab id="parameters" title="Parameters" panel={<CommitParameters project={project} new_commit={new_commit}/>} />}
              {project==='dvs/psp_swip' && <Tab id="recordings" title="Available Recordings" panel={<AddRecordingsForm project={project} commit={new_commit} />} />}
              {project==='dvs/psp_swip' && <Tab id="tuning" title="Extra Runs & Tuning" panel={<TuningForm project={project} commit={new_commit} />} />}
          </Tabs>
          </Card>
        </Section>

        <Section>
          <Tabs renderActiveTabPanelOnly id="tabs-outputs" onChange={(newTabId, prevTabId, event)=>{this.setState({selectedTabId: newTabId})}} selectedTabId={this.state.selectedTabId}>
            <Tab
              id="output-table-compare"
              title="Improvement"
              panel={
                <TableCompare
                  sort_order={this.state.order}
                  sort_by={this.state.sort_by}
                  new_batch={new_batch_filtered}
                  ref_batch={ref_batch_filtered}
                  metrics={selected_metrics}
                  input={metricTableSelect}
                />}
              />
            <Tab
              id="output-table-kpi"
              title="KPI report"
              panel={
                <TableKpi
                  sort_order={this.state.order}
                  sort_by={this.state.sort_by}
                  new_batch={new_batch_filtered}
                  ref_batch={ref_batch_filtered}
                  metrics={selected_metrics}
                  input={metricTableSelect}
                />}
              />
            <Tab
              id="logs"
              title="Logs"
              panel={<BatchLogs batch={new_batch_filtered}
              batch_label={new_batch.label}/>}
            />
            <Tab
              id="output-list"
              title={project==='dvs/psp_swip' ? "6DoF Details" : "Detailed outputs"}
              panel={
                <OutputList
                  project={project}
                  sort_order={this.state.order}
                  sort_by={this.state.sort_by}
                  new_batch={new_batch_filtered}
                  ref_batch={ref_batch_filtered}
                  show_videos={this.state.show_videos}
                  show_3d={this.state.show_3d}
                  show_debug={this.state.show_debug}
                />}
              />
            <Tab
              id="tuning-results"
              title="Tuning exploration"
              panel={
                <TuningExploration project={project} batch={new_batch_filtered}/>}
              />
            <Tabs.Expander />
            {project==='dvs/psp_swip' ? <Fragment>
                                          <Switch checked={this.state.show_debug} label="Debug" onChange={this.toogleShowDebug} />
                                          <Switch checked={this.state.show_videos} label="Videos" onChange={this.toogleShowVideos} />
                                          <Switch checked={this.state.show_3d} label="3d" onChange={this.toogleShow3d} />
                                          <div className="pt-select">
                                            <select defaultValue={this.state.sort_by} onChange={this.selectSortBy}>
                                              <option value="test_input_path">Sort by Name</option>
                                              {Object.values(this.state.available_metrics).map(m => <option key={m.key} value={m.key}>Sort by {m.label}</option>)}
                                            </select>
                                            <select defaultValue="descending" onChange={this.selectOrder}>
                                              <option value={-1}>descending</option>
                                              <option value={1}>ascending</option>
                                            </select>
                                          </div>
                                          </Fragment>
                                      : <Fragment/>}
          </Tabs>
        </Section>
        </Fragment>}

      </Container>
    );
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
    const { new_batch, ref_batch, sort_by, sort_order } = this.props;
    const { show_debug, show_videos, show_3d } = this.props;
    // FIXME: workaround to compare local commits versus git-ci commits
    // https://github.com/bvaughn/react-virtualized/blob/master/docs/List.md
    return <Fragment>
            {show_debug && <FormGroup
                              label="Show debug outputs matching"
                              labelFor="show-debug-input"
                              helperText="You can select any number of debug outputs."
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
              {Object.entries(new_batch.outputs)
                     .sort(sortOutputs(sort_by, sort_order))
                     .map( ([id, output]) => {
                        let { output_ref, warning } = matching_output({output: output, batch:ref_batch});
                        if (output.output_type==='slam/6dof')
                          return <SlamOutputCard
                            key={id}
                            output_new={output}
                            output_ref={output_ref}
                            show_debug={show_debug}
                            select_debug={this.state.select_debug}
                            show_videos={show_videos}
                            show_3d={show_3d}
                            warning={warning}
                          />;
                        else if (output.output_type==='cis/image')
                          return <CisOutputCard
                            key={id}
                            output_new={output}
                            output_ref={output_ref}
                            warning={warning}
                          />;
                        else return <span>Unsupport output type</span>
                    })}
            </div>
           </Fragment>

  }
}


export default withRouter(CiCommitResults);
