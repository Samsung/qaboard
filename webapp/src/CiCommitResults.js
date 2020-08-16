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
	configSelector,
	commitSelector,
	selectedSelector,
	batchSelector,
} from './selectors/projects'




class CiCommitResults extends Component {
  constructor(props) {
    super(props);
    // we initialize optionnal controls with their defaults
    this.state = {
      controls: controls_defaults(this.props.config),
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
    const config_curr = this.props.config;
    const config_prev = prevProps.config;
    const new_outputs = (config_curr || {}).outputs;
    const old_outputs = (config_prev || {}).outputs;

    if (new_outputs !== old_outputs ) {
      let controls = controls_defaults(config_curr)
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
      git,
      config,
      metrics,
      ref_commit_id,
      new_commit_id,
      new_commit,
      ref_commit,
      available_metrics,
      selected_metrics,
      new_batch,
      ref_batch,
      selected_views,
    } = this.props;

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
        items={Object.values(available_metrics)}
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

    let config_outputs =  config.outputs || {};
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
            <option value="id">Sort by ID</option>
            {new_batch.sorted_extra_parameters.map(
              param =>
                <option key={param} value={param}>
                  Sort by {param} ({new_batch.extra_parameters[param].size})
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
            onChange={this.update('sort_order')}
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
                <BatchStatusMessages batch={new_batch} />
              </Section>

              {selected_views.includes('summary') && <Section>
                <Card elevation={2}>
                  <h2 className={Classes.HEADING}>Summary</h2>
                  <MetricsSummary
                    project={project}
                    metrics={metrics}
                    available_metrics={available_metrics}
                    new_batch={new_batch}
                    ref_batch={ref_batch}
                  />
                </Card>
               </Section>}

              {selected_views.includes('parameters') && <Section>
                <Card>
                  <h2 className={Classes.HEADING}>Artifacts & Configurations</h2>
                  <CommitParameters
                    project={project}
                    config={config}
                    new_commit={new_commit}
                    ref_commit={ref_commit}
                    history={this.props.history}
                  />
                </Card>
               </Section>}

              {selected_views.includes('groups') && <Section>
                <Card>
                  <h2 className={Classes.HEADING}>Groups of tests</h2>
                  <AddRecordingsForm
                    project={project}
                    git={git}
                    commit={new_commit}
                    config={config}
                  />
                </Card>
               </Section>}

              {selected_views.includes('tuning') && (Object.keys(config.artifacts || {}).length === 0
                ? <NonIdealState
                    icon="heatmap"
                    title={<p>Tuning requires you to define build <strong>artifacts.</strong></p>}
                    description={<p><a target="_blank" rel="noopener noreferrer" href={`${process.env.REACT_APP_QABOARD_DOCS_ROOT}docs/visualizations`}>Read the docs</a> to learn how to declare visualizations.`</p>}
                  />
                : <Section>
                  <h2 className={Classes.HEADING}>Tuning Experiments</h2>
                  <Card>
                    <TuningForm
                      project={project}
                      config={config}
                      metrics={metrics}
                      commit={new_commit}
                    />
                  </Card>
              </Section>)}

              {selected_views.includes('table-compare') && <Section>
                <Card>
                    {all_controls}
                    <h2 className={Classes.HEADING}>Improvement report</h2>
                    <TableCompare
                      new_batch={new_batch}
                      ref_batch={ref_batch}
                      metrics={selected_metrics}
                      available_metrics={available_metrics}
                      input={metricTableSelect}
                    />
                </Card>
               </Section>}

              {selected_views.includes('table-kpi') && <Section>
                <Card>
                   {all_controls}
                    <h2 className={Classes.HEADING}>Quality report</h2>
                    <TableKpi
                      new_batch={new_batch}
                      ref_batch={ref_batch}
                      metrics={selected_metrics}
                      available_metrics={available_metrics}
                      input={metricTableSelect}
                    />
                </Card>
               </Section>}

              {selected_views.includes('logs') && <Section>
                  {all_controls}
                  <h2 className={Classes.HEADING}>Output logs</h2>
                  <BatchLogs
                    project={project}
                    commit={new_commit}
                    batch={new_batch}
                    batch_label={new_batch.label}
                    dispatch={this.props.dispatch}
                  />
               </Section>}



              {selected_views.includes('output-list') && (visualizations.length === 0
                 ? <NonIdealState
                     icon="heatmap"
                     title="Visualizations are not configured yet." 
                     description={<p><a target="_blank" rel="noopener noreferrer" href={`${process.env.REACT_APP_QABOARD_DOCS_ROOT}docs/visualizations`}>Read the docs</a> to learn how to declare visualizations.`</p>}
                   />
                 : <Section>
                 {all_controls}
                  <h2 className={Classes.HEADING}>Outputs</h2>
                  <ExportPlugin
                    project={project}
                    config={config}
                    new_commit_id={this.props.new_commit_id}
                    ref_commit_id={this.props.ref_commit_id}
                    selected_batch_new={this.props.selected_batch_new}
                    selected_batch_ref={this.props.selected_batch_ref}
                    filter_batch_new={this.props.filter_batch_new}
                    filter_batch_ref={this.props.filter_batch_ref}
                  />
                  <OutputCardsList
                    project={project}
                    config={config}
                    metrics={metrics}
                    new_commit={this.props.new_commit}
                    new_batch={new_batch}
                    ref_batch={ref_batch}
                    controls={this.state.controls}
                    history={this.props.history}
                    dispatch={this.props.dispatch}
                  />
              </Section>)}

              {selected_views.includes('bit-accuracy') && <Section>
                 {all_controls}
                  <h2 className={Classes.HEADING}>Files & Bit Accuracy</h2>
                  <ExportPlugin
                    project={project}
                    config={config}
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
                    config={config}
                    metrics={metrics}
                    new_commit={this.props.new_commit}
                    new_batch={new_batch}
                    ref_batch={ref_batch}
                    controls={this.state.controls}
                    history={this.props.history}
                    dispatch={this.props.dispatch}
                  />
               </Section>}

              {selected_views.includes('optimization') && <Section>
                <Card>
                  <h2 className={Classes.HEADING}>Auto-Tuning Analysis</h2>
                  <TuningExploration
                    project={project}
                    metrics={metrics}
                    batch={new_batch}
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
    } = batchSelector(state)

    let { git, config, metrics, selected_metrics } = configSelector(state)
    let { available_metrics } = metrics;


    let selected_views = selected.selected_views || (config.outputs || {}).default_tab_details || "summary";
    if (!Array.isArray(selected_views))
      selected_views = [selected_views]
    // Avoid issues with output_list/output-list...
    selected_views = selected_views.map(v => v.replace('_', '-'))
    return {
      params,
      project,
      config,
      metrics,
      git,
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
      // filters
      filter_batch_new,
      filter_batch_ref,
      new_batch,
      ref_batch,
      selected_views,

      sort_by: selected.sort_by,
      sort_order: selected.sort_order || 'input_test_path',
    }
}

export default withRouter(connect(mapStateToProps)(CiCommitResults) );
