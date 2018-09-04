import React, { Component, Fragment } from "react";
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
  ProgressBar,
} from "@blueprintjs/core";
import { MultiSelect } from "@blueprintjs/select";
import { noMetrics } from "./common/metricSelect";

import { Container, Section } from "./common/containers";
import { CommitInfoCompareCard } from "./CommitInfoCompareCard";
import { MetricsSummary } from "./MetricsSummary";
import { CommitsWarningMessages, BatchStatusMessages } from "./components/messages";

import { matching_output, sortOutputs, filter_batch } from "./common/utils";
import { TableCompare, TableKpi } from "./Tables";
import { BatchLogs } from "./BatchLogs";
import { CommitParameters } from "./Parameters";
import { OutputCard } from "./OutputCard";
import { fetchCommit } from "./actions/commit";
import { updateSelected } from "./actions/selected";


import { AddRecordingsForm, TuningForm } from "./tuning/TuningForm";
import { TuningExploration } from "./tuning/TuningExploration";
import { SelectBatches } from "./tuning/SelectBatches";


import {
  default_project,
  default_selected
} from "./defaults"


class CiCommitResults extends Component {
  constructor(props) {
    super(props);
    this.state = {
      selectedTabId: this.props.project === "tof/swip_tof" ? "output-list" : "output-table-compare",
      // FIX: SLAM-specific
      show_videos: false,
      show_3d: false,
      show_debug: false
    }
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
  handleClear = () => this.setState({ selected_metrics: [] });
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
    this.setState({
      selected_metrics: this.props.selected_metrics.filter(
        (metric, i) => i !== index
      )
    });
  };
  handleMetricSelect = metric => {
    if (!this.isMetricSelected(metric)) {
      this.setState({
        selected_metrics: [...this.props.selected_metrics, metric]
      });
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
    this.props.dispatch(updateSelected(this.props.project, { selected_batch_new: e.target.value }))
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
    this.props.dispatch(updateSelected(this.props.project, { selected_batch_ref: e.target.value }))
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

  toogleShowDebug = () => {
    let previous_value = this.state.show_debug;
    this.setState({
      show_debug: !previous_value
    });
  };
  toogleShowVideos = () => {
    let previous_value = this.state.show_videos;
    this.setState({
      show_videos: !previous_value
    });
  };
  toogleShow3d = () => {
    let previous_value = this.state.show_3d;
    this.setState({
      show_3d: !previous_value
    });
  };

  render() {
    const {
      project,
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
    if (!new_commit_id              ||
        !new_commit_id              ||
        new_commit === undefined    ||
        ref_commit === undefined    ||
        new_batch_filtered === null ||
        ref_batch_filtered === null )
      return (
        <ProgressBar/>
      );
        // <Container>
        //   <Section>{warning_messages}</Section>
        // </Container>


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
            <Fragment>
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
                  <Tabs id="tabs-summary">
                    <Tab
                      id="metrics"
                      title="Performance Summary"
                      panel={
                        <MetricsSummary
                          project={project}
                          available_metrics={this.props.available_metrics}
                          new_batch={new_batch_filtered}
                          ref_batch={ref_batch_filtered}
                        />
                      }
                    />
                    <Tab
                      id="parameters"
                      title="Parameters"
                      panel={
                        <CommitParameters
                          project={project}
                          new_commit={new_commit}
                        />
                      }
                    />
                    <Tab
                      id="recordings"
                      title="Available Recordings"
                      panel={
                        <AddRecordingsForm
                          project={project}
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
                    this.setState({ selectedTabId: newTabId });
                  }}
                  selectedTabId={this.props.selectedTabId}
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
                        sort_order={this.props.order}
                        sort_by={this.props.sort_by}
                        new_batch={new_batch_filtered}
                        ref_batch={ref_batch_filtered}
                        show_videos={this.state.show_videos}
                        show_3d={this.state.show_3d}
                        show_debug={this.state.show_debug}
                      />
                    }
                  />
                  <Tab
                    id="tuning-results"
                    title="Tuning exploration"
                    panel={
                      <TuningExploration
                        project={project}
                        batch={new_batch_filtered}
                      />
                    }
                  />
                  <Tabs.Expander />
                  {project === "dvs/psp_swip" ? (
                    <Fragment>
                      <Switch
                        checked={this.state.show_debug}
                        label="Debug"
                        onChange={this.toogleShowDebug}
                      />
                      <Switch
                        checked={this.state.show_videos}
                        label="Videos"
                        onChange={this.toogleShowVideos}
                      />
                      <Switch
                        checked={this.state.show_3d}
                        label="3d"
                        onChange={this.toogleShow3d}
                      />
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
                    </Fragment>
                  ) : (
                    <Fragment />
                  )}
                </Tabs>
              </Section>
            </Fragment>
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
    const { new_batch, ref_batch, sort_by, sort_order } = this.props;
    const { show_debug, show_videos, show_3d } = this.props;
    // FIXME: workaround to compare local commits versus git-ci commits
    // https://github.com/bvaughn/react-virtualized/blob/master/docs/List.md
    return (
      <Fragment>
        {show_debug && (
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
                  output_type={output.output_type}
                  output_new={output}
                  output_ref={output_ref}
                  warning={warning}
                  show_debug={show_debug}
                  show_videos={show_videos}
                  show_3d={show_3d}
                  select_debug={this.state.select_debug}
                />
              );
            })}
        </div>
      </Fragment>
    );
  }
}



const empty_batch = {
  outputs: {},
  valid_outputs: 0,
  running_outputs: 0,
  pending_outputs: 0,
  failed_outputs: 0,
};

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
    let new_batch = (!!new_commit && !!new_commit.batches) ? new_commit.batches[selected_batch_new] : empty_batch;
    let ref_batch = (!!ref_commit && !!ref_commit.batches) ? ref_commit.batches[selected_batch_ref] : empty_batch;
    if (!new_batch.outputs)
      new_batch.outputs = {}
    if (!ref_batch.outputs)
      ref_batch.outputs = {}
    // filtering
    // FIXME: add missing null/undefined checks
    let filter_batch_new = (state.selected[project] && state.selected[project].filter) || default_selected_.filter_batch_new
    let filter_batch_ref = (state.selected[project] && state.selected[project].filter_ref) || default_selected_.filter_batch_ref
    let new_batch_filtered = filter_batch(new_batch, filter_batch_new);
    let ref_batch_filtered = filter_batch(ref_batch, filter_batch_ref);
    // summary results

    return {
      // project information
      project,
      project_data,
      // metrics
      available_metrics,
      selected_metrics: project_metrics.main_metrics.map(k => available_metrics[k]),
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

      sort_by: (state.selected[project] && state.selected[project].sort_by) || project_metrics.default_metric || "input_test_path",
      order: (state.selected[project] && state.selected[project].order) || -1,
    }
}

export default withRouter(connect(mapStateToProps)(CiCommitResults) );
