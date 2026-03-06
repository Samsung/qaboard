import React, { useCallback } from "react";
import { Link } from "react-router-dom";
import { InView } from 'react-intersection-observer'
import { get, all, CancelToken, isCancel } from "axios";
import { matchPath } from 'react-router'
import { parse, compile } from 'path-to-regexp'
// TODO: check we use the correct {delimiter: '/'} maybe ?
// https://github.com/pillarjs/path-to-regexp
import { DateTime } from 'luxon';
import { FullScreen, useFullScreenHandle } from "react-full-screen";

import styled from "styled-components";
import {
  Classes,
  Intent,
  Card,
  Tag,
  Slider,
  HTMLSelect,
  Tooltip,
  Button,
  Popover,
  Menu,
  MenuItem,
  MenuDivider,
  PopoverInteractionKind,
} from "@blueprintjs/core";
import copy from 'copy-to-clipboard'

import { OutputViewer } from "./OutputViewer";
import { MetricsTags } from "../components/metrics";
import { OutputTags, ExtraParametersTags, StatusTag, RunBadges, style_skeleton } from '../components/tags'
import { humanFileSize, humanElapsedTime } from "./bit_accuracy/utils";

import { updateSelected } from "../actions/selected";
import { linux_to_windows, is_same_data } from '../utils'
import { is_image } from "./images/utils"
import { toaster } from "../toaster"
import { 
  parseVisualizationOptions, 
  calculateOptionValues, 
  configureOption, 
  generateViewPaths,
  isOptionCompatible 
} from "../utils/dynamicOptions"


// ES2018.....
Object.fromEntries = arr => Object.assign({}, ...Array.from(arr, ([k, v]) => ({ [k]: v })));

const on_copy = e => {
  const text = e.target.textContent
  copy(text)
  toaster.show({
    message: <span className={Classes.TEXT_OVERFLOW_ELLIPSIS}><strong>Copied:</strong> {text}</span>,
  });
}


const SlimCard = styled(Card)`
  overflow: "auto";
`;

const FullScreenableSlimCard = props => {
  const handle = useFullScreenHandle();
  const reportChange = useCallback((state, handle) => {
    props.updateFullscreen(state)
  }, [handle]);
  return <SlimCard compact className={props.className} style={props.style}>
    <div style={{position: "relative"}}>
      <Tag title="Enter Full Screen" style={{position: "absolute", right: "0px", top: "0px"}} icon="fullscreen" interactive minimal onClick={handle.enter}/>
    </div>
    <FullScreen handle={handle} onChange={reportChange}>
      {props.children}
    </FullScreen>
  </SlimCard>
}

const OutputHeader = ({ project, commit, output, output_ref, type, dispatch, manifests, style, prefix, viewable, tags_first=false }) => {
  const has_metadata = !!output.test_input_metadata && (Object.keys(output.test_input_metadata).length > 0)
  const has_label = has_metadata && !!output.test_input_metadata.label
  const tags = <OutputTags
    output={output}
    project={project}
    output_ref={output_ref}
    mismatch={output.reference_mismatch}
    manifests={manifests}
    dispatch={dispatch}
    commit={commit}
    style={{marginLeft: '5px', marginRight: '5px'}}
  />

  const input_over_time_url = `/${project}/history/${!!commit ? commit.branch : ''}${window.location.search}`
  // output.params.badges = [{text: "training", icon: "settings", href: "https://example.com"}]
  let run_path = `${output.test_input_database === '/' ? '/' : ''}${output.test_input_path}`
  if (output.output_type === "pipeline" || output.test_input_path === "PIPELINE") {
    run_path = <span>{output.data.batch} <span className={Classes.TEXT_MUTED}>(pipeline)</span></span>
  }
  if (has_label) {
    run_path = output.test_input_metadata.label
  }
  const popover_content = <Menu>
    {!!output.data?.batch && <>
      <MenuDivider key={"Batch"} title="Batch" />
      <MenuItem key="batch" text={output.data.batch} icon="group-objects" onClick={on_copy} />
    </>}
    {!!output.test_input_database && <>
      <MenuDivider key={"Database"} title="Database" />
      <MenuItem key="database-linux" text={output.test_input_database} icon="duplicate" onClick={on_copy} />
      <MenuItem key="database-windows" text={linux_to_windows(output.test_input_database)} icon="duplicate" onClick={on_copy} />
    </>}
    {!!output.test_input_path && <>
      <MenuDivider key={"Input path"} title="Input path" />
      <MenuItem key="input-linux" text={output.test_input_path} icon="duplicate" onClick={on_copy} />
    </>}
    {has_metadata && <>
      <MenuDivider key={"Properties"} title="Properties" />
      { has_label && <MenuItem text={output.test_input_path} icon="document" />}
      <MenuItem key="metadata" text="Metadata" icon="info-sign"> {/*tag, info-sign, annotation, more*/}
        <pre>{JSON.stringify(output.test_input_metadata, null, 2)}</pre>
      </MenuItem>
    </>}
    <MenuDivider key={"Output-Info"} title="Output Info" />
    {!!output?.metrics?.compute_time && <MenuItem key="compute-time" text={humanElapsedTime(output.metrics.compute_time)} icon="stopwatch" />}
    <MenuItem
      key="created-date"
      text={<span title={output.created_date}> {DateTime.fromISO(output.created_date, { zone: 'utc' }).toRelative()}</span>}
      icon="calendar"
    />
    {!!output?.data?.storage && <MenuItem key="storage" text={humanFileSize(output.data.storage, true)} icon="folder-close" />}
  </Menu>
  return <>
    <h5 className={Classes.HEADING} style={style} >
      {prefix}   
      {tags_first && viewable && tags}
      {output.output_type !== "batch" && !viewable ?
        <span key="batch-info">{run_path}</span> : <Popover hoverCloseDelay={1000} interactionKind={PopoverInteractionKind.HOVER} content={popover_content}>
        <span key="batch-info">
          <Link
            to={input_over_time_url}
            onClick={() => {
                  // https://stackoverflow.com/a/6969486
                  const filter = output.test_input_path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                  dispatch(updateSelected(project, {
                    branch: commit.branch,
                    filter_batch_new: filter,
                    filter_batch_ref: filter,
                  }, {
                    show_bit_accuracy: type === 'bit_accuracy',
                  }))
            }}
            style={{ color: 'inherit' }}
          >
            {run_path}
          </Link>
        </span>

      </Popover>}
      {!tags_first && viewable && tags}
    </h5>
    <p style={{maxWidth: '600px'}}>
      <RunBadges output={output}></RunBadges>
      <ExtraParametersTags parameters={output.extra_parameters} />
    </p>
  </>
}



const condensed_header_style = {
  fontSize: ".7rem",
  fontWeight: 500,
  letterSpacing: "-1px",
  lineHeight: 1.6,
};


class OutputCard extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      // we delay fetching the output manifest and rendering the viewers
      // until the card comes into view
      viewable: false || props.viewable,
      fullscreen: false,
      // the output manifest lists all files created by the run
      manifests: {},
      is_loaded: false,
      error: {},
      cancel_source: {
        new: CancelToken.source(),
        reference: CancelToken.source(),
      },
      local_options: {},
      is_options_registered: false
    }
  }

  componentWillUnmount() {
    ["new", "reference"].forEach(label => {
      if (!!this.state.cancel_source[label])
        this.state.cancel_source[label].cancel();
    })
  }


  fetchData(label, update_manifest) {
    const { output_new, output_ref } = this.props;
    // console.log(output_new, output_ref)

    if (!output_new.output_dir_url) return;
    this.setState({ is_loaded: false })

    let results = [];
    const should_get_all = (label === undefined || label === null);
    if (should_get_all || label === 'new') {
      let url = (!output_new.is_running && !update_manifest) ? `${output_new.output_dir_url}/manifest.outputs.json` : `/api/v1/output/${output_new.id}/manifest/${update_manifest ? '?refresh=true': ''}`
      results.push(['new', url])
      if (output_new.is_running) {
        setTimeout(() => this.fetchData('new') , 30*1000)
      }
    }
    if (should_get_all || label === 'reference') {
      if (!!output_ref && !!output_ref.output_dir_url) {
        let url = (!output_ref.is_running && !update_manifest) ? `${output_ref.output_dir_url}/manifest.outputs.json` : `/api/v1/output/${output_ref.id}/manifest/`
        results.push(['reference', url])
        if (output_ref.is_running) {
          setTimeout(() => this.fetchData('reference') , 30*1000)
        }
      }
    }
    const load_data = label => (response, thrown) => {
      // The manifest is sometimes corrupted due to filesystem issues (?!?)
      // maybe it happens if we update the manifest during a running output while it ends...
      // https://github.com/axios/axios/issues/61
      // Then the best option is maybe to regenerate the manifest..
      if (typeof response.data === 'string') {
        this.fetchData(label, update_manifest=true)
        this.setState((previous_state, props) => ({
          error: {
            ...previous_state.error,
            [label]: 'Corrupt output manifest.',
          }
        }))  
        return;
      }
      // http://qa:3000/CDE-Users/HW_ALG/CIS/tests/products/RV1/commit/d4f44717870dc9593704aefcb353d6de77369f9d?batch=%40eliavm%7C%20default&selected_views=bit_accuracy
      this.setState((previous_state, props) => ({
        manifests: {
          ...previous_state.manifests,
          [label]: response.data,
        },
        error: {
          ...previous_state.error,
          [label]: thrown,
        }
      }))
    }

    all(results.map(([label, url]) => {
      return () => get(url, { cancelToken: this.state.cancel_source[label].token })
        .then(load_data(label))
        .catch(thrown => {
          if(!isCancel(thrown))
            load_data(label)(
              { load_data: {} },
              thrown,
            )
          else if (!update_manifest)
            this.fetchData(label, update_manifest=true)
        });
    }).map(f => f()))
  }


  becameViewable = inView => {
    if (!inView) {
      return;
    }
    this.setState({viewable: true}, this.fetchData);
  }

  updateFullscreen = fullscreen => {
    this.setState({fullscreen});
  }

  componentDidUpdate(prevProps, prevState) {
    if (!this.state.viewable)
      return;
    const has_new = this.props.output_new !== undefined && this.props.output_new !== null;
    const has_ref = this.props.output_ref !== undefined && this.props.output_ref !== null;
    const had_new = prevProps.output_new !== undefined && prevProps.output_new !== null;
    const had_ref = prevProps.output_ref !== undefined && prevProps.output_ref !== null;

    let updated_new = has_new && (!had_new || prevProps.output_new.id !== this.props.output_new.id || prevProps.output_new.is_running !== this.props.output_new.is_running);
    let updated_ref = has_ref && (!had_ref || prevProps.output_ref.id !== this.props.output_ref.id || prevProps.output_ref.is_running !== this.props.output_ref.is_running);
    updated_ref = updated_ref || had_ref && !has_ref
    if (updated_new) {
      if (!!this.state.cancel_source.new.token)
        this.state.cancel_source.new.cancel("Changed new output");
      this.fetchData('new');
    }
    if (updated_ref) {
      this.setState({
        manifests: {...this.state.manifests, reference: undefined},
      })
      if (!!this.state.cancel_source.reference.token) {
        this.state.cancel_source.reference.cancel("Changed reference output");
        this.setState({
          cancel_source: {
            ...this.state.cancel_source,
           reference: CancelToken.source()
          }
        }, () => this.fetchData('reference'))
      }
    }
    if (prevState.manifests.new !== this.state.manifests.new) {
      // Reset registration flag to allow re-registration when manifest changes
      this.setState({ is_options_registered: false }, () => {
        this.registerOptions()
      })
    }
  }

  setSelectedOption = name => e => {
    // For local options only (non-synced options)
    let selected = !!e.target ? e.target.value : e;
    const localOptions = this.getLocalOptions();
    if (localOptions[name]?.type === 'slider') {
      selected = localOptions[name].to_raw[selected]
    }
    this.setState({
      local_options: {
        ...this.state.local_options,
        [name]: {
          ...this.state.local_options[name],
          selected: [selected],
        }
      }
    })
  }

  registerOptions() {
    if (this.state.manifests.new === undefined || this.state.manifests.new === null) {
      this.setState({ is_loaded: true })
      return;
    }

    if (this.state.is_options_registered) {
      this.setState({ is_loaded: true })
      return;
    }
    
    if (!this.props.onRegisterOutputOptions) {
      // Fallback to old behavior when prop is not provided
      this.setState({ is_loaded: true })
      return;
    }

    // Check if manifest has content and is relevant for visualizations
    const manifestPaths = Object.keys(this.state.manifests.new);
    const outputId = this.props.output_new.id;
    const outputs = this.props.config.outputs || {}
    const views = [...(outputs.visualizations || []), ...(outputs.detailed_views || [])];
    
    if (manifestPaths.length === 0) {
      // If manifest is empty, check if we expect files for configured visualizations
      const hasVisualizationsWithPaths = views.some(view => view.path);
      if (hasVisualizationsWithPaths) {
        // We expect files but manifest is empty - might still be loading
        // Register with empty options for now, will re-register when manifest updates
        this.props.onRegisterOutputOptions(outputId, {}, this.state.manifests.new);
      }
      this.setState({ is_loaded: true, is_options_registered: true })
      return;
    }
    
    const { options, parseErrors } = parseVisualizationOptions(views);
    
    if (parseErrors.length > 0) {
      this.setState((previous_state) => ({
        error: {
          ...previous_state.error,
          "parse": parseErrors,
        }
      }))
    } else if (!!this.state.error?.parse) {
      this.setState((previous_state) => ({
        error: {
          ...previous_state.error,
          "parse": undefined,
        }
      }))
    }

    // Calculate values and configure options for this output
    const configuredOptions = {};
    
    try {
      Object.entries(options).forEach(([name, option]) => {
        try {
          const values = calculateOptionValues(option, manifestPaths);
          if (values.length > 0) {
            configuredOptions[name] = configureOption(option, values);
          }
        } catch (error) {
          console.warn(`Failed to configure option ${name}:`, error);
          // Continue with other options instead of failing completely
        }
      });

      // Register with parent component for syncing
      if (this.props.onRegisterOutputOptions) {
        this.props.onRegisterOutputOptions(outputId, configuredOptions, this.state.manifests.new);
      }
      
      this.setState({
        is_options_registered: true,
        is_loaded: true,
        local_options: configuredOptions,
      });
    } catch (error) {
      console.error('Failed to register options for output:', outputId, error);
      // Still mark as loaded to prevent infinite retry, but flag the error
      this.setState({
        is_options_registered: true,
        is_loaded: true,
        local_options: {},
        error: {
          ...this.state.error,
          "registration": `Option registration failed: ${error.message}`,
        }
      });
    }
  }

  getLocalOptions() {
    // Get options that are not synced - these are managed locally
    const { controls } = this.props;
    const syncPrefs = controls?.dynamic_options_sync || {};
    const localOptions = {};
    
    Object.entries(this.state.local_options).forEach(([name, option]) => {
      if (!syncPrefs[name]) {
        // Ensure local options have a selected value (default if not set)
        const selectedValue = option.selected || [option.defaultValue];
        localOptions[name] = {
          ...option,
          selected: selectedValue
        };
      }
    });
    
    return localOptions;
  }

  getEffectiveOptions() {
    // Combine synced global options with local options
    const { controls } = this.props;
    const globalOptions = controls?.dynamic_options || {};
    const syncPrefs = controls?.dynamic_options_sync || {};
    const localOptions = this.getLocalOptions();
    
    const effectiveOptions = {};
    
    // Add synced options
    Object.entries(globalOptions).forEach(([name, value]) => {
      if (syncPrefs[name] && Array.isArray(value) && value.length > 0) {
        effectiveOptions[name] = value;
      }
    });
    
    // Add local options
    Object.entries(localOptions).forEach(([name, option]) => {
      if (option.selected && option.selected.length > 0) {
        effectiveOptions[name] = option.selected;
      }
    });
    
    return effectiveOptions;
  }


  render() {
    const { is_loaded, error, viewable } = this.state;
    const { output_new, output_ref, config, files_filter } = this.props;

    const has_output_new = output_new !== undefined && output_new !== null
    if (!has_output_new || (output_new.is_pending && !output_new.is_running))
      return <span key="loading" />

    const style = {
      ...(config?.outputs?.style || {}),
      ...(this.props.style || {}),
    }

    // const has_filter = !!files_filter && files_filter.length > 0;
    // if (has_filter) {
    //   const matcher = match_query(files_filter)
    // }


    var content;
    if (!is_loaded && !has_output_new) {
      content = <span key="loading" />;
    } else {
      const { main_metrics, available_metrics } = this.props.metrics;

      // we display the input for each option before the first visualization that uses it
      let already_shown_options = {}

      var controls = this.props.controls ?? {};
      var views = config.outputs?.visualizations ?? [];
      let viewers = !viewable ? null : views.map((view, idx) => {
        // Use same logic as FloatingControlsPanel for consistency
        const isEnabled = (!view.default_hidden && controls.show?.[view.name] !== false) || 
                         (controls.show?.[view.name] === true);
        let hidden = !isEnabled;
        if (hidden)
          return <span key={idx} />

        // Get effective options (synced + local) for this view
        const effectiveOptions = this.getEffectiveOptions();
        
        // For now, we only show local options inline (non-synced options)
        // Synced options are controlled from the floating panel
        const localOptions = this.getLocalOptions();
        const { controls: globalControls } = this.props;
        const syncPrefs = globalControls?.dynamic_options_sync || {};
        
        // Filter for options relevant to this view that are not synced
        const viewLocalOptions = Object.entries(localOptions).filter(([name, option]) => {
          return !syncPrefs[name] && option.views && option.views.includes(view.name);
        });

        const new_options = viewLocalOptions.filter(([name]) => already_shown_options[name] === undefined);
        new_options.forEach(([name, option]) => already_shown_options[name] = option);
        
        const options = new_options.map(([name, option], idx) => {
          let option_idx = `option-${idx}`;
          const option_label = isNaN(name) ? name : option.pattern;
          
          if (option.views.every(viewName => (views.find(v => v.name === viewName) || {}).default_hidden === true && !(!!controls.show && controls.show[viewName] === true)))
            return <span key={option_idx} />
       
          const selectedValue = option.selected?.[0];
          if (!selectedValue) return <span key={option_idx} />;
          
          return (
            <div key={option_idx} style={{ 
              marginBottom: '8px', 
              padding: '8px', 
              backgroundColor: '#f5f8fa', 
              borderRadius: '3px', 
              border: '1px solid #e1e8ed' 
            }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: '4px' }}>
                <span style={{ fontSize: '12px', fontWeight: '500', flex: 1 }}>{option_label}</span>
                {this.props.onToggleDynamicOptionSync && (
                  <Tooltip content="Make this option synced across all outputs">
                    <Button
                      icon="link"
                      minimal
                      small
                      onClick={() => this.props.onToggleDynamicOptionSync(name)}
                      style={{ 
                        minHeight: '16px', 
                        minWidth: '16px',
                        padding: '2px',
                        opacity: 0.6,
                        transition: 'opacity 0.2s ease-out'
                      }}
                    >
                      unsynced
                    </Button>
                  </Tooltip>
                )}
              </div>
              {option.type === 'slider' ? (
                <Slider
                  initialValue={parseFloat(selectedValue)}
                  value={parseFloat(selectedValue)}
                  min={option.min}
                  max={option.max}
                  onChange={this.setSelectedOption(name)}
                  labelStepSize={Math.pow(10, Math.floor(Math.log10(option.max - option.min)))}
                  showTrackFill
                />
              ) : (
                option.values.length > 0 && (
                  <HTMLSelect 
                    disabled={option.values.length===1} 
                    options={option.values} 
                    value={selectedValue} 
                    onChange={this.setSelectedOption(name)} 
                    fill
                    small
                  />
                )
              )}
            </div>
          );
        });

        // Generate paths using both synced and local options
        var paths = generateViewPaths(view, effectiveOptions, this.state.manifests);

        let show_ref_if_available = controls.show_reference === undefined || controls.show_reference
        show_ref_if_available = show_ref_if_available || is_image(view)
        const viewers = paths.map(
          (path, path_idx) => {
            let new_available = path === undefined || (!!this.state.manifests.new && !!this.state.manifests.new[path])
            if (!new_available)
              return <span key={`${idx}-${path_idx}`}/>
            let ref_available = path === undefined || (!!this.state.manifests.reference && !!this.state.manifests.reference[path])

            // we changed the output format in HW_ALG from bmp to png in May 2024
            // but we still want to compare results across branches - for some time at least.
            let path_ref = path
            if(path !== undefined && path.endsWith('.png') && !ref_available) {
              const path_ref_ = path.replace(/.png$/, '.bmp')
              if (!!this.state.manifests.reference && !!this.state.manifests.reference[path_ref_]) {
                ref_available = true
                path_ref = path_ref_
              }
            }
            const has_same_data = is_same_data(path, this.state.manifests.manifests?.new?.[path], this.state.manifests.manifests?.reference?.[path_ref])
            return <div key={`${idx}-${path_idx}`} id={`${idx}-${path_idx}`}>
              {(paths.length > 1 || (() => {
                // Only show header if there are synced options relevant to this view
                const { options: viewOptions } = parseVisualizationOptions([view]);
                const relevantOptionNames = Object.values(viewOptions)
                  .filter(option => option.views.includes(view.name))
                  .map(option => option.name);
                return Object.entries(effectiveOptions).some(([optionName]) => {
                  const isSync = controls?.dynamic_options_sync?.[optionName];
                  const isRelevant = relevantOptionNames.includes(optionName);
                  return isSync && isRelevant;
                });
              })()) && (
                <div 
                  className="path-header"
                  style={{ 
                    fontSize: '12px', 
                    color: '#5c7080', 
                    marginBottom: '8px', 
                    paddingBottom: '4px',
                    borderBottom: '1px solid #e1e8ed',
                    fontFamily: 'monospace',
                    backgroundColor: '#f5f8fa',
                    padding: '4px 8px',
                    borderRadius: '3px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    transition: 'all 0.2s ease-out'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = '#e8f4f8';
                    e.currentTarget.style.borderColor = '#bfccd6';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = '#f5f8fa';
                    e.currentTarget.style.borderColor = '#e1e8ed';
                  }}
                >
                  <span style={{ flex: 1, marginRight: '8px' }}>{path}</span>
                  {Object.keys(effectiveOptions).length > 0 && (() => {
                    // Get options that are relevant to this specific view
                    const { options: viewOptions } = parseVisualizationOptions([view]);
                    const relevantOptionNames = Object.values(viewOptions)
                      .filter(option => option.views.includes(view.name))
                      .map(option => option.name);
                    
                    // Filter to only synced options that are relevant to this view
                    const relevantSyncedOptions = Object.entries(effectiveOptions)
                      .filter(([optionName, value]) => {
                        const isSync = controls?.dynamic_options_sync?.[optionName];
                        const isRelevant = relevantOptionNames.includes(optionName);
                        return isSync && isRelevant;
                      });
                    
                    if (relevantSyncedOptions.length === 0) return null;
                    
                    return (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        {relevantSyncedOptions.map(([optionName, value]) => (
                          <Tooltip 
                            key={optionName}
                            content={`Unsync "${optionName}" to control locally per output`}
                            position="top"
                          >
                            <Button
                              icon="unlink"
                              minimal
                              small
                              onClick={() => this.props.onToggleDynamicOptionSync && this.props.onToggleDynamicOptionSync(optionName)}
                              style={{ 
                                minHeight: '16px', 
                                minWidth: '16px',
                                padding: '2px',
                                opacity: 0.6,
                                transition: 'opacity 0.2s ease-out'
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.opacity = '1';
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.opacity = '0.6';
                              }}
                            />
                          </Tooltip>
                        ))}
                        <span style={{ 
                          fontSize: '10px', 
                          color: '#106ba3', 
                          fontWeight: '500',
                          marginLeft: '4px'
                        }}>
                          synced
                        </span>
                      </div>
                    );
                  })()}
                </div>
              )}
              {has_same_data && <div><Tag style={{marginTop: "5px"}} minimal icon="duplicate">same-data-compared</Tag></div>}
              <OutputViewer
                key={`${idx}-${path_idx}`}
                id={`${idx}-${path_idx}`}
                output_new={output_new}
                output_ref={(ref_available && show_ref_if_available) ? output_ref : undefined}
                manifests={this.state.manifests}
                {...view}
                {...controls}
                path={path}
                path_ref={path_ref}
                style={{ ...style, ...view.style }}
                fullscreen={this.state.fullscreen}
                config={config}
              />
          </div>})
        return <>
          {options}
          {viewers}
        </>
      })

      if (!viewable) {
        content = <span key="none-viewable"/>
      } else if (this.props.type === 'bit_accuracy') {
        content = <OutputViewer
          key="bit-accuracy"
          type="files/bit-accuracy"
          {...controls}
          controls={controls}
          output_new={output_new}
          output_ref={output_ref}
          manifests={this.state.manifests}
          style={style}
          show_all_files={this.props.show_all_files}
          hide_runs_without_files={this.props.hide_runs_without_files}
          expand_all={this.props.expand_all}
          color_blind_friendly={this.props.color_blind_friendly}
          files_filter={files_filter}
        />
      } else {
        content = <>
          <MetricsTags
            key="content-metrics-tags"
            selected_metrics={main_metrics}
            available_metrics={available_metrics}
            metrics_new={output_new.metrics ?? {}}
            metrics_ref={output_ref?.metrics && output_ref.id !== output_new.id ? output_ref.metrics : {}}
          />
          {viewers}
        </>
      }
    }


    // https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API
    // https://www.npmjs.com/package/react-intersection-observer

    let container_style = {
      flex: "0 0 auto",
      width: style.width || '1500px',
      marginBottom: "250px !important",
    }
    const maybe_style_skeleton = output_new.is_running ? style_skeleton : {};
    // console.log(content)
    // console.log(this.state.manifests)

    return <div style={container_style} className="output-card">
      <FullScreenableSlimCard
        updateFullscreen={this.updateFullscreen}
        className="output-card"
        style={{
          ...maybe_style_skeleton,
          paddingBottom: !viewable && "100px",
          minHeight: this.props.type !== 'bit_accuracy' && "400px",
        }}
      >
        {error.new && <Tooltip key="error-new" content={<span dangerouslySetInnerHTML={{ __html: !!error.new.response ? error.new.response.data : error.new }} />}>
          <Tag style={{ margin: '5px' }} intent={Intent.DANGER}>Download error @new</Tag>
        </Tooltip>}
        {error.reference && <Tooltip key="error-ref" content={<span dangerouslySetInnerHTML={{ __html: !!error.reference.response ? error.reference.response.data : error.reference }} />}>
          <Tag style={{ margin: '5px' }} intent={Intent.DANGER}>Download error @reference</Tag>
        </Tooltip>}
        {error.parse && <Tooltip key="error-parse" content={<ul>{error.parse.map(e => <li><strong>{e.path}:</strong> {e.message}</li>)}</ul>}>
          <Tag style={{ margin: '5px' }} intent={Intent.DANGER}>Parsing Error</Tag>
        </Tooltip>}
        {error.registration && <Tooltip key="error-registration" content={<span>{error.registration}</span>}>
          <Tag style={{ margin: '5px' }} intent={Intent.WARNING}>Registration Error</Tag>
        </Tooltip>}

        {!this.props.no_header && <OutputHeader
          key="header"
          project={this.props.project}
          commit={this.props.commit}
          output={output_new}
          output_ref={output_ref}
          viewable={viewable}
          manifests={this.state.manifests}
          type={this.props.type}
          dispatch={this.props.dispatch}
          style={condensed_header_style}
          prefix={output_new.is_running && <StatusTag output={output_new} style={{ marginRight: '5px' }}/>}
        />}
        {output_new.is_failed && <Tag key="new-failed" intent={Intent.DANGER}>Failed</Tag>}
        {output_ref && output_ref.is_failed && <Tag key="ref-failed" intent={Intent.WARNING}>Reference Failed</Tag>}
        {output_new.deleted && <Tag key="new-deleted" intent={Intent.DANGER}>Deleted</Tag>}
        {output_ref && output_ref.deleted && <Tag key="ref-deleted" intent={Intent.WARNING}>Reference deleted</Tag>}

        {!viewable && <InView
          key="unviewable"
          threshold={0.1}
          margin='100%'
          /*triggerOnce*/
          onChange={inView => this.becameViewable(inView)}
        >
          <span key="viewable"></span>
        </InView>}
        {(is_loaded || has_output_new) && content}
      </FullScreenableSlimCard>
    </div>
  }
}



// Adapted from
// https://github.com/ReactTraining/react-router/blob/82ce94c3b4e74f71018d104df6dc999801fa9ab2/packages/react-router/modules/matchPath.js
const cache = {};
const cacheLimit = 10000;
let cacheCount = 0;
function compilePath(path) {
  if (cache[path]) return cache[path];
  const regexp = compile(path);
  if (cacheCount < cacheLimit) {
    cache[path] = regexp;
    cacheCount++;
  }
  return regexp;
}


export { OutputCard, OutputHeader };
