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
} from "@blueprintjs/core";
import { is_image } from "../viewers/images/utils";

const PanelContainer = styled.div`
  position: fixed;
  right: ${props => props.isExpanded ? 0 : -300}px;
  top: 60%;
  transform: translateY(-50%);
  width: 320px;
  max-height: 80vh;
  overflow-y: auto;
  z-index: 1000;
  transition: right 0.3s ease-in-out;
  box-shadow: 0 4px 20px rgba(0,0,0,0.15);
  scrollbar-width: thin;
  scrollbar-color: rgba(0,0,0,0.2) transparent;

  .bp4-html-select select {
    font-size: 12px;
  }

  .bp4-control {
    font-size: 12px;
  }

  .bp4-control .bp4-control-indicator {
    margin-right: 8px;
  }
`;

const ToggleButton = styled(Button)`
  position: fixed;
  right: ${props => props.isExpanded ? 320 : 0}px;
  top: 60%;
  transform: translateY(-50%);
  border-radius: 4px 0 0 4px;
  height: 64px;
  width: 40px;
  z-index: 1001;
  transition: right 0.3s ease-in-out;
  background-color: #394b59 !important;
  color: white !important;
  border: none !important;
  box-shadow: 0 2px 10px rgba(0,0,0,0.15);

  &:hover {
    background-color: #293742 !important;
  }

  &:focus {
    box-shadow: 0 0 0 1px rgba(255,255,255,0.3) !important;
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
}) => {
  // Get initial panel state from localStorage, default to open
  const [isExpanded, setIsExpanded] = useState(() => {
    const saved = localStorage.getItem('controls-panel-expanded');
    return saved !== null ? JSON.parse(saved) : true;
  });
  
  const [expandedSections, setExpandedSections] = useState({
    visualizations: true,
    sorting: true,
    metrics: false,
  });
  
  const [visualizationFilter, setVisualizationFilter] = useState("");

  // Save panel state to localStorage when it changes
  useEffect(() => {
    localStorage.setItem('controls-panel-expanded', JSON.stringify(isExpanded));
  }, [isExpanded]);

  const toggleSection = (section) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  const show_viewer_controls = selected_views.includes('output-list') || selected_views.includes('bit-accuracy');
  const maybe_diff = visualizations.some(v => is_image(v));

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
      if (!view.default_hidden ||
          controls.show === undefined || controls.show === null ||
          controls.show[view.name] === undefined || controls.show[view.name] === null)
        return;
      
      const label = view.label || view.name || view.path;
      if (visualizationFilter && !label.toLowerCase().includes(visualizationFilter.toLowerCase()))
        return;
      
      visualizationControls.push(
        <StyledSwitch
          key={idx}
          checked={controls.show[view.name]}
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

          {/* Visualizations Section */}
          {show_viewer_controls && visualizationControls.length > 0 && (
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
          {selected_metrics.length > 0 && (
            <>
              <SectionHeader onClick={() => toggleSection('metrics')}>
                <Button
                  icon={expandedSections.metrics ? "chevron-down" : "chevron-right"}
                  minimal
                  small
                  style={{ marginRight: 4, minHeight: 20, minWidth: 20 }}
                />
                <SectionLabel>Metrics ({selected_metrics.length})</SectionLabel>
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