import React, { Component } from "react";
import { connect } from 'react-redux'
import { withRouter } from "react-router";
import qs from "qs";

import {
  FormGroup,
  HTMLSelect,
  Switch,
  Classes,
  Button,
  MenuItem,
  Tag,
  InputGroup,
  Callout,
  Card,
  Tab,
  Tabs,
  Intent,
} from "@blueprintjs/core";
import { MultiSelect } from "@blueprintjs/select";
import { noMetrics } from "./components/metricSelect";

import { Container, Section } from "./components/layout";
import CommitInfoCompareCard from "./components/CommitInfoCompareCard";
import { MetricsSummary } from "./components/metrics";
import { CommitsWarningMessages, BatchStatusMessages } from "./components/messages";

import { matching_output, sortOutputs } from "./utils";
import { TableCompare, TableKpi } from "./components/tables";
import { BatchLogs } from "./components/BatchLogs";
import { CommitParameters } from "./components/Parameters";
import { OutputCard } from "./viewers/OutputCard";
import { bit_accuracy_help } from "./viewers/bit_accuracy/utils";
import { fetchCommit } from "./actions/commit";
import { updateSelected } from "./actions/selected";


import { TuningForm } from "./components/tuning/forms";
import { AddRecordingsForm } from "./components/tuning/form_groups";
import { TuningExploration } from "./components/tuning/TuningExploration";
import { SelectBatches } from "./components/tuning/SelectBatches";
import { controls_defaults, updateQueryUrl } from "./viewers/controls";

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
    this.state = {
      controls: controls_defaults(props),
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
    let searched = `${metric.key} ${metric.label} ${
      metric.short_label
    }`.toLowerCase();
    let search = query.toLowerCase();
    return searched.indexOf(search) >= 0;
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
    dispatch(fetchCommit(project, new_commit_id, "new_commit_id"));
    dispatch(fetchCommit(project, ref_commit_id, "ref_commit_id"));
  }

  componentDidMount() {
    document.title = this.props.new_commit_id;
    this.fetchCommits();
  }

  componentDidUpdate(prevProps) {
    if (this.props.match.url !== prevProps.match.url) {
      this.fetchCommits();
    }
    const new_controls = ((((this.props.project_data || {}).information || {}).qatools_config || {}).outputs || {}).controls;
    const old_controls = ((((prevProps.project_data || {}).information || {}).qatools_config || {}).outputs || {}).controls;
    if (old_controls !== new_controls) {
      this.setState({controls: controls_defaults(this.props)});
    }
  }



  
  update = (attribute, attribute_url) => e => {
  	const value = (e.target && e.target.value !==undefined) ? e.target.value : e;
    this.props.dispatch(updateSelected(this.props.project, { [attribute]: value }))
    let query = qs.parse(window.location.search.substring(1));
    this.props.history.push({
      pathname: window.location.pathname,
      search: qs.stringify({
        ...query,
        [attribute_url || attribute]: value,
      })
    });
  } 


  render() {
    const {
      project,
      project_data,
      ref_commit_id,
      new_commit_id,
      new_commit,
      ref_commit,
      selected_batch_new,
      selected_batch_ref,
      selected_metrics,
      new_batch_filtered,
      ref_batch_filtered,
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

    
    let controls_extra = (project_data.information.qatools_config.outputs || {}).controls || []
    let detailed_views = (project_data.information.qatools_config.outputs || {}).detailed_views || []
    let controls = <>
      {detailed_views.map( (view, idx) => {
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
      {controls_extra.map(control => {
        return <Switch
                key={control.name}
                checked={this.state.controls[control.name]}
                onChange={this.toggle(control.name)}
                label={control.label || control.name}
               />
      })}
    </>


    const nb_good = batch => (Object.values(batch.outputs).filter(o => !o.is_failed && !o.is_pending) || []).length
    const nb_outputs_new = nb_good(this.props.new_batch);
    const nb_outputs_ref = nb_good(this.props.ref_batch);
    const nb_outputs_filtered_new = nb_good(new_batch_filtered);
    const nb_outputs_filtered_ref = nb_good(ref_batch_filtered);
    return (
      <Container>
        <Section>
          <CommitInfoCompareCard
            project={project}
            new_commit={new_commit}
            ref_commit={ref_commit}
            new_label={selected_batch_new}
            ref_label={selected_batch_ref}
          />
        </Section>

        {(!new_commit || !ref_commit) && <Section>
          {warning_messages}
        </Section>}

        {(!!new_commit) && (
            <>
              <Section key="high-level">
                <Card elevation={0}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center"
                    }}
                  >
                    <div
                      style={{
                        flex: "1 1 auto",
                        minWidth: "510px",
                        maxWidth: "510px"
                      }}
                    >
                      <SelectBatches
                        commit={new_commit}
                        selected={selected_batch_new}
                        onChange={this.update('batch_new')}
                        prefix={<Tag intent={Intent.WARNING}>New commit</Tag>}
                      />
                      {nb_outputs_new>0 && <FormGroup
                        labelFor="filter-new-input"
                        helperText={`${
                          !this.props.filter_batch_new
                            ? "You can filter outputs by all their properties. "
                            : ""
                        }${nb_outputs_filtered_new} selected`}
                      >
                        <InputGroup
                          value={this.props.filter_batch_new}
                          placeholder="Input path, tags, platform, configuration, or tuning parameters (key:value)"
                          onChange={this.update('filter_batch_new', 'filter')}
                          type="search"
                          leftIcon="search"
                        />
                      </FormGroup>}
                    </div>
                    <div
                      style={{
                        flex: "1 1 auto",
                        minWidth: "490px",
                        maxWidth: "490px",
                        textAlign: "right"
                      }}
                    >
                      <SelectBatches
                        commit={ref_commit}
                        selected={selected_batch_ref}
                        onChange={this.update('batch_ref', 'batch_reference')}
                        prefix={
                          <Tag intent={Intent.PRIMARY}>Reference commit</Tag>
                        }
                      />
                      {nb_outputs_ref > 0 && <FormGroup
                        labelFor="filter-ref-input"
                        helperText={`${nb_outputs_filtered_ref} selected.`}
                      >
                        <InputGroup
                          value={this.props.filter_batch_ref}
                          placeholder="Input path, tags, platform, configuration, or tuning parameters (key:value)"
                          onChange={this.update('filter_batch_ref, filter_ref')}
                          type="search"
                          rightIcon="search"
                        />
                      </FormGroup>}
                    </div>
                  </div>
                </Card>
              </Section>

              <Section key="filters">
                {warning_messages}
                <BatchStatusMessages batch={new_batch_filtered} />
              </Section>

              <Section key="summary">
                <Card elevation={2}>
                  <Tabs
                    renderActiveTabPanelOnly
                    id="tabs-summary"
                    onChange={this.update('selected_tab_summary')}
                    selectedTabId={this.props.selected_tab_summary}
                  >
                    <Tab
                      id="summary"
                      title="Summary"
                      panel={
                        <MetricsSummary
                          project={project}
                          project_data={project_data}
                          available_metrics={this.props.available_metrics}
                          new_batch={new_batch_filtered}
                          ref_batch={ref_batch_filtered}
                        />
                      }
                    />
                    <Tab
                      id="parameters"
                      title="Configurations"
                      panel={
                        <CommitParameters
                          project={project}
                          new_commit={new_commit}
                          ref_commit={ref_commit}
                        />
                      }
                    />
                    <Tab
                      id="groups"
                      title="Groups of Tests"
                      disabled={false}
                      panel={
                        <AddRecordingsForm
                          project={project}
                          project_data={this.props.project_data}
                          commit={new_commit}
                        />
                      }
                    />
                    <Tab
                      id="tuning"
                      title="Extra Runs & Tuning"
                      panel={
                        <TuningForm project={project} project_data={this.props.project_data} commit={new_commit} />
                      }
                      disabled={false}
                    />
                  </Tabs>
                </Card>
              </Section>

              <Section key="details">
                <Tabs
                  renderActiveTabPanelOnly
                  id="tabs-outputs"
                  onChange={this.update('selected_tab_details')}
                  selectedTabId={nb_outputs_new > 0 ? this.props.selected_tab_details : "logs"}
                >
                  <Tab
                    id="table-compare"
                    title="Improvement"
                    disabled={nb_outputs_new===0}
                    panel={
                      <div>
                        <h2 className={Classes.HEADING}>Improvement report</h2>
                        <TableCompare
                          sort_order={this.props.order}
                          sort_by={this.props.sort_by}
                          new_batch={new_batch_filtered}
                          ref_batch={ref_batch_filtered}
                          metrics={selected_metrics}
                          input={metricTableSelect}
                        />
                      </div>
                    }
                  />
                  <Tab
                    id="table-kpi"
                    title="KPI report"
                    disabled={nb_outputs_new===0}
                    panel={
                      <div>
                        <h2 className={Classes.HEADING}>Quality report</h2>
                        <TableKpi
                          sort_order={this.props.order}
                          sort_by={this.props.sort_by}
                          new_batch={new_batch_filtered}
                          ref_batch={ref_batch_filtered}
                          metrics={selected_metrics}
                          input={metricTableSelect}
                        />
                      </div>
                    }
                  />
                  <Tab
                    id="logs"
                    title="Logs"
                    panel={
                      <BatchLogs
                        batch={new_batch_filtered}
                        batch_label={new_batch_filtered.label}
                      />
                    }
                  />
                  <Tab
                    id="output-list"
                    title="Detailed outputs"
                    disabled={nb_outputs_new===0}
                    panel={
                      <OutputList
                        project={project}
                        project_data={project_data}
                        sort_order={this.props.order}
                        sort_by={this.props.sort_by}
                        new_batch={new_batch_filtered}
                        ref_batch={ref_batch_filtered}
                        controls={this.state.controls}
                      />
                    }
                  />
                  <Tab
                    id="bit-accuracy"
                    title="Bit accuracy"
                    disabled={nb_outputs_new===0}
                    panel={
                      <OutputList
                        type='bit_accuracy'
                        project={project}
                        project_data={project_data}
                        sort_order={this.props.order}
                        sort_by={this.props.sort_by}
                        new_batch={new_batch_filtered}
                        ref_batch={ref_batch_filtered}
                        controls={this.state.controls}
                      />
                    }
                  />
                  <Tab
                    id="tuning-results"
                    title="Tuning exploration"
                    disabled={nb_outputs_new===0}
                    panel={
                      <TuningExploration
                        project={project}
                        project_data={project_data}
                        batch={new_batch_filtered}
                      />
                    }
                  />
                  <Tabs.Expander />
                  {controls}
                  <HTMLSelect
                    defaultValue={this.props.sort_by}
                    onChange={this.update('sort_by')}
                  >
                    <option value="test_input_path">Sort by Name</option>
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
              </Section>
            </>
          )}
      </Container>
    );
  }
}

class OutputList extends Component {
  constructor(props) {
    super(props);
    this.state = {
      select_debug: "",
      show_all_files: false,
    };
  }

  render() {
    const { new_batch, ref_batch, sort_by, sort_order, controls, type } = this.props;
    const { project, project_data } = this.props;
    // https://github.com/bvaughn/react-virtualized/blob/master/docs/List.md

    return (
      <>
        {type === 'bit_accuracy' && 
          <Callout style={{marginBottom: '20px', display: 'flex', justifyContent: 'space-between'}}>
            <FormGroup
              inline
              labelFor="show-all-files"
              helperText="By default the only files shown are those that are different/added/removed."
              style={{flex: '50 1 auto'}}
            >
              <Switch
                label="Show all files"
                checked={this.state.show_all_files}
                onChange={e => this.setState({ show_all_files: !this.state.show_all_files})}
                style={{ width: "300px" }}
              />
            </FormGroup>
            <span style={{flex: '1 1 auto'}}>{bit_accuracy_help}</span>
          </Callout>
        }
        {controls.show_debug && (
          <FormGroup
            label="Show debug outputs matching"
            labelFor="show-debug-input"
            helperText="You can select any number of debug outputs."
            style={{ marginBottom: "30px" }}
          >
            <InputGroup
              value={this.state.select_debug_input}
              placeholder="ransac points"
              onChange={e => this.setState({ select_debug: e.target.value })}
              leftIcon="series-add"
              style={{ width: "300px" }}
            />
          </FormGroup>
        )}
        {ref_batch.label !== "default" && (
          <Callout intent={Intent.WARNING}>
            We compare each output to <strong>any</strong> reference outputs
            with matching recording+configuration+platform,{" "}
            <strong>without looking at the tuning parameters</strong>.
          </Callout>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            flexFlow: "row wrap"
          }}
        >
          {Object.entries(new_batch.outputs)
            .filter( ([id, output]) => output.output_type!=="optim_iteration")
            .sort(sortOutputs(sort_by, sort_order))
            .map(([id, output]) => {
              let { output_ref, warning } = matching_output({
                output: output,
                batch: ref_batch
              });
              return (
                <OutputCard
                  key={id}
                  type={this.props.type}
                  show_all_files={this.state.show_all_files}
                  project={project}
                  project_data={project_data}
                  output_type={output.output_type}
                  output_new={output}
                  output_ref={output_ref}
                  warning={warning}
                  controls={controls}
                  select_debug={this.state.select_debug}
                />
              );
            })}
        </div>
      </>
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
    // console.log(commitSelector(state))

    let {
    	selected_batch_new,
    	selected_batch_ref,
    	new_batch,
    	ref_batch,
    	new_batch_filtered,
    	ref_batch_filtered,
    } = batchSelector(state)
    // console.log(batchSelector(state))


    // metrics
    let project_metrics = project_data.information.qatools_metrics
    let available_metrics = project_metrics.available_metrics
    let selected_metrics = selected.selected_metrics || project_metrics.main_metrics.map(k => available_metrics[k])


    let selected_tab_summary = (state.selected[project] && state.selected[project].selected_tab_summary) || "summary";
    let selected_tab_details = (state.selected[project] && state.selected[project].selected_tab_details) || (project_data.information.qatools_config.outputs || {}).default_tab_details || 'table-compare';
    console.log('selected_tab_summary', selected_tab_summary)
    console.log('selected_tab_details', selected_tab_details)

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
      // filters
      filter_batch_new,
      filter_batch_ref,
      new_batch,
      ref_batch,
      new_batch_filtered,
      ref_batch_filtered,
      // FIXME: memoize with reselect
      // getFilteredBatch() ...
      selected_tab_summary,
      selected_tab_details,

      sort_by: params.get("sort_by") || (state.selected[project] && state.selected[project].sort_by) || project_metrics.default_metric || "input_test_path",
      order: params.get("order") || (state.selected[project] && state.selected[project].order) || -1,
    }
}

export default withRouter(connect(mapStateToProps)(CiCommitResults) );
