import React, { Component } from "react";
import { connect } from 'react-redux'
import { withRouter } from "react-router";

import {
  Intent,
  Classes,
  HTMLSelect,
  Switch,
  Button,
  MenuItem,
  Card,
  Tabs,
  NonIdealState,
} from "@blueprintjs/core";
import { MultiSelect } from "@blueprintjs/select";
import { noMetrics } from "./components/metricSelect";

import { Container, Section } from "./components/layout";
import { MetricsSummary } from "./components/metrics";
import { CommitsWarningMessages, BatchStatusMessages } from "./components/messages";

import { TableCompare, TableKpi } from "./components/tables";
import { BatchLogs } from "./components/BatchLogs";
import { CommitParameters } from "./components/Parameters";
import { OutputCardsList } from "./viewers/OutputCardsList";
import { fetchCommit } from "./actions/commit";
import { updateSelected } from "./actions/selected";


import { TuningForm } from "./components/tuning/forms";
import { AddRecordingsForm } from "./components/tuning/form_groups";
import TuningExploration from "./components/tuning/TuningExploration";
import { controls_defaults, updateQueryUrl } from "./viewers/controls";
import { is_image } from "./viewers/images/utils"
import { ExportPlugin } from "./plugins/ExportPlugin";
import { match_query } from "./utils";

import {
	projectSelector,
	projectDataSelector,
	commitSelector,
	selectedSelector,
	batchSelector,
} from './selectors/projects'




class CiCommitResults extends Component {
  constructor(props) {
    super(props);
    // we initialize optionnal controls with their defaults
    const commit_qatools_config = ((props.new_commit || {}).data || {}).qatools_config;
    const project_qatools_config = ((props.project_data || {}).data || {}).qatools_config;
    this.state = {
      controls: controls_defaults(commit_qatools_config || project_qatools_config),
      qatools_config: 'commit' // or project, to use the project-level configuration only
    };
  }

  toggle = name => () => {
    const controls = {
      ...this.state.controls,
      [name]: !this.state.controls[name],      
    }
    this.setState({controls}, updateQueryUrl(this.props.history, controls));
  }

  toggle_show = name => () => {
    const controls = {
        ...this.state.controls,
        show: {
          ...this.state.controls.show,          
          [name]: !this.state.controls.show[name],
        }
    }
    this.setState({controls}, updateQueryUrl(this.props.history, controls));
  }

  // these members help us define the metric selector
  renderMetric = (metric, { handleClick, modifiers, query }) => {
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
    return match_query(query)(`${metric.key} ${metric.label} ${metric.short_label}`)
  };


  handleClear = () => this.props.dispatch(updateSelected(this.props.project, {selected_metrics: []}));
  handleTagRemove = (_tag, index) => {
    this.deselectMetric(index);
  };
  getSelectedMetricIndex = metric => {
    return this.props.selected_metrics.indexOf(metric);
  };
  isMetricSelected(metric) {
    return this.getSelectedMetricIndex(metric) !== -1;
  }
  deselectMetric = index => {
    this.props.dispatch(updateSelected(
      this.props.project, {
        selected_metrics: this.props.selected_metrics.filter((metric, i) => i !== index)
      }))
  };
  handleMetricSelect = metric => {
    if (!this.isMetricSelected(metric)) {
      this.props.dispatch(updateSelected(
        this.props.project, {
          selected_metrics: [...this.props.selected_metrics, metric] 
        }))
    } else {
      this.deselectMetric(this.getSelectedMetricIndex(metric));
    }
  };

  fetchCommits() {
    const { project, new_commit_id, ref_commit_id, dispatch } = this.props;    
    dispatch(fetchCommit({project, id: new_commit_id, update_selected: "new_commit_id"}));
    dispatch(fetchCommit({project, id: ref_commit_id, update_selected: "ref_commit_id"}));
  }

  componentDidMount() {
    let name = this.props.project.split('/').slice(-1)[0];
    if (!!this.props.new_commit_id)
      document.title = `${this.props.new_commit_id.slice(0, 4)} - ${name}`;

    this.fetchCommits();
  }

  componentDidUpdate(prevProps) {
    // if (this.props.match.url !== prevProps.match.url) {
    //   this.fetchCommits();
    // }
    const commit_qatools_config_curr  = ((this.props.new_commit   || {}).data || {}).qatools_config;
    const project_qatools_config_curr = ((this.props.project_data || {}).data || {}).qatools_config;
    const commit_qatools_config_prev  = ((prevProps.new_commit   || {}).data || {}).qatools_config;
    const project_qatools_config_prev = ((prevProps.project_data || {}).data || {}).qatools_config;


    const qatools_config_curr = (this.state.qatools_config === 'project' ? project_qatools_config_curr : commit_qatools_config_curr) || project_qatools_config_curr;
    const qatools_config_prev = (this.state.qatools_config === 'project' ? project_qatools_config_prev : commit_qatools_config_prev) || project_qatools_config_prev;
    const new_outputs = (qatools_config_curr || {}).outputs;
    const old_outputs = (qatools_config_prev || {}).outputs;

    if (new_outputs !== old_outputs ) {
      let controls = controls_defaults(qatools_config_curr)
      this.setState({controls});
    }
  }

  update = (attribute, attribute_url) => e => {
  	const value = (e.target && e.target.value !==undefined) ? e.target.value : e;
    this.props.dispatch(updateSelected(this.props.project, { [attribute]: value }))
  } 

  render() {
    const {
      project,
      ref_commit_id,
      new_commit_id,
      new_commit,
      ref_commit,
      selected_metrics,
      new_batch_filtered,
      ref_batch_filtered,
      selected_views,
    } = this.props;
    // TODO: ugly... should do it once and save in state..
    const config_data = this.state.qatools_config === 'project' ? this.props.project_data : ({
      ...(this.props.project_data || {}),
      ...(this.props.new_commit || {}),
      data: {
        ...((this.props.project_data || {}).data || {}),
        ...((this.props.new_commit || {}).data || {}),
      }
    })

    var warning_messages = <CommitsWarningMessages
                            commits={{
                              [new_commit_id]: new_commit,
                              [ref_commit_id]: ref_commit
                            }} />;

    let clearButton =
      selected_metrics.length > 0 ? (
        <Button icon="cross" minimal={true} onClick={this.handleClear} />
      ) : null;
    let metricTableSelect = (
      <MultiSelect
        items={Object.values(this.props.available_metrics)}
        itemPredicate={this.filterMetric}
        itemRenderer={this.renderMetric}
        onItemSelect={this.handleMetricSelect}
        tagRenderer={m => m.label}
        tagInputProps={{
          onRemove: this.handleTagRemove,
          rightElement: clearButton
        }}
        noResults={noMetrics}
        selectedItems={selected_metrics}
        popoverProps={Classes.MINIMAL}
      />
    );

    const qatools_config = (config_data.data || {}).qatools_config || {};
    let config_outputs =  qatools_config.outputs || {};
    let controls_extra = config_outputs.controls || []
    let visualizations = [...(config_outputs.visualizations || []), ...(config_outputs.detailed_views || []) ]; // we allow both for some leeway with half updated projects
    let maybe_diff = visualizations.some(v => is_image(v)) && <Switch
        key='diff'
        intent={Intent.WARNING}
        checked={this.state.controls.diff || false}
        onChange={this.toggle('diff')}
        labelElement={<strong>Image Diff</strong>}
        innerLabel="off"
        innerLabelChecked="on"
    />
    let controls = <>
      {!selected_views.includes('bit-accuracy') && visualizations.map( (view, idx) => {
        if (!view.default_hidden ||
            this.state.controls.show === undefined || this.state.controls.show === null ||
            this.state.controls.show[view.name] === undefined || this.state.controls.show[view.name] === null)
          return <React.Fragment key={idx}></React.Fragment>
        return <Switch
                key={idx}
                checked={this.state.controls.show[view.name]}
                onChange={this.toggle_show(view.name)}
                label={view.label || view.name || view.path}
               />
      })}
      {maybe_diff}
      {controls_extra.map(control => {
        return <Switch
                key={control.name}
                checked={this.state.controls[control.name]}
                onChange={this.toggle(control.name)}
                label={control.label || control.name}
               />
      })}
    </>

    let show_viewer_controls = selected_views.includes('output-list') || selected_views.includes('bit-accuracy')
    // // display: flex
    // flex-wrap: wrap;
    // justify-content: space-between;
    // align-items: baseline;
    const all_controls = <>
      <div style={{display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline'}}>
        {show_viewer_controls && controls}
      </div>
      <Tabs>
          <Tabs.Expander />
          <HTMLSelect
            defaultValue={this.props.sort_by}
            onChange={this.update('sort_by')}
          >
            <option value="test_input_path">Sort by Name</option>
            {this.props.sorted_extra_parameters.map(
              param =>
                <option key={param} value={param}>
                  Sort by {param} ({this.props.extra_parameters[param].size})
                </option>            
            )}
            {Object.values(this.props.available_metrics).map(
              m => (
                <option key={m.key} value={m.key}>
                  Sort by {m.label}
                </option>
              )
            )}
          </HTMLSelect>
          <HTMLSelect
            defaultValue="descending"
            onChange={this.selectOrder}
          >
            <option value={-1}>descending</option>
            <option value={1}>ascending</option>
          </HTMLSelect>
      </Tabs>
    </>
    let show_ref_navbar = ! (selected_views.includes('logs') || selected_views.includes('tuning') || selected_views.includes('groups'))
    return (
      <Container style={{paddingTop: show_ref_navbar ? '150px' : '75px'}}>

        {(!new_commit || !ref_commit) && show_ref_navbar && <Section>
          {warning_messages}
        </Section>}

        {(!!new_commit) && (
            <>
              <Section key="filters">
                {warning_messages}
                <BatchStatusMessages batch={new_batch_filtered} />
              </Section>

              {selected_views.includes('summary') && <Section>
                <Card elevation={2}>
                  <h2 className={Classes.HEADING}>Summary</h2>
                  <MetricsSummary
                    project={project}
                    project_data={config_data}
                    available_metrics={this.props.available_metrics}
                    new_batch={new_batch_filtered}
                    ref_batch={ref_batch_filtered}
                  />
                </Card>
               </Section>}

              {selected_views.includes('parameters') && <Section>
                <Card>
                  <h2 className={Classes.HEADING}>Artifacts & Configurations</h2>
                  <CommitParameters
                    project={project}
                    project_data={config_data}
                    new_commit={new_commit}
                    ref_commit={ref_commit}
                    history={this.props.history}
                  />
                </Card>
               </Section>}

              {selected_views.includes('groups') && <Section>
                <Card>
                  <h2 className={Classes.HEADING}>Groups of tests</h2>
                  {!!(config_data.data || {}).qatools_config && <AddRecordingsForm
                    project={project}
                    project_data={config_data}
                    commit={new_commit}
                  />}
                </Card>
               </Section>}

              {selected_views.includes('tuning') && (Object.keys(qatools_config.artifacts || {}).length === 0
                ? <NonIdealState
                    icon="heatmap"
                    title={<p>Tuning requires you to define build <strong>artifacts.</strong></p>}
                    description={<p><a target="_blank" rel="noopener noreferrer" href={`${process.env.REACT_APP_QABOARD_DOCS}docs/visualizations`}>Read the docs</a> to learn how to declare visualizations.`</p>}
                  />
                : <Section>
                  <h2 className={Classes.HEADING}>Tuning Experiments</h2>
                  <Card>
                    {!!(config_data.data || {}).qatools_config && <TuningForm
                      project={project}
                      project_data={config_data}
                      commit={new_commit}
                    />}
                  </Card>
              </Section>)}

              {selected_views.includes('table-compare') && <Section>
                <Card>
                    {all_controls}
                    <h2 className={Classes.HEADING}>Improvement report</h2>
                    <TableCompare
                      sort_order={this.props.sort_order}
                      sort_by={this.props.sort_by}
                      new_batch={new_batch_filtered}
                      ref_batch={ref_batch_filtered}
                      metrics={selected_metrics}
                      input={metricTableSelect}
                    />
                </Card>
               </Section>}

              {selected_views.includes('table-kpi') && <Section>
                <Card>
                   {all_controls}
                    <h2 className={Classes.HEADING}>Quality report</h2>
                    <TableKpi
                      sort_order={this.props.sort_order}
                      sort_by={this.props.sort_by}
                      new_batch={new_batch_filtered}
                      ref_batch={ref_batch_filtered}
                      metrics={selected_metrics}
                      input={metricTableSelect}
                    />
                </Card>
               </Section>}

              {selected_views.includes('logs') && <Section>
                  {all_controls}
                  <h2 className={Classes.HEADING}>Output logs</h2>
                  <BatchLogs
                    project={project}
                    project_data={config_data}
                    commit={new_commit}
                    batch={new_batch_filtered}
                    batch_label={new_batch_filtered.label}
                    dispatch={this.props.dispatch}
                  />
               </Section>}



              {selected_views.includes('output-list') && (visualizations.length === 0
                 ? <NonIdealState
                     icon="heatmap"
                     title="Visualizations are not configured yet." 
                     description={<p><a target="_blank" rel="noopener noreferrer" href={`${process.env.REACT_APP_QABOARD_DOCS}docs/visualizations`}>Read the docs</a> to learn how to declare visualizations.`</p>}
                   />
                 : <Section>
                 {all_controls}
                  <h2 className={Classes.HEADING}>Outputs</h2>
                  <ExportPlugin
                    project={project}
                    project_data={config_data}
                    new_commit_id={this.props.new_commit_id}
                    ref_commit_id={this.props.ref_commit_id}
                    selected_batch_new={this.props.selected_batch_new}
                    selected_batch_ref={this.props.selected_batch_ref}
                    filter_batch_new={this.props.filter_batch_new}
                    filter_batch_ref={this.props.filter_batch_ref}
                  />
                  <OutputCardsList
                    project={project}
                    project_data={config_data}
                    new_commit={this.props.new_commit}
                    sort_order={this.props.sort_order}
                    sort_by={this.props.sort_by}
                    new_batch={new_batch_filtered}
                    ref_batch={ref_batch_filtered}
                    controls={this.state.controls}
                    history={this.props.history}
                    dispatch={this.props.dispatch}
                    sorted_extra_parameters={this.props.sorted_extra_parameters}
                  />
              </Section>)}

              {selected_views.includes('bit-accuracy') && <Section>
                 {all_controls}
                  <h2 className={Classes.HEADING}>Files & Bit Accuracy</h2>
                  <ExportPlugin
                    project={project}
                    project_data={config_data}
                    new_commit_id={this.props.new_commit_id}
                    ref_commit_id={this.props.ref_commit_id}
                    selected_batch_new={this.props.selected_batch_new}
                    selected_batch_ref={this.props.selected_batch_ref}
                    filter_batch_new={this.props.filter_batch_new}
                    filter_batch_ref={this.props.filter_batch_ref}
                  />
                  <OutputCardsList
                    type='bit_accuracy'
                    project={project}
                    project_data={config_data}
                    new_commit={this.props.new_commit}
                    sort_order={this.props.sort_order}
                    sort_by={this.props.sort_by}
                    new_batch={new_batch_filtered}
                    ref_batch={ref_batch_filtered}
                    controls={this.state.controls}
                    history={this.props.history}
                    dispatch={this.props.dispatch}
                    sorted_extra_parameters={this.props.sorted_extra_parameters}
                  />
               </Section>}

              {selected_views.includes('optimization') && <Section>
                <Card>
                  <h2 className={Classes.HEADING}>Tuning understanding</h2>
                  <TuningExploration
                    project={project}
                    project_data={config_data}
                    batch={new_batch_filtered}
                   />
                </Card>
               </Section>}

            </>
          )}
      </Container>
    );
  }
}




const mapStateToProps = (state, ownProps) => {
    const params = new URLSearchParams(ownProps.location.search);

    let project = projectSelector(state)
    let project_data = projectDataSelector(state)


    let selected = selectedSelector(state)
    let new_commit_id = selected.new_commit_id
    let ref_commit_id = selected.ref_commit_id
    let filter_batch_new = selected.filter_batch_new
    let filter_batch_ref = selected.filter_batch_ref

    let { new_commit, ref_commit } = commitSelector(state)

    let {
    	selected_batch_new,
    	selected_batch_ref,
    	new_batch,
    	ref_batch,
    	new_batch_filtered,
    	ref_batch_filtered,
    } = batchSelector(state)

    // metrics
    const commit_qatools_metrics  = ((new_commit   || {}).data || {}).qatools_metrics;
    const project_qatools_metrics = ((project_data || {}).data || {}).qatools_metrics;
    const metrics = commit_qatools_metrics || project_qatools_metrics
    let available_metrics = metrics.available_metrics || {}
    let selected_metrics = selected.selected_metrics || (metrics.main_metrics || []).map(k => available_metrics[k])

    // tuned_parameters holds all tuning values used for each parameter
    let extra_parameters = {};
    Object.entries(new_batch.outputs).forEach(([id, o]) => {
      Object.entries(o.extra_parameters).forEach(([param, value]) => {
        if (extra_parameters[param] === undefined)
          extra_parameters[param] = new Set();
        extra_parameters[param].add(value);
      });
    });
    // we sort tuned parameters by the number of different values that were used
    let sorted_extra_parameters = Object.entries(extra_parameters)
      .sort(([p1, s1], [p2, s2]) => s2.size - s1.size)
      .map(([k, v]) => k);

    let selected_views = (state.selected[project] && state.selected[project].selected_views) || (((project_data.data || {}).qatools_config || {}).outputs || {}).default_tab_details || "summary";
    if (!Array.isArray(selected_views))
      selected_views = [selected_views]
    // Avoid issues with output_list/output-list...
    selected_views = selected_views.map(v => v.replace('_', '-'))
    return {
      params,
      project,
      project_data,
      // metrics
      available_metrics,
      selected_metrics,
      // selected commit
      new_commit_id,
      ref_commit_id,
      new_commit,
      ref_commit,
      // selected batch
      selected_batch_new,
      selected_batch_ref,
      // tuning...
      extra_parameters,
      sorted_extra_parameters,
      // filters
      filter_batch_new,
      filter_batch_ref,
      new_batch,
      ref_batch,
      new_batch_filtered,
      ref_batch_filtered,
      // FIXME: memoize with reselect
      // getFilteredBatch() ...
      selected_views,

      sort_by: params.get("sort_by") || (state.selected[project] && state.selected[project].sort_by) || metrics.default_metric || "input_test_path",
      sort_order: params.get("sort_order") || (state.selected[project] && state.selected[project].sort_order) || -1,
    }
}

export default withRouter(connect(mapStateToProps)(CiCommitResults) );
