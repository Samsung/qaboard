import React, { useState, useEffect } from "react";
import styled from "styled-components";  
import {
  Intent,
  Classes,
  HTMLSelect,
  Switch,
  Button,
  Collapse,
  Card,
  Divider,
  InputGroup,
  Slider,
  Tag,
  Tooltip,
} from "@blueprintjs/core";
import { is_image } from "../viewers/images/utils";
import DynamicOptionControl from "./DynamicOptionControl";

const PanelContainer = styled.div`
  position: fixed;
  right: ${props => props.isExpanded ? 0 : -300}px;
  top: 65%;
  transform: translateY(-50%);
  width: 320px;
  max-height: 80vh;
  overflow-y: auto;
  z-index: 19;
  transition: all 0.3s cubic-bezier(0.4, 0.0, 0.2, 1);
  box-shadow: 0 4px 20px rgba(0,0,0,0.15);
  scrollbar-width: thin;
  scrollbar-color: rgba(0,0,0,0.2) transparent;

  /* Subtle hover effect when collapsed */
  ${props => !props.isExpanded && `
    &:hover {
      right: -295px;
      box-shadow: 0 6px 25px rgba(0,0,0,0.2);
    }
  `}

  .bp5-html-select select {
    font-size: 12px;
  }

  .bp5-control {
    font-size: 12px;
  }

  .bp5-control .bp5-control-indicator {
    margin-right: 8px;
  }
`;

const ToggleButton = styled(Button)`
  position: fixed;
  right: ${props => props.isExpanded ? 320 : 0}px;
  top: 65%;
  transform: translateY(-50%);
  border-radius: 4px 0 0 4px;
  height: 64px;
  width: 40px;
  z-index: 1001;
  transition: all 0.3s cubic-bezier(0.4, 0.0, 0.2, 1);
  background-color: #394b59 !important;
  color: white !important;
  border: none !important;
  box-shadow: 0 2px 10px rgba(0,0,0,0.15);
  overflow: hidden;

  /* Subtle pulse animation to hint at interactivity */
  &::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.1) 50%, transparent 100%);
    transform: translateX(-100%);
    transition: transform 2s ease-in-out;
  }

  /* Animate the shimmer effect periodically when collapsed */
  ${props => !props.isExpanded && `
    animation: subtlePulse 4s ease-in-out infinite;
    
    &::before {
      animation: shimmer 4s ease-in-out infinite;
    }
  `}

  &:hover {
    background-color: #293742 !important;
    width: ${props => props.isExpanded ? '40px' : '48px'};
    height: ${props => props.isExpanded ? '64px' : '72px'};
    box-shadow: 0 4px 20px rgba(0,0,0,0.25);
    right: ${props => props.isExpanded ? '320px' : '-4px'};
    
    /* Scale up the icon slightly */
    .bp5-icon {
      transform: scale(1.1);
      transition: transform 0.2s ease-out;
    }
  }

  &:focus {
    box-shadow: 0 0 0 2px rgba(255,255,255,0.4) !important;
  }

  .bp5-icon {
    transition: transform 0.2s ease-out;
  }

  @keyframes subtlePulse {
    0%, 100% { 
      box-shadow: 0 2px 10px rgba(0,0,0,0.15); 
    }
    50% { 
      box-shadow: 0 2px 12px rgba(0,0,0,0.2), 0 0 0 1px rgba(255,255,255,0.1); 
    }
  }

  @keyframes shimmer {
    0% { transform: translateX(-100%); }
    50% { transform: translateX(-100%); }
    51% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
  }
`;

const StyledCard = styled(Card)`
  margin: 0;
  border-radius: 4px 0 0 4px;
  height: 100%;
  background-color: #f5f8fa;
  box-shadow: 0 4px 20px rgba(0,0,0,0.15) !important;
`;

const PanelContent = styled.div`
  padding: 16px 12px;
`;

const SectionTitle = styled.h4`
  margin: 0 0 16px 0;
  font-size: 14px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
`;

const SectionHeader = styled.div`
  cursor: pointer;
  display: flex;
  align-items: center;
  margin-bottom: 8px;
  padding: 4px 0;
`;

const SectionLabel = styled.span`
  font-weight: 600;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
`;

const SectionContent = styled.div`
  padding-left: 24px;
  margin-bottom: 16px;
`;

const ControlGroup = styled.div`
  margin-bottom: 12px;
`;

const ControlLabel = styled.label`
  display: block;
  font-size: 11px;
  font-weight: 500;
  margin-bottom: 4px;
  color: #5c7080;
`;

const StyledSwitch = styled(Switch)`
  margin-bottom: 8px;
`;

const FloatingControlsPanel = ({
  controls,
  visualizations,
  controls_extra,
  selected_views,
  selected_metrics,
  new_batch,
  available_metrics,
  metricTableSelect,
  sort_by,
  sort_order,
  onToggle,
  onToggleShow,
  onUpdate,
  has_tuning,
  tuned_params,
  dynamic_options = {},
  onUpdateDynamicOption = () => {},
  onToggleDynamicOptionSync = () => {},
  visualization_stats = { total_visualizations: 0, disabled_visualizations: 0, missing_files_count: 0 },
  visualizations_with_files = new Set(),
  expandPanel = false,
  registration_info = { total_outputs: 0, registered_outputs: 0, is_throttled: false, last_recompute_at: 0 },
  onForceReregisterAllOptions = () => {},
}) => {
  // Get initial panel state from localStorage, default to open
  const [isExpanded, setIsExpanded] = useState(() => {
    const saved = localStorage.getItem('controls-panel-expanded');
    return saved !== null ? JSON.parse(saved) : true;
  });
  
  const [expandedSections, setExpandedSections] = useState({
    visualizations: true,
    dynamic_options: true,
    sorting: true,
    metrics: false,
  });
  
  const [visualizationFilter, setVisualizationFilter] = useState("");
  const [dynamicOptionsFilter, setDynamicOptionsFilter] = useState("");

  // Save panel state to localStorage when it changes
  useEffect(() => {
    localStorage.setItem('controls-panel-expanded', JSON.stringify(isExpanded));
  }, [isExpanded]);

  // Expand panel when requested from parent
  useEffect(() => {
    if (expandPanel) {
      setIsExpanded(true);
      setExpandedSections(prev => ({
        ...prev,
        dynamic_options: true
      }));
    }
  }, [expandPanel]);

  const toggleSection = (section) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  const show_viewer_controls = selected_views.includes('output-list') || selected_views.includes('bit-accuracy');
  const maybe_diff = visualizations.some(v => is_image(v));

  // Helper function to check if a visualization is currently enabled
  const isVisualizationEnabled = (view) => {
    // A visualization is enabled if:
    // 1. It's not default_hidden AND user hasn't explicitly disabled it, OR
    // 2. User has explicitly enabled it (regardless of default_hidden)
    return (!view.default_hidden && controls.show?.[view.name] !== false) || 
           (controls.show?.[view.name] === true);
  };

  // Calculate visualization stats
  const totalVisualizations = visualizations.length;
  const enabledVisualizations = visualizations.filter(isVisualizationEnabled);
  const hiddenVisualizations = totalVisualizations - enabledVisualizations.length;
  
  // Calculate how many visualizations have files available
  const visualizationsWithFiles = visualizations.filter(view => {
    const viewName = view.name || view.path;
    return visualizations_with_files.has(viewName);
  }).length;
  
  const availableDynamicOptions = Object.entries(dynamic_options || {}).filter(([name, option]) => {
    return option.views?.some(viewName => {
      const view = visualizations.find(v => v.name === viewName);
      if (!view) return false;
      return isVisualizationEnabled(view);
    });
  });

  // Build visualization controls
  const visualizationControls = [];

  // Add image diff control if applicable
  if (maybe_diff) {
    visualizationControls.push(
      <StyledSwitch
        key='diff'
        intent={Intent.WARNING}
        checked={controls.diff || false}
        onChange={onToggle('diff')}
        labelElement={<strong>Image Diff</strong>}
        innerLabel="off"
        innerLabelChecked="on"
      />
    );
  }

  // Add view toggle controls with filtering
  if (!selected_views.includes('bit-accuracy')) {
    visualizations.forEach((view, idx) => {
      // Only show visualizations that have files available
      const viewName = view.name || view.path;
      if (visualizations_with_files.size > 0 && !visualizations_with_files.has(viewName)) {
        return; // Skip visualizations with no available files
      }
      
      // Show toggles for all visualizations with files
      // This allows users to hide/show any visualization, regardless of default state
      
      const label = view.label || view.name || view.path;
      if (visualizationFilter && !label.toLowerCase().includes(visualizationFilter.toLowerCase()))
        return;
      
      visualizationControls.push(
        <StyledSwitch
          key={idx}
          checked={isVisualizationEnabled(view)}
          onChange={onToggleShow(view.name)}
          label={label}
        />
      );
    });
  }

  // Add extra controls with filtering
  controls_extra.forEach(control => {
    const label = control.label || control.name;
    if (visualizationFilter && !label.toLowerCase().includes(visualizationFilter.toLowerCase()))
      return;
      
    visualizationControls.push(
      <StyledSwitch
        key={control.name}
        checked={controls[control.name]}
        onChange={onToggle(control.name)}
        label={label}
      />
    );
  });

  return (
    <>
      {/* Invisible hover detection zone when collapsed */}
      {!isExpanded && (
        <div
          style={{
            position: 'fixed',
            right: -10,
            top: '60%',
            transform: 'translateY(-50%)',
            width: 20,
            height: 120,
            zIndex: 19,
            pointerEvents: 'none',
          }}
        />
      )}
      
      {/* Toggle button */}
      <ToggleButton
        isExpanded={isExpanded}
        icon={isExpanded ? "chevron-right" : "chevron-left"}
        minimal
        intent={Intent.PRIMARY}
        onClick={() => setIsExpanded(!isExpanded)}
        title="Toggle Controls Panel"
      />
      
      <PanelContainer isExpanded={isExpanded}>

      <StyledCard>
        <PanelContent>
          <SectionTitle className={Classes.HEADING}>
            Controls
          </SectionTitle>

          {/* Enhanced Stats display - moved here for better visibility */}
          {(hiddenVisualizations > 0 || totalVisualizations > 0 || visualizations_with_files.size > 0) && (
            <div style={{ 
              fontSize: 11, 
              color: '#5c7080', 
              marginBottom: 16, 
              padding: 8, 
              backgroundColor: '#f5f8fa', 
              borderRadius: 3,
              border: '1px solid #e1e8ed'
            }}>
              {visualizations_with_files.size > 0 && (
                <div>📁 {visualizationsWithFiles}/{totalVisualizations} visualizations have files</div>
              )}
              {visualizationsWithFiles > 0 && (
                <div style={{ marginTop: 2 }}>
                  📊 {enabledVisualizations.filter(view => {
                    const viewName = view.name || view.path;
                    return visualizations_with_files.has(viewName);
                  }).length}/{visualizationsWithFiles} available visualizations enabled
                </div>
              )}
              {availableDynamicOptions.length > 0 && (
                <div style={{ marginTop: 2 }}>
                  🎛️ {availableDynamicOptions.length} dynamic option{availableDynamicOptions.length !== 1 ? 's' : ''} available
                </div>
              )}
              {visualizationsWithFiles == 0 && (
                  <div style={{ marginTop: 2 }}>
                    🛇 No visualizations available
                  </div>
                )
              }
              {registration_info.is_throttled && registration_info.total_outputs > 0 && (
                <div style={{ marginTop: 2 }}>
                  📝 {registration_info.registered_outputs}/{registration_info.total_outputs} outputs registered
                  {registration_info.is_throttled && (
                    <span style={{ color: '#d9822b' }}> (throttled)</span>
                  )}
                </div>
              )}
              {registration_info.is_throttled && (
                <div style={{ marginTop: 4 }}>
                  <Button
                    icon="refresh"
                    small
                    onClick={onForceReregisterAllOptions}
                    style={{ fontSize: '11px' }}
                  >
                    Refresh Options
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Visualizations Section */}
          {show_viewer_controls && (
            <>
              <SectionHeader onClick={() => toggleSection('visualizations')}>
                <Button
                  icon={expandedSections.visualizations ? "chevron-down" : "chevron-right"}
                  minimal
                  small
                  style={{ marginRight: 4, minHeight: 20, minWidth: 20 }}
                />
                <SectionLabel>Visualizations</SectionLabel>
              </SectionHeader>
              <Collapse isOpen={expandedSections.visualizations}>
                <SectionContent>
                  {visualizations.length > 5 && (
                    <ControlGroup>
                      <InputGroup
                        leftIcon="search"
                        placeholder="Filter visualizations..."
                        value={visualizationFilter}
                        onChange={(e) => setVisualizationFilter(e.target.value)}
                        small
                        style={{ marginBottom: 12 }}
                      />
                    </ControlGroup>
                  )}
                  {visualizationControls.length > 0 ? visualizationControls : (
                    visualizationFilter && (
                      <div style={{ color: '#5c7080', fontSize: 12, fontStyle: 'italic' }}>
                        No visualizations match "{visualizationFilter}"
                      </div>
                    )
                  )}
                </SectionContent>
              </Collapse>
            </>
          )}

          {/* Dynamic Options Section */}
          {dynamic_options && availableDynamicOptions.length > 0 && (
            <>
              <SectionHeader onClick={() => toggleSection('dynamic_options')}>
                <Button
                  icon={expandedSections.dynamic_options ? "chevron-down" : "chevron-right"}
                  minimal
                  small
                  style={{ marginRight: 4, minHeight: 20, minWidth: 20 }}
                />
                <SectionLabel>Dynamic Options</SectionLabel>
              </SectionHeader>
              <Collapse isOpen={expandedSections.dynamic_options}>
                <SectionContent>
                  {Object.keys(dynamic_options).length > 3 && (
                    <ControlGroup>
                      <InputGroup
                        leftIcon="search"
                        placeholder="Filter options..."
                        value={dynamicOptionsFilter}
                        onChange={(e) => setDynamicOptionsFilter(e.target.value)}
                        small
                        style={{ marginBottom: 12 }}
                      />
                    </ControlGroup>
                  )}
                  {Object.entries(dynamic_options)
                    .filter(([name, option]) => {
                      // Filter by search text
                      if (dynamicOptionsFilter && !name.toLowerCase().includes(dynamicOptionsFilter.toLowerCase())) {
                        return false;
                      }
                      
                      // Hide options for visualizations that are not displayed
                      const isForDisplayedVisualization = option.views?.some(viewName => {
                        const view = visualizations.find(v => v.name === viewName);
                        if (!view) return false;
                        return isVisualizationEnabled(view);
                      });
                      
                      // If no views are specified, show the option anyway (fallback)
                      return isForDisplayedVisualization || !option.views || option.views.length === 0;
                    })
                    .map(([name, option]) => {
                      const isSync = controls.dynamic_options_sync?.[name] || false;
                      const selectedValue = controls.dynamic_options?.[name]?.[0];
                      
                      if (!selectedValue || !option.values || option.values.length === 0) {
                        return null;
                      }

                      return (
                        <ControlGroup key={name}>
                          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
                            <ControlLabel style={{ marginBottom: 0, marginRight: 8, flex: 1 }}>
                              {name}
                            </ControlLabel>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <Tooltip content={isSync ? "Click to unsync (make local to each output)" : "Click to sync across all outputs"}>
                                <Button
                                  icon="link"
                                  minimal
                                  small
                                  intent={isSync ? Intent.SUCCESS : Intent.NONE}
                                  onClick={() => onToggleDynamicOptionSync(name)}
                                  style={{ minHeight: 20, minWidth: 20 }}
                                />
                              </Tooltip>
                              <span style={{ 
                                fontSize: '10px', 
                                color: isSync ? '#0d8050' : '#5c7080',
                                fontWeight: '500'
                              }}>
                                {isSync ? 'synced' : 'per-output'}
                              </span>
                            </div>
                          </div>
                          <div style={{ fontSize: 10, color: '#5c7080', marginBottom: 4 }}>
                            {option.paths && option.paths.length > 0 && (
                              <div style={{ fontStyle: 'italic' }}>
                                Paths: {option.paths.slice(0, 3).join(', ')}
                                {option.paths.length > 3 && ` +${option.paths.length - 3} more`}
                              </div>
                            )}
                          </div>
                          <DynamicOptionControl
                            name={name}
                            option={option}
                            selectedValue={selectedValue}
                            onChange={(value) => onUpdateDynamicOption(name, value)}
                            disabled={!isSync}
                            small={true}
                            showLabel={false}
                          />
                        </ControlGroup>
                      );
                    })}
                  {Object.keys(dynamic_options).length === 0 && (
                    <div style={{ color: '#5c7080', fontSize: 12, fontStyle: 'italic' }}>
                      No dynamic options found
                    </div>
                  )}
                  {dynamicOptionsFilter && Object.entries(dynamic_options).filter(([name]) => 
                    name.toLowerCase().includes(dynamicOptionsFilter.toLowerCase())
                  ).length === 0 && (
                    <div style={{ color: '#5c7080', fontSize: 12, fontStyle: 'italic' }}>
                      No options match "{dynamicOptionsFilter}"
                    </div>
                  )}
                </SectionContent>
              </Collapse>
            </>
          )}

          {/* Sorting Section */}
          <SectionHeader onClick={() => toggleSection('sorting')}>
            <Button
              icon={expandedSections.sorting ? "chevron-down" : "chevron-right"}
              minimal
              small
              style={{ marginRight: 4, minHeight: 20, minWidth: 20 }}
            />
            <SectionLabel>Sorting</SectionLabel>
          </SectionHeader>
          <Collapse isOpen={expandedSections.sorting}>
            <SectionContent>
              <ControlGroup>
                <ControlLabel>Sort By</ControlLabel>
                <HTMLSelect
                  value={sort_by}
                  onChange={onUpdate('sort_by')}
                  fill
                  small
                >
                  <option value="test_input_path">Name</option>
                  <option value="id">ID</option>
                  <option value="data.storage">Storage</option>
                  {has_tuning && <option style={{fontWeight: 'bold'}} disabled>— Tuning —</option>}
                  {tuned_params.map(param =>
                    <option key={param} value={param}>
                      {param} ({new_batch.extra_parameters[param].size})
                    </option>
                  )}
                  <option disabled style={{fontWeight: 'bold'}}>— Metrics —</option>
                  {[...new_batch.used_metrics].filter(m => !!available_metrics[m]).map(m => available_metrics[m]).map(
                    m => (
                      <option key={m.key} value={m.key}>
                        {m.label}
                      </option>
                    )
                  )}
                </HTMLSelect>
              </ControlGroup>
              <ControlGroup>
                <ControlLabel>Order</ControlLabel>
                <HTMLSelect
                  value={sort_order}
                  onChange={onUpdate('sort_order')}
                  fill
                  small
                >
                  <option value={-1}>Descending</option>
                  <option value={1}>Ascending</option>
                </HTMLSelect>
              </ControlGroup>
            </SectionContent>
          </Collapse>

          {/* Metrics Section */}
          {new_batch.used_metrics.size > 0 && (
            <>
              <SectionHeader onClick={() => toggleSection('metrics')}>
                <Button
                  icon={expandedSections.metrics ? "chevron-down" : "chevron-right"}
                  minimal
                  small
                  style={{ marginRight: 4, minHeight: 20, minWidth: 20 }}
                />
                <SectionLabel>Metrics ({new_batch.used_metrics.size})</SectionLabel>
              </SectionHeader>
              <Collapse isOpen={expandedSections.metrics}>
                <SectionContent>
                  {metricTableSelect}
                </SectionContent>
              </Collapse>
            </>
          )}
        </PanelContent>
      </StyledCard>
      </PanelContainer>
    </>
  );
};

export default FloatingControlsPanel;