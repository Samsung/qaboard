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
import { CommitInfoCompareCard } from "./components/CommitInfoCompareCard";
import { MetricsSummary } from "./components/metrics";
import { CommitsWarningMessages, BatchStatusMessages } from "./components/messages";

import { matching_output, sortOutputs, filter_batch } from "./utils";
import { TableCompare, TableKpi } from "./components/tables";
import { BatchLogs } from "./components/BatchLogs";
import { CommitParameters } from "./components/Parameters";
import { OutputCard } from "./viewers/OutputCard";
import { fetchCommit } from "./actions/commit";
import { updateSelected } from "./actions/selected";


import { AddRecordingsForm, TuningForm } from "./components/tuning/forms";
import { TuningExploration } from "./components/tuning/TuningExploration";
import { SelectBatches } from "./components/tuning/SelectBatches";


import {
  default_project,
  default_selected,
  empty_batch,
} from "./defaults"




class CiCommitResults extends Component {
  constructor(props) {
    super(props);
    this.state = {
      controls: {},
    }
  }


  toggle = name => () => {
    this.setState( (previousState, props) => ({
      controls: {
        ...previousState.controls,
        [name]: !this.state[name],
      }
    }))    
  }

  toggle_show = idx => () => {
    this.setState( (previousState, props) => ({
      controls: {
        ...previousState.controls,
        show: {
          ...previousState.controls.show,          
          [idx]: !this.state[idx],
        }
      }
    }))    
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
  }

  // callbacl used when the user want to change the reference commit
  handleSubmitReference = new_ref_commit_id => {
    const { project, ref_commit, ref_commit_id, dispatch } = this.props;
    let is_git = ref_commit.type === "git";
    if (
      (is_git &&
        new_ref_commit_id.substring(0, 8) !== ref_commit_id.substring(0, 8)) ||
      (!is_git && new_ref_commit_id !== ref_commit_id)
    ) {
      let query = qs.parse(this.props.location.search.substring(1));
      this.props.history.push({
        pathname: this.props.location.pathname,
        search: qs.stringify({
          ...query,
          reference: new_ref_commit_id
        })
      });
      dispatch(fetchCommit(project, new_ref_commit_id, "ref_commit_id"));
      dispatch(updateSelected(project, { ref_commit_id: new_ref_commit_id }))
    }
  };

  selectSortBy = e => {
    this.props.dispatch(updateSelected(this.props.project, { sort_by: e.target.value }))
  };
  selectOrder = e => {
    this.props.dispatch(updateSelected(this.props.project, { order: e.target.value }))
  };

  selectBatchNew = e => {
    this.props.dispatch(updateSelected(this.props.project, { batch_new: e.target.value }))
    let query = qs.parse(this.props.location.search.substring(1));
    this.props.history.push({
      pathname: this.props.location.pathname,
      search: qs.stringify({
        ...query,
        batch_new: e.target.value
      })
    });
  };

  selectBatchRef = e => {
    this.props.dispatch(updateSelected(this.props.project, { batch_ref: e.target.value }))
    let query = qs.parse(this.props.location.search.substring(1));
    this.props.history.push({
      pathname: this.props.location.pathname,
      search: qs.stringify({
        ...query,
        batch_reference: e.target.value
      })
    });
  };

  UpdateFilterBatchNew = e => {
    this.props.dispatch(updateSelected(this.props.project, { filter_batch_new: e.target.value }))
    let query = qs.parse(this.props.location.search.substring(1));
    this.props.history.push({
      pathname: this.props.location.pathname,
      search: qs.stringify({
        ...query,
        filter: e.target.value
      })
    });
  };
  UpdateFilterBatchRef = e => {
    this.props.dispatch(updateSelected(this.props.project, { filter_batch_ref: e.target.value }))
    this.setState({ filter_batch_ref: e.target.value });
    let query = qs.parse(this.props.location.search.substring(1));
    this.props.history.push({
      pathname: this.props.location.pathname,
      search: qs.stringify({
        ...query,
        filter_ref: e.target.value
      })
    });
  };


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

    let controls_extra = project_data.information.qatools_config.outputs.controls || []
    let detailed_views = project_data.information.qatools_config.outputs.detailed_views || []
    let controls = <>
      {detailed_views.map( (view, idx) => {
        if (!view.default_hidden) return <></>
        return <Switch
                key={idx}
                hidden={!view.default_hidden}
                defaultChecked={false}
                onChange={this.toggle_show(idx)}
                label={view.label || view.name || view.path}
               />
      })}
      {controls_extra.map(control => {
        return <Switch
                defaultChecked={control.default || false}
                onChange={this.toggle(control.name)}
                label={control.label || control.name}
               />
      })}
    </>


    return (
      <Container>
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

        {(!new_commit || !ref_commit) && <Section>
          {warning_messages}
        </Section>}

        {(!!new_commit && !!ref_commit) && (
            <>
              <Section>
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
                        onChange={this.selectBatchNew}
                        prefix={<Tag intent={Intent.WARNING}>New commit</Tag>}
                      />
                      <FormGroup
                        labelFor="filter-new-input"
                        helperText={`${
                          !this.props.filter_batch_new
                            ? "You can filter outputs by all their properties. "
                            : ""
                        }${
                          Object.keys(new_batch_filtered.outputs || []).length
                        } selected`}
                      >
                        <InputGroup
                          value={this.props.filter_batch_new}
                          placeholder="Input path, tags, platform, configuration, or tuning parameters (key:value)"
                          onChange={this.UpdateFilterBatchNew}
                          type="search"
                          leftIcon="search"
                        />
                      </FormGroup>
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
                        onChange={this.selectBatchRef}
                        prefix={
                          <Tag intent={Intent.PRIMARY}>Reference commit</Tag>
                        }
                      />
                      <FormGroup
                        labelFor="filter-ref-input"
                        helperText={`${
                          Object.keys(ref_batch_filtered.outputs || []).length
                        } selected.`}
                      >
                        <InputGroup
                          value={this.props.filter_batch_ref}
                          placeholder="Input path, tags, platform, configuration, or tuning parameters (key:value)"
                          onChange={this.UpdateFilterBatchRef}
                          type="search"
                          rightIcon="search"
                        />
                      </FormGroup>
                    </div>
                  </div>
                </Card>
              </Section>

              <Section>
                {warning_messages}
                <BatchStatusMessages batch={new_batch_filtered} />
              </Section>

              <Section>
                <Card elevation={2}>
                  <Tabs
                    renderActiveTabPanelOnly
                    id="tabs-summary"
                    onChange={(newTabId, prevTabId, event) => {
                      this.props.dispatch(updateSelected(this.props.project, { selected_tab_summary: newTabId }))
                    }}
                    selectedTabId={this.props.selected_tab_summary}
                  >
                    <Tab
                      id="metrics"
                      title="Performance Summary"
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
                        />
                      }
                    />
                    <Tab
                      id="recordings"
                      title="Recording Groups"
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
                    />
                  </Tabs>
                </Card>
              </Section>

              <Section>
                <Tabs
                  renderActiveTabPanelOnly
                  id="tabs-outputs"
                  onChange={(newTabId, prevTabId, event) => {
                    this.props.dispatch(updateSelected(this.props.project, { selected_tab_details: newTabId }))
                  }}
                  selectedTabId={this.props.selected_tab_details}
                >
                  <Tab
                    id="output-table-compare"
                    title="Improvement"
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
                    id="output-table-kpi"
                    title="KPI report"
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
                    id="tuning-results"
                    title="Tuning exploration"
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
                    onChange={this.selectSortBy}
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
      select_debug: ""
    };
  }

  render() {
    const { new_batch, ref_batch, sort_by, sort_order, controls } = this.props;
    const { project, project_data } = this.props;
    // FIXME: workaround to compare local commits versus git-ci commits
    // https://github.com/bvaughn/react-virtualized/blob/master/docs/List.md
    return (
      <>
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
            .sort(sortOutputs(sort_by, sort_order))
            .map(([id, output]) => {
              let { output_ref, warning } = matching_output({
                output: output,
                batch: ref_batch
              });
              return (
                <OutputCard
                  key={id}
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
    // project information
    let project = params.get("project") || state.selected.project;
    let project_data = state.projects.data[project] || default_project
    // metrics
    let project_metrics = project_data.information.qatools_metrics
    let available_metrics = project_metrics.available_metrics
    // selected commit
    // FIXME: remove except state/default?
    let default_selected_ = default_selected();
    let new_commit_id = (state.selected[project] && state.selected[project].new_commit_id) || default_selected_.new_commit_id
    let ref_commit_id = (state.selected[project] && state.selected[project].ref_commit_id) || default_selected_.ref_commit_id

    let new_commit = state.commits[new_commit_id];
    let ref_commit = ref_commit_id && state.commits[ref_commit_id];
    // selected batch
    let selected_batch_new = (state.selected[project] && state.selected[project].batch_new) || default_selected_.batch_new
    let selected_batch_ref = (state.selected[project] && state.selected[project].batch_ref) || default_selected_.batch_ref
    let new_batch = ((!!new_commit && !!new_commit.batches) ? new_commit.batches[selected_batch_new] : empty_batch) || empty_batch;
    let ref_batch = ((!!ref_commit && !!ref_commit.batches) ? ref_commit.batches[selected_batch_ref] : empty_batch) || empty_batch;
    if (!new_batch.outputs)
      new_batch.outputs = {}
    if (!ref_batch.outputs)
      ref_batch.outputs = {}
    // filtering
    // FIXME: add missing null/undefined checks
    let filter_batch_new = (state.selected[project] && state.selected[project].filter_batch_new) || default_selected_.filter_batch_new
    let filter_batch_ref = (state.selected[project] && state.selected[project].filter_batch_ref) || default_selected_.filter_batch_ref
    let new_batch_filtered = filter_batch(new_batch, filter_batch_new);
    let ref_batch_filtered = filter_batch(ref_batch, filter_batch_ref);
    // summary results

    let selected_metrics = (state.selected[project] && state.selected[project].selected_metrics) || project_metrics.main_metrics.map(k => available_metrics[k])

    let selected_tab_summary = (state.selected[project] && state.selected[project].selected_tab_summary) || "metrics";
    let selected_tab_details = (state.selected[project] && state.selected[project].selected_tab_details) || "output-table-compare";

    return {
      // project information
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
      new_batch_filtered,
      ref_batch_filtered,
      // FIXME: memoize with reselect
      // getFilteredBatch() ...
      selected_tab_summary,
      selected_tab_details,

      sort_by: (state.selected[project] && state.selected[project].sort_by) || project_metrics.default_metric || "input_test_path",
      order: (state.selected[project] && state.selected[project].order) || -1,
    }
}

export default withRouter(connect(mapStateToProps)(CiCommitResults) );
