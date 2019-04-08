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
  InputGroup,
  Callout,
  Card,
  Tabs,
  Intent,
} from "@blueprintjs/core";
import { MultiSelect } from "@blueprintjs/select";
import { noMetrics } from "./components/metricSelect";

import { Container, Section } from "./components/layout";
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
import { controls_defaults, updateQueryUrl } from "./viewers/controls";
import { ExportPlugin } from "./plugins/ExportPlugin";

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
    document.title = this.props.new_commit_id.slice(0, 4);
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
      selected_metrics,
      new_batch_filtered,
      ref_batch_filtered,
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
    let maybe_diff = detailed_views.some(v => v.type.startsWith('image')) && <Switch
        key='diff'
        checked={this.state.controls.diff}
        onChange={this.toggle('diff')}
        label={'Perceptual diff'}
    />
    let controls = <>
      {selected_views !== 'bit-accuracy' && detailed_views.map( (view, idx) => {
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

    let show_viewer_controls = (selected_views === 'output-list' || selected_views === 'bit-accuracy')

    const all_controls = <Tabs>
      <Tabs.Expander />
      {show_viewer_controls && controls}
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

    let show_ref_navbar = ! (selected_views === 'logs' || selected_views === 'tuning' || selected_views === 'groups')

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
                    project_data={project_data}
                    available_metrics={this.props.available_metrics}
                    new_batch={new_batch_filtered}
                    ref_batch={ref_batch_filtered}
                  />
                </Card>
               </Section>}

              {selected_views.includes('parameters') && <Section>
                <Card>
                  <h2 className={Classes.HEADING}>Algorithm configuration</h2>
                  <CommitParameters
                    project={project}
                    new_commit={new_commit}
                    ref_commit={ref_commit}
                  />
                </Card>
               </Section>}

              {selected_views.includes('groups') && <Section>
                <Card>
                  <h2 className={Classes.HEADING}>Groups of tests</h2>
                  <AddRecordingsForm
                    project={project}
                    project_data={this.props.project_data}
                    commit={new_commit}
                  />
                </Card>
               </Section>}

              {selected_views.includes('tuning') && <Section>
                <h2 className={Classes.HEADING}>Run experiments</h2>
                <Card>
                  <TuningForm
                    project={project}
                    project_data={this.props.project_data}
                    commit={new_commit} />
                </Card>
               </Section>}

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
                  <h2 className={Classes.HEADING}>Logs</h2>
                  <BatchLogs
                    batch={new_batch_filtered}
                    batch_label={new_batch_filtered.label}
                  />
               </Section>}



              {selected_views.includes('output-list') && <Section>
                 {all_controls}
                  <h2 className={Classes.HEADING}>Outputs</h2>
                  <ExportPlugin
                    project={project}
                    project_data={project_data}
                    new_commit_id={this.props.new_commit_id}
                    ref_commit_id={this.props.ref_commit_id}
                    selected_batch_new={this.props.selected_batch_new}
                    selected_batch_ref={this.props.selected_batch_ref}
                    filter_batch_new={this.props.filter_batch_new}
                    filter_batch_ref={this.props.filter_batch_ref}
                  />
                  <OutputList
                    project={project}
                    project_data={project_data}
                    sort_order={this.props.sort_order}
                    sort_by={this.props.sort_by}
                    new_batch={new_batch_filtered}
                    ref_batch={ref_batch_filtered}
                    controls={this.state.controls}
                  />
               </Section>}

              {selected_views.includes('bit-accuracy') && <Section>
                 {all_controls}
                  <h2 className={Classes.HEADING}>Files & bit-accuracy</h2>
                  <OutputList
                    type='bit_accuracy'
                    project={project}
                    project_data={project_data}
                    sort_order={this.props.sort_order}
                    sort_by={this.props.sort_by}
                    new_batch={new_batch_filtered}
                    ref_batch={ref_batch_filtered}
                    controls={this.state.controls}
                    history={this.props.history}
                  />
               </Section>}

              {selected_views.includes('optimization') && <Section>
                <Card>
                  <h2 className={Classes.HEADING}>Tuning understanding</h2>
                  <TuningExploration
                    project={project}
                    project_data={project_data}
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

class OutputList extends Component {
  constructor(props) {
    super(props);
    const params = new URLSearchParams(window.location.search);

    this.state = {
      select_debug: "",
      // bit-accuracy controls
      show_all_files: params.get("show_all_files") || false,
      expand_all: params.get("expand_all") || false,
      files_filter: params.get("files_filter") || '',
    };
  }

  
  update = (attribute, attribute_url) => e => {
  	const value = (e.target && e.target.value !==undefined) ? e.target.value : e;
    let query = qs.parse(window.location.search.substring(1));
    this.setState({[attribute_url || attribute]: value,})
    this.props.history.push({
      pathname: window.location.pathname,
      search: qs.stringify({
        ...query,
        [attribute_url || attribute]: value,
      })
    });
  }

  toggle = name => () => {
    this.setState({[name]: !this.state[name]})
    let query = qs.parse(window.location.search.substring(1));
    this.props.history.push({
      pathname: window.location.pathname,
      search: qs.stringify({
        ...query,
        [name]: !this.state[name],
      })
    });
  }


  render() {
    const { project, project_data, new_batch, ref_batch, sort_by, sort_order, controls, type } = this.props;
    const { show_all_files, expand_all, files_filter } = this.state;
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
                checked={show_all_files}
                onChange={this.toggle('show_all_files')}
                style={{ width: "300px" }}
              />
            </FormGroup>
            <FormGroup
              inline
              labelFor="expand-all"
              style={{flex: '50 1 auto'}}
            >
              <Switch
                label="Expand all folders"
                checked={expand_all}
                onChange={this.toggle('expand_all')}
                style={{ width: "300px" }}
              />
            </FormGroup>
            <FormGroup
              inline
              labelFor="files-filter"
              helperText="Only show files matching"
              style={{flex: '50 1 auto'}}
            >
              <input
              	className={Classes.INPUT}
                label="Filter by path"
                value={files_filter}
                onChange={this.update('files_filter')}
                style={{ width: "150px" }}
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
        {!!ref_batch.label && ref_batch.label !== "default" && (
          <Section><Callout intent={Intent.WARNING}>
            We compare each output to <strong>any</strong> reference outputs
            with matching recording+configuration+platform,{" "}
            <strong>without looking at the tuning parameters</strong>.
          </Callout></Section>
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
                  files_filter={files_filter}
                  expand_all={expand_all}
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

    let {
    	selected_batch_new,
    	selected_batch_ref,
    	new_batch,
    	ref_batch,
    	new_batch_filtered,
    	ref_batch_filtered,
    } = batchSelector(state)

    // metrics
    let project_metrics = project_data.information.qatools_metrics
    let available_metrics = project_metrics.available_metrics
    let selected_metrics = selected.selected_metrics || project_metrics.main_metrics.map(k => available_metrics[k])

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

    let selected_views = (state.selected[project] && state.selected[project].selected_views) || [ "metrics", ((project_data.information.qatools_config.outputs || {}).default_tab_details || 'table-compare')];
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

      sort_by: params.get("sort_by") || (state.selected[project] && state.selected[project].sort_by) || project_metrics.default_metric || "input_test_path",
      sort_order: params.get("sort_order") || (state.selected[project] && state.selected[project].sort_order) || -1,
    }
}

export default withRouter(connect(mapStateToProps)(CiCommitResults) );
