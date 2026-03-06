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
import { MetricsSummary, MetricHeader } from "./components/metrics";
import { CommitWarningMessages, BatchStatusMessages } from "./components/messages";

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
import { humanFileSize } from "./viewers/bit_accuracy/utils";
import { 
  parseVisualizationOptions, 
  mergeCompatibleOptions, 
  setSyncPreferences,
  generateViewPaths
} from "./utils/dynamicOptions";
import { matchPath } from 'react-router';

import {
	projectSelector,
	configSelector,
	commitSelector,
	selectedSelector,
	batchSelector,
} from './selectors/projects'

import PrivateContent from "./components/authentication/PrivateContent"
import FloatingControlsPanel from "./components/FloatingControlsPanel";



class CiCommitResults extends Component {
  constructor(props) {
    super(props);
    // we initialize optionnal controls with their defaults
    this.state = {
      controls: controls_defaults(this.props.config),
      global_dynamic_options: {},
      output_options_store: {}, // Store individual output options for re-registration
      registered_outputs: new Set(),
      visualizations_with_files: new Set(), // Track which visualizations have files available
      visualization_stats: {
        total_visualizations: 0,
        disabled_visualizations: 0,
        missing_files_count: 0,
      },
      expandFloatingPanel: false,
      registration_info: {
        total_outputs: 0,
        registered_outputs: 0,
        is_throttled: false,
        last_recompute_at: 0,
      },
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
    const currentValue = this.state.controls.show?.[name];
    let newValue;
    
    // Handle three-state toggle: undefined -> true -> false -> true -> ...
    if (currentValue === undefined) {
      newValue = true;  // Enable explicitly
    } else if (currentValue === true) {
      newValue = false; // Disable explicitly  
    } else {
      newValue = true;  // Re-enable
    }
    
    const controls = {
        ...this.state.controls,
        show: {
          ...this.state.controls.show,          
          [name]: newValue,
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
        text={<MetricHeader {...metric} show_suffix />}
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
        selected_metrics: this.props.selected_metrics.filter((metric, i) => i !== index).map(m => m.key)
      }))
  };
  handleMetricSelect = metric => {
    if (!this.isMetricSelected(metric)) {
      this.props.dispatch(updateSelected(
        this.props.project, {
          selected_metrics: [...this.props.selected_metrics, metric].map(m => m.key)
        }))
    } else {
      this.deselectMetric(this.getSelectedMetricIndex(metric));
    }
  };

  // Check which visualizations have files available in a manifest
  checkVisualizationsWithFiles = (manifest) => {
    const config = this.props.config || {};
    const outputs = config.outputs || {};
    const views = [...(outputs.visualizations || []), ...(outputs.detailed_views || [])];
    const manifestPaths = Object.keys(manifest || {});
    
    const visualizationsWithFiles = new Set();
    
    views.forEach(view => {
      if (!view.path) return;
      
      // For simple paths (no patterns), check direct existence
      if (!view.path.includes(':') && !view.path.includes('(')) {
        if (manifestPaths.includes(view.path)) {
          visualizationsWithFiles.add(view.name || view.path);
        }
        return;
      }
      
      // For pattern paths, use the same logic as options parsing
      const hasMatchingFile = manifestPaths.some(path => {
        try {
          const match = matchPath(path, { path: view.path });
          return match !== null && match !== undefined;
        } catch (error) {
          return false;
        }
      });
      
      if (hasMatchingFile) {
        visualizationsWithFiles.add(view.name || view.path);
      }
    });
    
    return visualizationsWithFiles;
  };

  // Dynamic options management with performance optimization
  registerOutputOptions = (outputId, outputOptions, manifest) => {
    // Skip if already registered with same options (performance optimization)
    if (this.state.registered_outputs.has(outputId)) {
      // Still update visualizations_with_files if we have a new manifest
      if (manifest) {
        const newVisualizationsWithFiles = this.checkVisualizationsWithFiles(manifest);
        if (newVisualizationsWithFiles.size > 0) {
          this.setState(prevState => ({
            visualizations_with_files: new Set([
              ...prevState.visualizations_with_files,
              ...newVisualizationsWithFiles
            ])
          }));
        }
      }
      return;
    }
    
    this.setState(prevState => {
      const newRegisteredOutputs = new Set(prevState.registered_outputs);
      newRegisteredOutputs.add(outputId);
      
      // Check which visualizations have files in this manifest
      const newVisualizationsWithFiles = manifest ? this.checkVisualizationsWithFiles(manifest) : new Set();
      const updatedVisualizationsWithFiles = new Set([
        ...prevState.visualizations_with_files,
        ...newVisualizationsWithFiles
      ]);
      
      // Store this output's options for future merging
      const outputOptionsStore = {
        ...prevState.output_options_store,
        [outputId]: outputOptions
      };
      
      // Always recompute for first 50 outputs to ensure options appear quickly
      // Then only recompute periodically for performance
      const shouldRecompute = newRegisteredOutputs.size <= 50 || newRegisteredOutputs.size % 20 === 0;
      const isThrottled = newRegisteredOutputs.size > 50 && newRegisteredOutputs.size % 20 !== 0;
      
      let mergedOptions = prevState.global_dynamic_options;
      
      if (shouldRecompute) {
        // Collect all output options for merging  
        const allOutputOptions = Array.from(newRegisteredOutputs).map(id => ({
          output_id: id,
          ...outputOptionsStore[id] || {}
        }));
        
        mergedOptions = mergeCompatibleOptions(allOutputOptions);
      }
      
      // Initialize synced options with defaults if not already set
      const updatedControls = { ...prevState.controls };
      Object.entries(mergedOptions).forEach(([name, option]) => {
        if (!updatedControls.dynamic_options[name]) {
          updatedControls.dynamic_options[name] = [option.defaultValue];
        }
        // Default new options to synced unless explicitly set otherwise
        if (updatedControls.dynamic_options_sync[name] === undefined) {
          updatedControls.dynamic_options_sync[name] = true;
        }
      });
      
      return {
        registered_outputs: newRegisteredOutputs,
        global_dynamic_options: mergedOptions,
        output_options_store: outputOptionsStore,
        controls: updatedControls,
        visualizations_with_files: updatedVisualizationsWithFiles,
        registration_info: {
          total_outputs: this.props.new_batch?.filtered?.outputs?.length || 0,
          registered_outputs: newRegisteredOutputs.size,
          is_throttled: isThrottled,
          last_recompute_at: shouldRecompute ? newRegisteredOutputs.size : prevState.registration_info.last_recompute_at,
        }
      };
    });
  };

  updateDynamicOption = (name, value) => {
    const controls = {
      ...this.state.controls,
      dynamic_options: {
        ...this.state.controls.dynamic_options,
        [name]: [value]
      }
    };
    this.setState({ controls }, () => updateQueryUrl(this.props.history, controls));
  };

  toggleDynamicOptionSync = (name) => {
    const newSyncState = !this.state.controls.dynamic_options_sync[name];
    const updatedSync = {
      ...this.state.controls.dynamic_options_sync,
      [name]: newSyncState
    };
    
    setSyncPreferences(updatedSync);
    
    const controls = {
      ...this.state.controls,
      dynamic_options_sync: updatedSync
    };
    
    // If we're syncing (not unsyncing), expand the floating panel
    const expandPanel = newSyncState === true;
    
    this.setState({ 
      controls, 
      expandFloatingPanel: expandPanel 
    }, () => {
      updateQueryUrl(this.props.history, controls);
      // Reset the expand trigger after a short delay
      if (expandPanel) {
        setTimeout(() => {
          this.setState({ expandFloatingPanel: false });
        }, 100);
      }
    });
  };

  forceReregisterAllOptions = () => {
    // Force recomputation of all dynamic options by collecting all stored options
    const allOutputOptions = Array.from(this.state.registered_outputs).map(id => ({
      output_id: id,
      ...this.state.output_options_store[id] || {}
    }));
    
    const mergedOptions = mergeCompatibleOptions(allOutputOptions);
    
    // Update controls with the merged options
    const updatedControls = { ...this.state.controls };
    Object.entries(mergedOptions).forEach(([name, option]) => {
      if (!updatedControls.dynamic_options[name]) {
        updatedControls.dynamic_options[name] = [option.defaultValue];
      }
      // Preserve existing sync preferences
      if (updatedControls.dynamic_options_sync[name] === undefined) {
        updatedControls.dynamic_options_sync[name] = true;
      }
    });
    
    this.setState({
      global_dynamic_options: mergedOptions,
      controls: updatedControls,
      registration_info: {
        ...this.state.registration_info,
        is_throttled: false,
        last_recompute_at: this.state.registered_outputs.size,
      }
    }, () => updateQueryUrl(this.props.history, updatedControls));
  };

  updateVisualizationStats = (stats) => {
    this.setState({ visualization_stats: stats });
  };

  fetchCommits() {
    const { project, new_project, ref_project, new_commit_id, ref_commit_id, dispatch } = this.props
    dispatch(fetchCommit({project: new_project, id: new_commit_id, update_with_id: {project, commit: "new_commit_id"}}))
    dispatch(fetchCommit({project: ref_project, id: ref_commit_id, update_with_id: {project, commit: "ref_commit_id"}}))
  }

  componentDidMount() {
    let name = this.props.project.split('/').slice(-1)[0];
    if (!!this.props.new_commit_id)
      document.title = `${this.props.new_commit_id.slice(0, 4)} - ${name}`;

    this.fetchCommits();
  }

  componentDidUpdate(prevProps) {
    // Reset all registration state when commit or batch changes
    const commitChanged = this.props.new_commit_id !== prevProps.new_commit_id;
    const batchChanged = this.props.selected_batch_new !== prevProps.selected_batch_new;

    if (commitChanged || batchChanged) {
      this.setState({
        registered_outputs: new Set(),
        global_dynamic_options: {},
        output_options_store: {},
        visualizations_with_files: new Set(),
        registration_info: {
          total_outputs: 0,
          registered_outputs: 0,
          is_throttled: false,
          last_recompute_at: 0,
        },
      });
    }

    // Reset file tracking when filter changes (but keep registrations for performance)
    const filterChanged = this.props.filter_batch_new !== prevProps.filter_batch_new;
    if (filterChanged && !commitChanged && !batchChanged) {
      this.setState({
        visualizations_with_files: new Set(),
      });
    }

    const config_curr = this.props.config;
    const config_prev = prevProps.config;
    const new_outputs = config_curr?.outputs;
    const old_outputs = config_prev?.outputs;

    if (new_outputs !== old_outputs ) {
      let newControls = controls_defaults(config_curr);
      // Preserve existing user preferences when config changes
      newControls.show = { ...newControls.show, ...this.state.controls.show };
      newControls.dynamic_options = this.state.controls.dynamic_options || {};
      newControls.dynamic_options_sync = this.state.controls.dynamic_options_sync || {};

      // Only reset registrations if the actual visualization config has meaningfully changed
      // This prevents unnecessary flashing when just switching tabs within the same project
      const prevVisualizationsConfig = JSON.stringify(old_outputs?.visualizations || []);
      const currVisualizationsConfig = JSON.stringify(new_outputs?.visualizations || []);

      if (prevVisualizationsConfig !== currVisualizationsConfig) {
        // True config change - reset and re-discover
        this.setState({
          controls: newControls,
          registered_outputs: new Set(),
          global_dynamic_options: {},
          output_options_store: {},
          visualizations_with_files: new Set(),
        });
      } else {
        // Just update controls without resetting registrations
        this.setState({ controls: newControls });
      }
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
      dispatch,
      history,
      available_tests_files,
    } = this.props;
    var warning_messages = <CommitWarningMessages
                            project={this.props.selected.new_project}
                            commit={new_commit}
                            dispatch={dispatch}
                           />;

    let clearButton =
      selected_metrics.length > 0 ? (
        <Button icon="cross" minimal={true} onClick={this.handleClear} />
      ) : null;
    let metricTableSelect = (
      <MultiSelect
        items={Object.entries(available_metrics)
               .filter(([key, _]) => new_batch.used_metrics.has(key))
               .map(([k, m]) => m)}
        itemPredicate={this.filterMetric}
        itemRenderer={this.renderMetric}
        onItemSelect={this.handleMetricSelect}
        tagRenderer={m => <MetricHeader {...m}/>}
        tagInputProps={{
          onRemove: this.handleTagRemove,
          rightElement: clearButton
        }}
        noResults={noMetrics}
        selectedItems={selected_metrics.filter(m => new_batch.used_metrics.has(m.key))}
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
    const tuned_params = new_batch.sorted_extra_parameters.filter(p => new_batch.extra_parameters[p].size > 1)
    const has_tuning = tuned_params.length > 0
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
                <BatchStatusMessages project={this.props.selected.new_project} commit={new_commit} batch={new_batch} dispatch={dispatch} />
              </Section>

              {selected_views.includes('summary') && <Section>
                <Card elevation={2}>
                  <h2 className={Classes.HEADING}>Summary</h2>
                  <MetricsSummary
                    project={this.props.selected.new_project}
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
                    project={this.props.selected.new_project}
                    config={config}
                    new_commit={new_commit}
                    ref_commit={ref_commit}
                    history={history}
                  />
                </Card>
               </Section>}

              {selected_views.includes('groups') && <Section style={{width: "1000px"}}>
                <Card>
                  <h2 className={Classes.HEADING}>Groups of tests</h2>
                  <PrivateContent enabled={true}>
                    <AddRecordingsForm
                    project={project}
                    git={git}
                    commit={new_commit}
                    config={config}
                    available_tests_files={available_tests_files}
                    docs_root={this.props.docs_root}
                    />
                  </PrivateContent>
                </Card>
               </Section>}

              {selected_views.includes('tuning') && (Object.keys(config.artifacts || {}).length === 0
                ? <NonIdealState
                    icon="heatmap"
                    title={<p>Tuning requires you to define build <strong>artifacts.</strong></p>}
                    description={<p><a target="_blank" rel="noopener noreferrer" href={`${this.props.docs_root}docs/visualizations`}>Read the docs</a> to learn how to declare visualizations.</p>}
                  />
                : <Section>
                  <h2 className={Classes.HEADING}>Tuning Experiments</h2>
                  <Card>
                    <PrivateContent enabled={true}>
                      <TuningForm
                      project={project}
                      config={config}
                      metrics={metrics}
                      commit={new_commit}
                      available_tests_files={available_tests_files}
                      />
                    </PrivateContent>
                  </Card>
              </Section>)}

              {selected_views.includes('table-compare') && <Section>
                <Card>
                    <h2 className={Classes.HEADING}>Improvement report</h2>
                    <TableCompare
                      new_batch={new_batch}
                      ref_batch={ref_batch}
                      metrics={selected_metrics.map(m => m.key)}
                      available_metrics={available_metrics}
                      input={metricTableSelect}
                    />
                </Card>
               </Section>}

              {selected_views.includes('table-kpi') && <Section>
                <Card>
                    <h2 className={Classes.HEADING}>Quality report</h2>
                    <TableKpi
                      new_batch={new_batch}
                      ref_batch={ref_batch}
                      metrics={selected_metrics.map(m => m.key)}
                      available_metrics={available_metrics}
                      input={metricTableSelect}
                    />
                </Card>
               </Section>}

              {selected_views.includes('logs') && <Section>
                  <h2 className={Classes.HEADING}>Logs</h2>
                  <BatchLogs
                    project={this.props.selected.new_project}
                    commit={new_commit}
                    batch={new_batch}
                    batch_label={new_batch.label}
                    dispatch={dispatch}
                  />
               </Section>}



              {selected_views.includes('output-list') && (visualizations.length === 0
                 ? <NonIdealState
                     icon="heatmap"
                     title="Visualizations are not configured yet." 
                     description={<p><a target="_blank" rel="noopener noreferrer" href={`${this.props.docs_root}docs/visualizations`}>Read the docs</a> to learn how to declare visualizations.`</p>}
                   />
                 : <Section>
                  <h2 className={Classes.HEADING}>Visualizations</h2>
                  <ExportPlugin
                    project={this.props.selected.new_project}
                    ref_project={this.props.selected.ref_project}
                    config={config}
                    new_commit_id={new_commit_id}
                    ref_commit_id={ref_commit_id}
                    selected_batch_new={this.props.selected_batch_new}
                    selected_batch_ref={this.props.selected_batch_ref}
                    filter_batch_new={this.props.filter_batch_new}
                    filter_batch_ref={this.props.filter_batch_ref}
                    batch_dir_url={new_batch.batch_dir_url}
                  />
                  <OutputCardsList
                    project={this.props.selected.new_project}
                    config={config}
                    metrics={metrics}
                    new_commit={new_commit}
                    new_batch={new_batch}
                    ref_batch={ref_batch}
                    controls={this.state.controls}
                    history={history}
                    dispatch={dispatch}
                    onRegisterOutputOptions={this.registerOutputOptions}
                    onToggleDynamicOptionSync={this.toggleDynamicOptionSync}
                  />
              </Section>)}

              {selected_views.includes('bit-accuracy') && <Section>
                  <h2 className={Classes.HEADING}>Output Files</h2>
                  <p className={Classes.TEXT_MUTED}>Total Storage: {humanFileSize(
                    (new_batch?.filtered?.outputs ?? [])
                    .map( id => new_batch.outputs[id]?.data?.storage ?? 0)
                    .reduce((running_total, storage) => running_total + storage, 0)
                  , true)}</p>
                  <ExportPlugin
                    project={this.props.selected.new_project}
                    ref_project={this.props.selected.ref_project}
                    config={config}
                    new_commit_id={new_commit_id}
                    ref_commit_id={ref_commit_id}
                    selected_batch_new={this.props.selected_batch_new}
                    selected_batch_ref={this.props.selected_batch_ref}
                    filter_batch_new={this.props.filter_batch_new}
                    filter_batch_ref={this.props.filter_batch_ref}
                    batch_dir_url={new_batch.batch_dir_url}
                  />
                  <OutputCardsList
                    type='bit_accuracy'
                    project={this.props.selected.new_project}
                    config={config}
                    metrics={metrics}
                    new_commit={new_commit}
                    new_batch={new_batch}
                    ref_batch={ref_batch}
                    controls={this.state.controls}
                    history={history}
                    dispatch={dispatch}
                    onRegisterOutputOptions={this.registerOutputOptions}
                    onToggleDynamicOptionSync={this.toggleDynamicOptionSync}
                  />
               </Section>}

              {selected_views.includes('optimization') && <Section>
                <Card>
                  <h2 className={Classes.HEADING}>Auto-Tuning Analysis</h2>
                  <TuningExploration
                    project={this.props.selected.new_project}
                    metrics={metrics}
                    available_metrics={available_metrics}
                    selected_metrics={selected_metrics.map(m => m.key)}
                    batch={new_batch}
                    input={metricTableSelect}
                    />
                </Card>
               </Section>}

            </>
          )}

        {/* Floating Controls Panel */}
        {(!!new_commit) && (
          <FloatingControlsPanel
            controls={this.state.controls}
            visualizations={visualizations}
            controls_extra={controls_extra}
            selected_views={selected_views}
            selected_metrics={selected_metrics}
            new_batch={new_batch}
            available_metrics={available_metrics}
            metricTableSelect={metricTableSelect}
            sort_by={this.props.sort_by}
            sort_order={this.props.sort_order}
            onToggle={this.toggle}
            onToggleShow={this.toggle_show}
            onUpdate={this.update}
            has_tuning={has_tuning}
            tuned_params={tuned_params}
            dynamic_options={this.state.global_dynamic_options}
            onUpdateDynamicOption={this.updateDynamicOption}
            onToggleDynamicOptionSync={this.toggleDynamicOptionSync}
            visualization_stats={this.state.visualization_stats}
            visualizations_with_files={this.state.visualizations_with_files}
            expandPanel={this.state.expandFloatingPanel}
            registration_info={this.state.registration_info}
            onForceReregisterAllOptions={this.forceReregisterAllOptions}
          />
        )}
      </Container>
    );
  }
}




const mapStateToProps = (state, ownProps) => {
    const params = new URLSearchParams(ownProps.location.search);
    let project = projectSelector(state)

    let selected = selectedSelector(state)
    const { new_commit_id, ref_commit_id, filter_batch_new, filter_batch_ref, new_project, ref_project } = selected

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
      selected,
      config,
      metrics,
      git,
      available_metrics,
      selected_metrics: selected_metrics.map(m => available_metrics[m]),
      // selected commit
      new_project,
      ref_project,
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

      // TODO: migrate the availble-tests-files to DB
      available_tests_files: {
        gr: "extra-batches",
        usr: state.user?.user_name ?? null
      },
      docs_root: state.siteConfig.docs_root,
    }
}

export default withRouter(connect(mapStateToProps)(CiCommitResults) );