import { useState } from "react";
import styled from "styled-components";
import {
  Classes,
  HTMLSelect,
  Switch,
  Button,
  Icon,
  InputGroup,
  PopoverNext,
  Tooltip,
} from "@blueprintjs/core";
import { is_image } from "../viewers/images/utils";
import { DEFAULT_MODE, MODES } from "../image-viewer/modes";
import DynamicOptionControl from "./DynamicOptionControl";
import { defaultRule, optionLabel, resolveOptionValue } from "../utils/dynamicOptions";
import SidePanel from "./SidePanel";
import { SharedSettings, useSharedConfiguration, useHideSharedSettings } from "../configurations/ConfigurationsTags";
import { HideSharedSwitch } from "../configurations/ConfigurationOverview";
import { FileOptionSwitches, file_options_summary } from "../viewers/bit_accuracy/utils";

// The commit page's View options: what the views of the runs' results show, and in which order.
// Docked on the right of the page (see SidePanel), they only list what changes the views selected.

const Meta = styled.span`
  font-size: 12px;
  color: var(--qa-text-muted);
  white-space: nowrap;
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

// How to read the sort order, depending on what we sort by
const order_labels = sort_by => {
  if (sort_by === 'test_input_path') return ['A to Z', 'Z to A'];
  if (sort_by === 'id') return ['Oldest first', 'Newest first'];
  if (sort_by === 'data.storage') return ['Smallest first', 'Largest first'];
  return ['Lowest first', 'Highest first'];
};

const ViewOptionsPanel = ({
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
  // (changes) => {}, e.g. how image viewers compare images
  onUpdateControls = noop,
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
  docs_root = '/',
  // below the page's fixed header
  top = 0,
  // open or collapsed (see useSidePanelExpanded)
  expanded,
  setExpanded,
  // incremented to bring the Files to show into view, e.g. after users choose an option for all runs again from a run's card
  revealFiles = 0,
  // { id }, a new object each time a section should open and come into view, e.g. the output files' options
  revealSection = null,
  // the output files' options, e.g. show_all_files, from the URL
  file_options = no_options,
  onToggleFileOption = () => noop,
}) => {
  const [scroll_to, setScrollTo] = useState(null);

  const [expandedSections, setExpandedSections] = useState({
    visualizations: true,
    dynamic_options: true,
    viewers: true,
    configuration: true,
    files: true,
    sorting: true,
  });

  const [visualizationFilter, setVisualizationFilter] = useState("");
  // what all the runs shown share, hidden in each run (see ConfigurationsTags)
  const shared = useSharedConfiguration();
  const hide_shared = useHideSharedSettings();

  const [prev_reveal_files, setPrevRevealFiles] = useState(revealFiles);
  if (revealFiles !== prev_reveal_files) {
    setPrevRevealFiles(revealFiles);
    setScrollTo({ id: 'dynamic_options' });
    setExpandedSections(prev => ({ ...prev, dynamic_options: true }));
  }

  const [prev_reveal_section, setPrevRevealSection] = useState(revealSection);
  if (revealSection !== prev_reveal_section) {
    setPrevRevealSection(revealSection);
    if (revealSection) {
      setScrollTo({ id: revealSection.id });
      setExpandedSections(prev => ({ ...prev, [revealSection.id]: true }));
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
  const shows_cards = (selected_views.includes('output-list') || selected_views.includes('bit-accuracy')) && nb_runs !== 0;
  // only the visualizations view shows visualizations, and uses their options
  const shows_visualizations = selected_views.includes('output-list') && nb_runs !== 0;
  // the output files view lists files
  const shows_files = selected_views.includes('bit-accuracy') && nb_runs !== 0;
  const file_options_on = file_options_summary(file_options);
  const has_images = visualizations.some(v => is_image(v));
  // `diff` is how URLs said "difference" before there were comparison modes
  const image_mode = controls.image_mode ?? (controls.diff ? 'difference' : DEFAULT_MODE);
  const image_mode_label = MODES.find(m => m.value === image_mode)?.label ?? image_mode;
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
    ...(has_images ? [<OptionHeader key="image_mode" style={{ marginBottom: 8 }}>
      <Explained label="Compare images" explanation="How the image viewers show the new and reference images: side by side, with a wipe, one at a time (single), or their difference. You can also pick it above any image, or with the keys 1 to 4." />
      <div className="option-actions">
        <HTMLSelect
          value={image_mode}
          onChange={event => onUpdateControls({ image_mode: event.target.value, diff: undefined })}
          aria-label="Compare images"
          options={MODES.map(({ value, label }) => ({ value, label }))}
        />
      </div>
    </OptionHeader>] : []),
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

  // what each option is set to, for the rail's summary
  const option_infos = [];
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
    option_infos.push({ label, isSync, picked, selectedValue, default_label: has_choice ? default_label : undefined });
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

  // What differs from the project's defaults, whatever the view: counted in the header, a dot on the rail's icons
  const sort_label = key => ({ test_input_path: 'Name', id: 'Run id', 'data.storage': 'Storage' })[key] ?? available_metrics[key]?.label ?? key;
  const order_label = (Number(sort_order) === 1 ? ascending_label : descending_label).toLowerCase();
  const sort_changed = (sort_by !== undefined && sort_by !== (default_sort_by ?? 'test_input_path')) || Number(sort_order) !== -1;
  const changes = {
    visualizations: visualizations
      .filter(view => isVisualizationEnabled(view) === !!view.default_hidden)
      .map(view => `${view.label || view.name || view.path} ${isVisualizationEnabled(view) ? 'shown' : 'hidden'}`),
    dynamic_options: [
      ...Object.entries(controls.dynamic_options ?? {})
        .map(([name, value]) => [name, [].concat(value ?? [])[0]])
        .filter(([name, value]) => value !== undefined && controls.dynamic_options_sync?.[name] !== false)
        .map(([name, value]) => `${optionLabel(name)}: ${value}`),
      ...Object.entries(controls.dynamic_options_sync ?? {})
        .filter(([, sync]) => sync === false)
        .map(([name]) => `${optionLabel(name)}: chosen per run`),
    ],
    viewers: [
      ...(has_images && image_mode !== DEFAULT_MODE ? [`Images: ${image_mode_label.toLowerCase()}`] : []),
      ...controls_extra
        .filter(control => !!controls[control.name] !== !!control.default)
        .map(control => `${control.label || humanize(control.name)} ${controls[control.name] ? 'on' : 'off'}`),
    ],
    configuration: shared?.collapse && !hide_shared ? ['Shared settings shown in each run'] : [],
    files: file_options_on.map(option => `Output files: ${option}`),
    sorting: sort_changed ? [`Sorted by ${sort_label(sort_value)}, ${order_label}`] : [],
  };

  const viewers_on = controls_extra.filter(control => !!controls[control.name]).map(control => control.label || humanize(control.name));
  const viewers_summary = [
    ...(has_images ? [`Images ${image_mode_label.toLowerCase()}`] : []),
    ...(viewers_on.length > 0 ? [`${viewers_on.join(', ')} on`] : controls_extra.length > 0 ? ['others off'] : []),
  ].join(', ');
  const sections = [
    shows_visualizations && {
      id: 'visualizations',
      title: 'Visualizations',
      icon: 'media',
      summary: `${nb_shown} of ${visualizations_in_runs.length} shown`,
      meta: visualizations.length > 0 && <Meta>{nb_shown} of {visualizations_in_runs.length} shown</Meta>,
      content: <>
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
      </>,
    },
    shows_visualizations && option_rows.length > 0 && {
      id: 'dynamic_options',
      title: 'Files to show',
      icon: 'document',
      summary_has_changes: true,
      summary: option_infos.map(({ label, isSync, picked, selectedValue, default_label }) =>
        `${label} ${!isSync ? 'per run' : picked ? selectedValue : (default_label ?? selectedValue).toLowerCase()}`).join(', '),
      meta: <PopoverNext content={dynamic_options_help} interactionKind="hover" placement="left" hoverOpenDelay={200}>
        <Button icon="help" variant="minimal" size="small" aria-label="What are the files to show?" />
      </PopoverNext>,
      content: option_rows,
    },
    shows_cards && viewer_switches.length > 0 && {
      id: 'viewers',
      title: 'Viewers',
      icon: 'eye-open',
      summary: viewers_summary,
      content: viewer_switches,
    },
    shows_files && {
      id: 'files',
      title: 'Output files',
      icon: 'folder-close',
      summary: file_options_on.length > 0 ? file_options_on.join(', ') : 'Changed files only',
      content: <FileOptionSwitches options={file_options} toggle={onToggleFileOption} />,
    },
    shared?.tokens.length > 0 && {
      id: 'configuration',
      title: 'Configuration',
      icon: 'properties',
      summary: `${shared.tokens.length} settings shared by all ${shared.runs} runs${shared.collapse ? (hide_shared ? ', hidden in each run' : ', shown in each run') : ''}`,
      meta: <Meta>{shared.tokens.length} shared</Meta>,
      content: <>
        <Hint>Shared by all {shared.runs} runs shown{shared.collapse && hide_shared ? ': each run shows only what\'s specific to it' : ''}.</Hint>
        <div style={{ maxHeight: 180, overflowY: 'auto', marginBottom: 8 }}>
          <SharedSettings tokens={shared.tokens} />
        </div>
        {shared.collapse && <HideSharedSwitch />}
      </>,
    },
    {
      id: 'sorting',
      title: 'Sort runs',
      icon: 'sort',
      summary_has_changes: true,
      summary: sorting_applies ? `${sort_label(sort_value)}, ${order_label}` : 'Not used by the summary',
      content: <>
        {!sorting_applies && <Hint>Applies to the tables and the run cards, not to the summary.</Hint>}
        <div style={{ display: 'flex', gap: 6 }}>
          <HTMLSelect
            value={sort_value}
            onChange={onUpdate('sort_by')}
            aria-label="Sort runs by"
            fill
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
            style={{ minWidth: 118 }}
          >
            <option value={-1}>{descending_label}</option>
            <option value={1}>{ascending_label}</option>
          </HTMLSelect>
        </div>
      </>,
    },
  ].filter(Boolean).map(section => ({ ...section, changes: changes[section.id], isOpen: expandedSections[section.id] }));

  return <SidePanel
    title="View options"
    shortcut="o"
    top={top}
    expanded={expanded}
    setExpanded={setExpanded}
    sections={sections}
    onToggleSection={toggleSection}
    onOpenSection={id => setExpandedSections(prev => ({ ...prev, [id]: true }))}
    changes={Object.values(changes).flat()}
    reset={has_changes ? {
      onClick: onResetControls,
      tooltip: "Back to the project's defaults: visualizations, files to show, viewers and output files. The sorting stays.",
    } : undefined}
    scrollTo={scroll_to}
  >
    {nb_runs === 0 && <Hint style={{ padding: '12px 16px 0', margin: 0 }}>No runs yet</Hint>}
  </SidePanel>;
};

export default ViewOptionsPanel;
