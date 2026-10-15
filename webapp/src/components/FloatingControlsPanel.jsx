import { useState, useEffect } from "react";
import styled from "styled-components";  
import {
  Intent,
  Classes,
  Colors,
  HTMLSelect,
  Switch,
  Button,
  Collapse,
  Card,
  InputGroup,
  Tooltip,
} from "@blueprintjs/core";
import { is_image } from "../viewers/images/utils";
import DynamicOptionControl from "./DynamicOptionControl";
import { resolveOptionValue } from "../utils/dynamicOptions";
import { useIsDark } from "../theme";

const PanelContainer = styled.div`
  position: fixed;
  /* Closed, it's fully off-screen (with its shadow), and hidden from keyboard and screen readers once it slid out */
  right: ${props => props.isExpanded ? 0 : -340}px;
  visibility: ${props => props.isExpanded ? 'visible' : 'hidden'};
  top: 65%;
  transform: translateY(-50%);
  width: 320px;
  max-height: 80vh;
  overflow-y: auto;
  border-radius: 4px 0 0 4px;
  z-index: 19;
  transition: right 0.3s cubic-bezier(0.4, 0.0, 0.2, 1), visibility 0s linear ${props => props.isExpanded ? '0s' : '0.3s'};
  scrollbar-width: thin;
  scrollbar-color: var(--qa-border) transparent;

  .bp6-html-select select {
    font-size: 12px;
  }

  .bp6-control {
    font-size: 12px;
  }

  .bp6-control .bp6-control-indicator {
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

  &:hover {
    background-color: #293742 !important;
  }

  &:focus-visible {
    box-shadow: 0 0 0 2px rgba(138, 187, 255, 0.8) !important;
  }
`;

const StyledCard = styled(Card)`
  margin: 0;
  border-radius: 4px 0 0 4px;
  height: 100%;
  background-color: var(--qa-surface-alt);
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
  color: var(--qa-text-muted);
`;

const StyledSwitch = styled(Switch)`
  margin-bottom: 8px;
`;

const noop = () => {};
const no_options = {};
const no_files = new Set();

const storage_key = 'controls-panel-expanded';
// Until users choose, the panel starts open only on screens wide enough for it not to cover the results
const wide_screen = () => typeof window !== 'undefined' && window.innerWidth >= 1600;
const saved_expanded = () => {
  try {
    const saved = localStorage.getItem(storage_key);
    return saved !== null ? JSON.parse(saved) : wide_screen();
  } catch {
    return wide_screen();
  }
};

const FloatingControlsPanel = ({
  controls,
  visualizations,
  controls_extra,
  selected_views,
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
  dynamic_options = no_options,
  onUpdateDynamicOption = noop,
  onToggleDynamicOptionSync = noop,
  visualizations_with_files = no_files,
  expandPanel = false,
}) => {
  // Get initial panel state from localStorage, default to open
  const [isExpanded, setIsExpanded] = useState(saved_expanded);
  
  const [isExpandedWithLogs, setIsExpandedWithLogs] = useState(false);
  const is_dark = useIsDark();

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
    try {
      localStorage.setItem(storage_key, JSON.stringify(isExpanded));
    } catch {
      // private browsing, storage full...
    }
  }, [isExpanded]);

  // Expand panel when requested from parent
  const [prevExpandPanel, setPrevExpandPanel] = useState(expandPanel);
  if (expandPanel !== prevExpandPanel) {
    setPrevExpandPanel(expandPanel);
    if (expandPanel) {
      setIsExpanded(true);
      setExpandedSections(prev => ({
        ...prev,
        dynamic_options: true
      }));
    }
  }

  const toggleSection = (section) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  // undefined while we don't know
  const nb_runs = new_batch.outputs ? Object.keys(new_batch.outputs).length : undefined;
  const show_viewer_controls = (selected_views.includes('output-list') || selected_views.includes('bit-accuracy')) && nb_runs !== 0;
  // only the visualizations view shows visualizations
  const show_visualizations_stats = selected_views.includes('output-list');
  // With only the logs, the panel only has the sorting, and would cover the right side of the logs: it starts closed
  const only_logs = selected_views.includes('logs') && !show_viewer_controls
  const expanded = only_logs ? isExpandedWithLogs : isExpanded
  const setExpanded = only_logs ? setIsExpandedWithLogs : setIsExpanded
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
  
  // Calculate how many visualizations have files available
  const visualizationsWithFiles = visualizations.filter(view => {
    const viewName = view.name || view.path;
    return visualizations_with_files.has(viewName);
  }).length;
  
  const visualizations_by_name = new Map(visualizations.map(v => [v.name, v]));
  const isForDisplayedVisualization = option => option.views?.some(viewName => {
    const view = visualizations_by_name.get(viewName);
    return !!view && isVisualizationEnabled(view);
  });
  const availableDynamicOptions = Object.entries(dynamic_options || {}).filter(([, option]) => isForDisplayedVisualization(option));

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
      {!expanded && (
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
        isExpanded={expanded}
        icon={expanded ? "chevron-right" : "chevron-left"}
        minimal
        intent={Intent.PRIMARY}
        onClick={() => setExpanded(!expanded)}
        title={expanded ? "Hide the controls" : "Show the controls"}
        aria-label={expanded ? "Hide the controls" : "Show the controls: visualizations, options, sorting"}
        aria-expanded={expanded}
      />
      
      {/* Blueprint's elevation, on the container: its overflow would cut the card's shadow */}
      <PanelContainer isExpanded={expanded} className={Classes.ELEVATION_2}>

      <StyledCard>
        <PanelContent>
          <SectionTitle className={Classes.HEADING}>
            Controls
          </SectionTitle>

          {/* Enhanced Stats display - moved here for better visibility */}
          {show_visualizations_stats && (
            <div style={{ 
              fontSize: 11, 
              color: 'var(--qa-text-muted)', 
              marginBottom: 16, 
              padding: 8, 
              backgroundColor: 'var(--qa-surface)', 
              borderRadius: 3,
              border: '1px solid var(--qa-border)'
            }}>
              {nb_runs === 0 ? <div>No runs yet</div>
              : totalVisualizations === 0 ? <div>No visualizations configured in qaboard.yaml</div>
              : <>
                {/* which visualizations have files is known as the cards load their runs' files */}
                {visualizations_with_files.size > 0 ? <>
                  <div>📁 {visualizationsWithFiles}/{totalVisualizations} visualizations have files</div>
                  <div style={{ marginTop: 2 }}>
                    📊 {enabledVisualizations.filter(view => {
                      const viewName = view.name || view.path;
                      return visualizations_with_files.has(viewName);
                    }).length}/{visualizationsWithFiles} available visualizations enabled
                  </div>
                </> : <div>📊 {enabledVisualizations.length}/{totalVisualizations} visualizations enabled</div>}
                {availableDynamicOptions.length > 0 && (
                  <div style={{ marginTop: 2 }}>
                    🎛️ {availableDynamicOptions.length} dynamic option{availableDynamicOptions.length !== 1 ? 's' : ''} available
                  </div>
                )}
              </>}
            </div>
          )}

          {/* Visualizations Section */}
          {show_viewer_controls && (
            <>
              <SectionHeader onClick={() => toggleSection('visualizations')}>
                <Button
                  icon={expandedSections.visualizations ? "chevron-down" : "chevron-right"}
                  aria-label="Visualizations"
                  aria-expanded={expandedSections.visualizations}
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
                      <div style={{ color: 'var(--qa-text-muted)', fontSize: 12, fontStyle: 'italic' }}>
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
                  aria-label="Dynamic options"
                  aria-expanded={expandedSections.dynamic_options}
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
                      // If no views are specified, show the option anyway (fallback)
                      return isForDisplayedVisualization(option) || !option.views || option.views.length === 0;
                    })
                    .map(([name, option]) => {
                      // options are linked across outputs unless users unlink them
                      const isSync = controls.dynamic_options_sync?.[name] !== false;
                      if (!option.values || option.values.length === 0)
                        return null;
                      const wanted = [].concat(controls.dynamic_options?.[name] ?? [])[0];
                      const { value: selectedValue, exact } = resolveOptionValue(option, wanted);

                      return (
                        <ControlGroup key={name}>
                          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
                            <ControlLabel style={{ marginBottom: 0, marginRight: 8, flex: 1 }}>
                              {name}
                            </ControlLabel>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <Tooltip content={isSync ? "Unlink: choose the value in each run" : "Link: all runs use the value chosen here"}>
                                <Button
                                  icon="link"
                                  aria-label={isSync ? `Unlink ${name}` : `Link ${name}`}
                                  minimal
                                  small
                                  intent={isSync ? Intent.SUCCESS : Intent.NONE}
                                  onClick={() => onToggleDynamicOptionSync(name)}
                                  style={{ minHeight: 20, minWidth: 20 }}
                                />
                              </Tooltip>
                              <span style={{ 
                                fontSize: '10px', 
                                color: isSync ? (is_dark ? Colors.GREEN5 : Colors.GREEN2) : 'var(--qa-text-muted)',
                                fontWeight: '500'
                              }}>
                                {isSync ? 'linked' : 'per-run'}
                              </span>
                            </div>
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--qa-text-muted)', marginBottom: 4 }}>
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
                          {!isSync && <div style={{ fontSize: 10, color: 'var(--qa-text-muted)', marginTop: 4 }}>
                            Each run has its own control
                          </div>}
                          {isSync && !exact && <div style={{ fontSize: 10, color: 'var(--qa-text-muted)', marginTop: 4 }}>
                            <strong>{wanted}</strong> isn't in these runs, they show <strong>{selectedValue}</strong>
                          </div>}
                        </ControlGroup>
                      );
                    })}
                  {Object.keys(dynamic_options).length === 0 && (
                    <div style={{ color: 'var(--qa-text-muted)', fontSize: 12, fontStyle: 'italic' }}>
                      No dynamic options found
                    </div>
                  )}
                  {dynamicOptionsFilter && Object.entries(dynamic_options).filter(([name]) => 
                    name.toLowerCase().includes(dynamicOptionsFilter.toLowerCase())
                  ).length === 0 && (
                    <div style={{ color: 'var(--qa-text-muted)', fontSize: 12, fontStyle: 'italic' }}>
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
              aria-label="Sorting"
              aria-expanded={expandedSections.sorting}
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
                  aria-label="Metrics"
                  aria-expanded={expandedSections.metrics}
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