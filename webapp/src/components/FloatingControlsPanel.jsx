import { useState, useEffect } from "react";
import styled from "styled-components";
import {
  Classes,
  Intent,
  HTMLSelect,
  Switch,
  Button,
  Collapse,
  Card,
  Icon,
  InputGroup,
  Popover,
  Tooltip,
} from "@blueprintjs/core";
import { is_image } from "../viewers/images/utils";
import DynamicOptionControl from "./DynamicOptionControl";
import { defaultRule, optionLabel, resolveOptionValue } from "../utils/dynamicOptions";

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

  .${Classes.CONTROL} {
    font-size: 13px;
    margin-bottom: 6px;
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
  padding: 0;
  border-radius: 4px 0 0 4px;
  height: 100%;
  background-color: var(--qa-surface-alt);
`;

const PanelHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 12px 8px 16px;
  h4 {
    margin: 0;
    font-size: 16px;
  }
`;

// One section per kind of control, separated by a line: a header that folds it, what it applies to on the right
const SectionBlock = styled.section`
  border-top: 1px solid var(--qa-border);
  padding: 4px 12px 8px 8px;
`;

const SectionHeaderRow = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 32px;
  .section-toggle {
    flex: 1;
    justify-content: flex-start;
    font-weight: 600;
  }
`;

const Meta = styled.span`
  font-size: 12px;
  color: var(--qa-text-muted);
  white-space: nowrap;
`;

const SectionContent = styled.div`
  padding: 4px 0 4px 8px;
`;

const Hint = styled.div`
  font-size: 12px;
  line-height: 16px;
  color: var(--qa-text-muted);
  margin: 4px 0 8px 0;
`;

const OptionGroup = styled.div`
  & + & {
    margin-top: 14px;
  }
`;

const OptionHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 24px;
  .option-label {
    font-weight: 600;
    font-size: 13px;
  }
  .option-actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .${Classes.CONTROL} {
    margin: 0;
    font-size: 12px;
    color: var(--qa-text-muted);
  }
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

// "show_debug" -> "Show debug"
const humanize = name => optionLabel(name);

// Until users pick a value, each run shows its own default
const default_labels = { first: "Each run's first", last: "Each run's last" };

// A label that explains itself on hover
const Explained = ({ label, explanation, className }) => explanation
  ? <Tooltip content={<div style={{ maxWidth: 280 }}>{explanation}</div>} placement="left" hoverOpenDelay={300}>
      <span className={[Classes.TOOLTIP_INDICATOR, className].filter(Boolean).join(' ')}>{label}</span>
    </Tooltip>
  : <span className={className}>{label}</span>;

const PanelSection = ({ id, title, meta, isOpen, onToggle, children }) => <SectionBlock aria-labelledby={`controls-${id}`}>
  <SectionHeaderRow>
    <Button
      id={`controls-${id}`}
      className="section-toggle"
      variant="minimal"
      size="small"
      icon={isOpen ? "chevron-down" : "chevron-right"}
      aria-expanded={isOpen}
      onClick={onToggle}
      text={title}
    />
    {meta}
  </SectionHeaderRow>
  <Collapse isOpen={isOpen}>
    <SectionContent>{children}</SectionContent>
  </Collapse>
</SectionBlock>;

// How to read the sort order, depending on what we sort by
const order_labels = sort_by => {
  if (sort_by === 'test_input_path') return ['A to Z', 'Z to A'];
  if (sort_by === 'id') return ['Oldest first', 'Newest first'];
  if (sort_by === 'data.storage') return ['Smallest first', 'Largest first'];
  return ['Lowest first', 'Highest first'];
};

const FloatingControlsPanel = ({
  controls,
  visualizations,
  controls_extra,
  selected_views,
  new_batch,
  available_metrics,
  sort_by,
  default_sort_by,
  sort_order,
  onToggle,
  onToggleShow,
  onUpdate,
  has_tuning,
  tuned_params,
  dynamic_options = no_options,
  onUpdateDynamicOption = noop,
  onResetDynamicOption = noop,
  onToggleDynamicOptionSync = noop,
  has_changes = false,
  onResetControls = noop,
  visualizations_with_files = no_files,
  expandPanel = false,
  docs_root = '/',
}) => {
  // Get initial panel state from localStorage, default to open
  const [isExpanded, setIsExpanded] = useState(saved_expanded);

  const [isExpandedWithLogs, setIsExpandedWithLogs] = useState(false);

  const [expandedSections, setExpandedSections] = useState({
    visualizations: true,
    dynamic_options: true,
    viewers: true,
    sorting: true,
  });

  const [visualizationFilter, setVisualizationFilter] = useState("");

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

  const toggleSection = (section) => () => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  // undefined while we don't know
  const nb_runs = new_batch.outputs ? Object.keys(new_batch.outputs).length : undefined;
  const shows_cards = (selected_views.includes('output-list') || selected_views.includes('bit-accuracy')) && nb_runs !== 0;
  // only the visualizations view shows visualizations, and uses their options
  const shows_visualizations = selected_views.includes('output-list') && nb_runs !== 0;
  // With only the logs, the panel only has the sorting, and would cover the right side of the logs: it starts closed
  const only_logs = selected_views.includes('logs') && !shows_cards
  const expanded = only_logs ? isExpandedWithLogs : isExpanded
  const setExpanded = only_logs ? setIsExpandedWithLogs : setIsExpanded
  const maybe_diff = visualizations.some(v => is_image(v));
  // the summary doesn't list runs
  const sorting_applies = selected_views.some(view => view !== 'summary');

  // A visualization is shown unless hidden by default, or if users chose to show it
  const isVisualizationEnabled = (view) =>
    (!view.default_hidden && controls.show?.[view.name] !== false) || (controls.show?.[view.name] === true);

  // Which visualizations have files is known as the cards load their runs' files
  const knows_files = visualizations_with_files.size > 0;
  const has_files = view => !knows_files || visualizations_with_files.has(view.name || view.path);
  const visualizations_in_runs = visualizations.filter(has_files);
  const visualizations_without_files = visualizations.filter(view => !has_files(view));
  const nb_shown = visualizations_in_runs.filter(isVisualizationEnabled).length;

  const visualizations_by_name = new Map(visualizations.map(v => [v.name, v]));
  const isForDisplayedVisualization = option => option.views?.some(viewName => {
    const view = visualizations_by_name.get(viewName);
    return !!view && isVisualizationEnabled(view);
  });
  // Options for the visualizations shown (or for none in particular)
  const shown_options = Object.entries(dynamic_options || {})
    .filter(([, option]) => option.values?.length > 0)
    .filter(([, option]) => isForDisplayedVisualization(option) || !option.views || option.views.length === 0);

  const filter = visualizationFilter.toLowerCase();
  const visualization_switches = visualizations_in_runs
    .filter(view => !filter || (view.label || view.name || view.path).toLowerCase().includes(filter))
    .map((view, idx) => <Switch
      key={view.name ?? idx}
      checked={isVisualizationEnabled(view)}
      onChange={onToggleShow(view.name)}
      label={view.label || view.name || view.path}
    />);

  const viewer_switches = [
    ...(maybe_diff ? [<Switch
      key='diff'
      checked={controls.diff || false}
      onChange={onToggle('diff')}
      labelElement={<Explained label="Image diff" explanation="Adds the perceptual color difference between the new and reference images to each image viewer." />}
    />] : []),
    ...controls_extra.map(control => <Switch
      key={control.name}
      checked={!!controls[control.name]}
      onChange={onToggle(control.name)}
      label={control.label || humanize(control.name)}
    />),
  ];

  const dynamic_options_help = <div style={{ maxWidth: 300, padding: 12 }}>
    <p>Some visualizations have several files per run, like one per frame: their <code>path</code> in <em>qaboard.yaml</em> has
      parts that vary, like <code>:frame</code> in <code>frames/:frame.png</code>.</p>
    <p>Pick the file to show. It applies to all runs, unless you choose it per run.</p>
    <a href={`${docs_root}docs/visualizations#dynamic-visualizations`} target="_blank" rel="noopener noreferrer">Learn more</a>
  </div>;

  const option_rows = shown_options.map(([name, option]) => {
    const label = optionLabel(name);
    // options are linked across runs unless users unlink them
    const isSync = controls.dynamic_options_sync?.[name] !== false;
    const wanted = [].concat(controls.dynamic_options?.[name] ?? [])[0];
    const { value: selectedValue, exact } = resolveOptionValue(option, wanted);
    // Until users pick a value, each run shows its own default, e.g. its last frame: we don't show one value for all
    const picked = wanted !== undefined;
    const has_choice = option.values.length > 1;
    const default_label = default_labels[defaultRule(option)];
    const for_views = (option.views ?? []).map(name => visualizations_by_name.get(name)?.label || name).filter(Boolean);
    const first_value = option.values[0];
    const last_value = option.values[option.values.length - 1];
    const explanation = <>
      <div>Which file <strong>{for_views.join(', ')}</strong> show{for_views.length === 1 ? 's' : ''}: <code>{(option.paths ?? []).join(', ')}</code></div>
      <div style={{ marginTop: 4 }}>
        {has_choice
          ? <>{option.values.length} values in these runs, from <strong>{first_value}</strong> to <strong>{last_value}</strong>.</>
          : <>Only <strong>{first_value}</strong> in these runs.</>}
      </div>
      {has_choice && <div style={{ marginTop: 4 }}>Until you pick one: {default_label.toLowerCase()}.</div>}
    </>;

    return (
      <OptionGroup key={name}>
        <OptionHeader>
          <Explained className="option-label" label={label} explanation={explanation} />
          <div className="option-actions">
            {isSync && picked && <Tooltip content={<>Back to the default: {default_label.toLowerCase()}</>} placement="left">
              <Button icon="reset" variant="minimal" size="small" aria-label={`Reset ${label}`} onClick={() => onResetDynamicOption(name)} />
            </Tooltip>}
            <Tooltip
              content={isSync ? "Choose it in each run's card instead of here" : "Use the value chosen here for all runs"}
              placement="left"
            >
              <Switch
                checked={!isSync}
                onChange={() => onToggleDynamicOptionSync(name)}
                label="Per run"
                alignIndicator="right"
                inline
              />
            </Tooltip>
          </div>
        </OptionHeader>
        {/* which visualizations it's for, unless the label says it already, e.g. for regular expressions named after their visualization */}
        {for_views.join(', ') !== label && <Hint style={{ margin: '0 0 6px 0' }}>{for_views.join(', ')}</Hint>}
        {isSync
          ? <DynamicOptionControl
              name={name}
              label={label}
              option={option}
              selectedValue={picked ? selectedValue : undefined}
              defaultLabel={has_choice ? default_label : undefined}
              defaultRule={defaultRule(option)}
              onChange={(value) => value === undefined ? onResetDynamicOption(name) : onUpdateDynamicOption(name, value)}
              small
            />
          : <Hint><Icon icon="unlink" size={12} style={{ marginRight: 6 }} />Chosen in each run's card</Hint>}
        {isSync && !has_choice && <Hint>All runs have only this value</Hint>}
        {isSync && has_choice && !picked && option.type === 'slider' && <Hint>Default: {default_label.toLowerCase()}</Hint>}
        {isSync && !exact && <Hint>
          <Icon icon="info-sign" size={12} style={{ marginRight: 6 }} />
          No run has <strong>{wanted}</strong>: they show <strong>{selectedValue}</strong>
        </Hint>}
      </OptionGroup>
    );
  });

  // The default sort, e.g. the project's main metric, is marked as such
  const sort_value = sort_by ?? default_sort_by ?? 'test_input_path';
  const default_mark = key => key === (default_sort_by ?? 'test_input_path') ? ' (default)' : '';
  const [ascending_label, descending_label] = order_labels(sort_value);

  return (
    <>
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
        <PanelHeader>
          <h4 className={Classes.HEADING}>Controls</h4>
          {has_changes && <Tooltip content="Back to the project's defaults: visualizations, files to show and viewers. The sorting stays." placement="left">
            <Button icon="reset" text="Reset" variant="minimal" size="small" onClick={onResetControls} />
          </Tooltip>}
        </PanelHeader>

        {nb_runs === 0 && <Hint style={{ padding: '0 16px 8px' }}>No runs yet</Hint>}

        {shows_visualizations && <PanelSection
          id="visualizations"
          title="Visualizations"
          meta={visualizations.length > 0 && <Meta>{nb_shown} of {visualizations_in_runs.length} shown</Meta>}
          isOpen={expandedSections.visualizations}
          onToggle={toggleSection('visualizations')}
        >
          {visualizations.length === 0 && <Hint>None configured in <em>qaboard.yaml</em></Hint>}
          {visualizations_in_runs.length > 8 && <InputGroup
            leftIcon="search"
            placeholder="Filter visualizations"
            aria-label="Filter visualizations"
            value={visualizationFilter}
            onChange={(e) => setVisualizationFilter(e.target.value)}
            size="small"
            style={{ marginBottom: 8 }}
          />}
          {visualization_switches}
          {filter && visualization_switches.length === 0 && <Hint>No visualizations match “{visualizationFilter}”</Hint>}
          {visualizations_without_files.length > 0 && <Hint>
            <Explained
              label={`${visualizations_without_files.length} more without files in these runs`}
              explanation={visualizations_without_files.map(view => view.label || view.name || view.path).join(', ')}
            />
          </Hint>}
        </PanelSection>}

        {shows_visualizations && option_rows.length > 0 && <PanelSection
          id="dynamic_options"
          title="Files to show"
          meta={<Popover content={dynamic_options_help} interactionKind="hover" placement="left" hoverOpenDelay={200}>
            <Button icon="help" variant="minimal" size="small" aria-label="What are the files to show?" />
          </Popover>}
          isOpen={expandedSections.dynamic_options}
          onToggle={toggleSection('dynamic_options')}
        >
          {option_rows}
        </PanelSection>}

        {shows_cards && viewer_switches.length > 0 && <PanelSection
          id="viewers"
          title="Viewers"
          isOpen={expandedSections.viewers}
          onToggle={toggleSection('viewers')}
        >
          {viewer_switches}
        </PanelSection>}

        <PanelSection
          id="sorting"
          title="Sort runs"
          isOpen={expandedSections.sorting}
          onToggle={toggleSection('sorting')}
        >
          {!sorting_applies && <Hint>Applies to the tables and the run cards, not to the summary.</Hint>}
          <div style={{ display: 'flex', gap: 6 }}>
            <HTMLSelect
              value={sort_value}
              onChange={onUpdate('sort_by')}
              aria-label="Sort runs by"
              fill
              small
            >
              <option value="test_input_path">Name{default_mark('test_input_path')}</option>
              <option value="id">Run id{default_mark('id')}</option>
              <option value="data.storage">Storage{default_mark('data.storage')}</option>
              {has_tuning && <optgroup label="Tuning parameters">
                {tuned_params.map(param =>
                  <option key={param} value={param}>
                    {param} ({new_batch.extra_parameters[param].size} values)
                  </option>
                )}
              </optgroup>}
              <optgroup label="Metrics">
                {[...new_batch.used_metrics].filter(m => !!available_metrics[m]).map(m => available_metrics[m]).map(
                  m => (
                    <option key={m.key} value={m.key}>
                      {m.label}{default_mark(m.key)}
                    </option>
                  )
                )}
              </optgroup>
            </HTMLSelect>
            <HTMLSelect
              value={sort_order}
              onChange={onUpdate('sort_order')}
              aria-label="Sort order"
              small
              style={{ minWidth: 118 }}
            >
              <option value={-1}>{descending_label}</option>
              <option value={1}>{ascending_label}</option>
            </HTMLSelect>
          </div>
        </PanelSection>
      </StyledCard>
      </PanelContainer>
    </>
  );
};

export default FloatingControlsPanel;
