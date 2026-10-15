import { useMemo, useRef, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";

import { http, errorMessage } from "../../api/http";
import { useUser, useRefreshCommit, updateSelected, useSiteConfig } from "../../hooks";
import { usePrefsStore, useTuningForm } from "../../stores/prefs";

import MonacoEditor from "../MonacoEditor";

import {
  Alert,
  Classes,
  Callout,
  Intent,
  Button,
  ButtonGroup,
  FormGroup,
  HTMLSelect,
  InputGroup,
  Radio,
  RadioGroup,
  Switch,
  Tag,
  Tooltip,
  PopoverNext,
  Spinner,
  Tab,
  Tabs,
  TabsExpander,
} from "@blueprintjs/core";
import { toaster } from "../../toaster"


import templates from './templates'
import { BatchDefinitions, BatchWarnings } from './BatchReport'


const MAX_RUNS = 5000;

// A button that looks like the links around it
const link_button_style = { background: 'none', border: 0, padding: 0, font: 'inherit', color: 'var(--qa-link)', cursor: 'pointer' };

// In qaboard.yaml's tuning.branches, {subproject} is the project's folder in the repository, {subproject.name} its last part
const expand_subproject = (pattern, subproject) => String(pattern)
  .replaceAll('{subproject.name}', subproject.split('/').pop())
  .replaceAll('{subproject}', subproject);

// Whether a branch matches one of the globs of qaboard.yaml's tuning.branches, e.g. ["develop", "*/*{subproject.name}*"].
// "*" matches any characters, "/" included, and "?" one character.
export const branch_matches = (branch, patterns, subproject = '') => patterns.some(pattern => {
  const escape = text => text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = expand_subproject(pattern, subproject).split('*').map(part => part.split('?').map(escape).join('.')).join('.*');
  return new RegExp(`^${regex}$`).test(branch);
});

const editor_options = {
  selectOnLineNumbers: true,
  seedSearchStringFromSelection: true,
};

const transformCDERegisters = (text) => {
  // Transform CDE register format to QA-Board format
  // Remove sim|, hal|, def| prefixes and replace =X with : [X]
  // block.a=1000
  // # => "block.a": [1000],
  // block.hal|b="sdfggf"
  // # => "block.b": ["sdfggf"],
  // block.def|a=5
  // # => "block.a": [5]
  // CMixer_Gains_0.hal|channels_gain=[0 0 0 0 0 0 0 0 ]
  // #=> [[[0, 0, 0, 0, 0, 0, 0, 0, ]]]
  // CMixer_Gains_0.hal|channels_gain=[1 2 3 4
  //                               0 0 0 0 ]
  // #=> [ [[1, 2, 3, 4], [0, 0, 0, 0]] ]
  const lines = text.split('\n');
  const transformedLines = [];
  let i = 0;
  
  while (i < lines.length) {
    const line = lines[i];
    
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('//') || line.trim().startsWith('#')) {
      transformedLines.push(line);
      i++;
      continue;
    }
    
    // Transform lines with CDE format (with or without sim|/hal|/def| prefixes)
    if (line.includes('=')) {
      let transformedLine = line.replace(/\.(sim|hal|def)\|/g, '.'); // Remove .sim|, .hal|, .def|
      
      const equalIndex = transformedLine.indexOf('=');
      if (equalIndex > -1) {
        const key = transformedLine.substring(0, equalIndex).trim();
        let value = transformedLine.substring(equalIndex + 1).trim();
        
        // Check if this is an array/matrix (single-line or multiline)
        if (value.startsWith('[')) {
          // Handle single-line arrays like [18 22 32 46 67 97 99]
          if (value.trim().endsWith(']')) {
            const matrixValue = parseMatrixToJSON(value);
            
            // Determine if this is the last CDE entry
            const remainingLines = lines.slice(i + 1);
            const isLastEntry = remainingLines.every(l => !l.trim() || l.trim().startsWith('//') || l.trim().startsWith('#') || 
              !l.includes('='));
            const comma = isLastEntry ? '' : ',';
            
            transformedLines.push(`"${key}": [${matrixValue}]${comma}`);
            i++;
            continue;
          }
          
          // Handle multiline matrices (starts with [ but doesn't end with ])
          if (!value.trim().endsWith(']')) {
            // Collect all lines until we find the closing bracket
            let matrixLines = [value];
            let j = i + 1;
            let foundClosing = false;
            
            while (j < lines.length && !foundClosing) {
              const nextLine = lines[j].trim();
              matrixLines.push(nextLine);
              if (nextLine.endsWith(']')) {
                foundClosing = true;
              }
              j++;
            }
            
            if (foundClosing) {
              // Parse the matrix content - preserve newlines for proper row separation
              const matrixContent = matrixLines.join('\n').trim();
              // Convert matrix format: [0 0 0 0\n0 0 0 0] -> [[0,0,0,0],[0,0,0,0]]
              const matrixValue = parseMatrixToJSON(matrixContent);
              
              // Determine if this is the last CDE entry
              const remainingLines = lines.slice(j);
              const isLastEntry = remainingLines.every(l => !l.trim() || l.trim().startsWith('//') || l.trim().startsWith('#') || 
                !l.includes('='));
              const comma = isLastEntry ? '' : ',';
              
              transformedLines.push(`"${key}": [${matrixValue}]${comma}`);
              i = j; // Skip the processed matrix lines
              continue;
            }
          }
        }
        
        // Handle regular single-line values
        const quotedKey = `"${key}"`;
        let formattedValue;
        
        if (value.startsWith('"') && value.endsWith('"')) {
          formattedValue = `[${value}]`;
        } else if (!isNaN(value) && !isNaN(parseFloat(value))) {
          formattedValue = `[${value}]`;
        } else {
          formattedValue = `["${value}"]`;
        }
        
        // Check if this is the last CDE entry
        const remainingLines = lines.slice(i + 1);
        const isLastEntry = remainingLines.every(l => !l.trim() || l.trim().startsWith('//') || l.trim().startsWith('#') || 
          !l.includes('='));
        const comma = isLastEntry ? '' : ',';
        
        transformedLines.push(`${quotedKey}: ${formattedValue}${comma}`);
      } else {
        transformedLines.push(line);
      }
    } else {
      transformedLines.push(line);
    }
    i++;
  }
  
  return transformedLines.join('\n');
};

const parseMatrixToJSON = (matrixStr) => {
  // Remove outer brackets and split by lines/rows
  const content = matrixStr.substring(1, matrixStr.length - 1).trim();
  const rows = content.split(/\s*\n\s*/).map(row => row.trim()).filter(row => row.length > 0);
  
  if (rows.length === 1) {
    // Single row - return as 2D array with one row for consistency
    const values = rows[0].split(/\s+/).map(val => {
      const num = parseFloat(val);
      return isNaN(num) ? `"${val}"` : num;
    });
    return `[[${values.join(', ')}]]`;
  } else {
    // Multiple rows - return as 2D array
    const jsonRows = rows.map(row => {
      // Split by whitespace and convert to numbers
      const values = row.split(/\s+/).map(val => {
        const num = parseFloat(val);
        return isNaN(num) ? `"${val}"` : num;
      });
      return `[${values.join(', ')}]`;
    });
    
    return `[${jsonRows.join(', ')}]`;
  }
};

const calculateActualRange = (originalRange, insertedText) => {
  // Calculate the actual range occupied by the inserted text
  const lines = insertedText.split('\n');
  const numNewlines = lines.length - 1;
  
  if (numNewlines === 0) {
    // Single line: extend column by text length
    return {
      startLineNumber: originalRange.startLineNumber,
      startColumn: originalRange.startColumn,
      endLineNumber: originalRange.endLineNumber,
      endColumn: originalRange.startColumn + insertedText.length
    };
  } else {
    // Multi-line: calculate end position based on last line
    const lastLine = lines[lines.length - 1];
    return {
      startLineNumber: originalRange.startLineNumber,
      startColumn: originalRange.startColumn,
      endLineNumber: originalRange.startLineNumber + numNewlines,
      endColumn: lastLine.length + 1
    };
  }
};


const wrap_in_array = x => Array.isArray(x) ? x : [x];

const wrap_values_in_array = object => Object.fromEntries(
  Object.entries(object).map(([key, value]) => [key, wrap_in_array(value)])
);

const eval_function = text => {
  try {
    return Function(text)();
  } catch {
    return null;
  }
};

// Parses a string describing a tuning set into an object.
export const eval_combinations = param_search_text => {
  if (param_search_text === '') return {combinations: {}, language: 'javascript'};

  let combinations = null;
  let language;
  // users can directly provide tuning sets via objects or arrays of objects
  try {
    combinations = JSON.parse(param_search_text);
    language = "yaml" // no json support out of the box, yaml is superset so..
  } catch {
    // or they can provide a function that returns a tuning set
    combinations = eval_function(param_search_text);
    language = "javascript"
  }
  if (Array.isArray(combinations))
    combinations = combinations.map(wrap_values_in_array);
  else
    combinations = wrap_values_in_array(combinations);
  return { combinations, language }
};

const grid_combinations = param_search => {
  if (param_search === null || param_search === undefined) return null;
  if (Array.isArray(param_search))
    return param_search
      .map(search_set => grid_combinations(search_set))
      .reduce((a, v) => a + v, 0);
  return Object.values(param_search)
    .map(param_array => param_array.length)
    .reduce((a, v) => a * v, 1);
};


export const combinations_info = (parameter_search, search_options, search_type) => {
  try {
    const { combinations: tuning_sets, language } = eval_combinations(parameter_search);
    const combinations = grid_combinations(tuning_sets);
    if (combinations === null)
      return { combinations: "invalid", language };
    return {
      combinations: (search_options.n_iter < 0 || search_type === 'grid') ? combinations : Math.min(search_options.n_iter, combinations),
      language,
    };
  } catch {
    return { combinations: "invalid", language: 'javascript' };
  }
}


const default_search_options = { n_iter: 50 };
const no_tests = { tests: [] };

// What tests a batch (a "group") would run
const useGroupInfo = ({ project, selected_group, commit_id, available_tests_files }) => {
  const query = useQuery({
    queryKey: ['tests-group', project, selected_group, commit_id ?? null, available_tests_files],
    queryFn: async ({ signal }) => {
      const params = { project, name: selected_group, commit: commit_id };
      return (await http.post('/api/v1/tests/group', { groups: Object.values(available_tests_files ?? {}) }, { params, signal })).data;
    },
    enabled: !!selected_group,
    placeholderData: keepPreviousData,
    staleTime: 60 * 1000,
  });
  if (!selected_group)
    return { group_info: no_tests, loading: false, error: null };
  return {
    group_info: query.error ? no_tests : (query.data ?? no_tests),
    loading: query.isFetching,
    error: query.error ? errorMessage(query.error) : (query.data?.error ?? null),
  };
};


// Starts tuning experiments. What users enter is remembered per project.
const TuningForm = ({ project, git, config, metrics, commit, available_tests_files }) => {
  const logged_user = useUser();
  const { docs_root, support_url } = useSiteConfig();
  const form = useTuningForm(project);
  const updateTuning = usePrefsStore(state => state.updateTuning);
  const refresh = useRefreshCommit();
  const [submitted, setSubmitted] = useState(false);
  const [confirm_reset, setConfirmReset] = useState(false);
  // Required fields only turn red once users left them empty, not on a pristine form
  const [touched, setTouched] = useState({});
  const touch = name => () => setTouched(touched => touched[name] ? touched : { ...touched, [name]: true });
  const is_missing = (name, value) => !!touched[name] && !value;
  const is_transforming = useRef(false);

  const default_parameter_search_auto = useMemo(() => templates['optimize'](config, metrics), [config, metrics]);
  const default_user = (config.runners || config).lsf?.user;
  const {
    experiment_name = "",
    platform = "linux",
    overwrite = true,
    selected_group = "",
    search_type = "grid",
    parameter_search = templates["no tuning"],
    search_options = default_search_options,
    parameter_search_auto = default_parameter_search_auto,
  } = form;
  const user = logged_user.user_name || form.user || default_user;

  const { combinations, language } = useMemo(
    () => combinations_info(parameter_search, search_options, search_type),
    [parameter_search, search_options, search_type],
  );
  const { group_info: selected_group_info, loading: selected_group_info_loading, error } = useGroupInfo({
    project, selected_group, commit_id: commit?.id, available_tests_files,
  });

  const update = name => e => updateTuning(project, { [name]: e?.target ? e.target.value : e });
  // for some reason, trailing spaces are removed when making the request.
  const updateSelectedGroup = e => updateTuning(project, { selected_group: e.target.value.replace(/ *$/, "") });
  const updateExperimentName = e => updateTuning(project, { experiment_name: e.target.value.replace(/[^\w_.@:=]/g, "-") });
  const updateOverwrite = e => updateTuning(project, { overwrite: e.target.checked });
  const updateParameterSearch = new_parameter_search => updateTuning(project, { parameter_search: new_parameter_search });
  const updateParameterSearchAuto = new_parameter_search => updateTuning(project, { parameter_search_auto: new_parameter_search });
  const updateSearchTab = new_tab => updateTuning(project, { search_type: new_tab === "search-manual" ? "grid" : "optimize" });
  const updateIterations = e => updateTuning(project, { search_options: { n_iter: parseFloat(e.target.value) } });

  // Users paste register values in the CDE format, we convert them to QA-Board's format
  const onEditorDidMount = editor => {
    editor.onDidChangeModelContent(e => {
      // Avoid infinite loops from our own transformations
      if (is_transforming.current) return;
      const change = e.changes[0];
      if (!change) return;
      const addedText = change.text;
      // Check if the added text looks like CDE register format and is significant enough to be a paste
      if (addedText.length <= 5 || !addedText.includes('=')) return;
      const transformedText = transformCDERegisters(addedText);
      if (transformedText === addedText) return;
      is_transforming.current = true;
      // Replace the pasted content with the transformed version
      editor.executeEdits('paste-transform', [{
        range: calculateActualRange(change.range, addedText),
        text: transformedText,
      }]);
      setTimeout(() => { is_transforming.current = false; }, 100);
    });
  };

  const onSubmit = () => {
    setSubmitted(true);
    // the same toast says when the experiment started, or why it didn't
    const toast_key = `tuning-${experiment_name}`
    toaster.show({ message: `Starting ${experiment_name}…`, icon: 'time' }, toast_key);
    http.post(`/api/v1/commit/${commit.id}/batch`, {
      project,
      batch_label: experiment_name,
      platform,
      configuration: 'xxxxxxxxx',
      tuning_search: {
        search_type,
        search_options: search_type!=='grid' ? search_options : {},
        parameter_search: search_type==='optimize' ? parameter_search_auto : eval_combinations(parameter_search).combinations,
      },
      selected_group,
      groups: Object.values(available_tests_files),
      user,
      overwrite,
    }, { params: { project } })
      .then(() => {
        setSubmitted(false);
        toaster.show({
          message: `Started ${experiment_name}`,
          intent: Intent.SUCCESS,
          action: { text: 'Show its logs', onClick: () => updateSelected({ selected_batch_new: experiment_name, selected_views: 'logs' }) },
        }, toast_key);
        setTimeout(() => refresh(project, commit.id),  1*1000)
        setTimeout(() => refresh(project, commit.id),  5*1000)
        setTimeout(() => refresh(project, commit.id), 10*1000)
      })
      .catch(error => {
        setSubmitted(false);
        // The batch's page tells users why, and shows the logs
        const submission = error.response?.data?.submission
        toaster.show({
          message: submission
            ? `${experiment_name} failed to start. Its logs say why.`
            : `Could not start ${experiment_name}: ${errorMessage(error)}`,
          intent: Intent.DANGER,
          timeout: 10000,
          action: submission ? { text: 'Show its logs', onClick: () => updateSelected({ selected_batch_new: experiment_name, selected_views: 'logs' }) } : undefined,
        }, toast_key);
        refresh(project, commit.id);
      });
  };

  const { tests, warnings, definitions } = selected_group_info;
  const total_runs = combinations * tests.length;
  // no runs yet (e.g. no batch chosen) is not an error
  const time_intent =
    (combinations === "invalid" || total_runs > MAX_RUNS)
      ? Intent.DANGER
      : total_runs === 0 ? Intent.NONE
      : total_runs < 100
        ? Intent.PRIMARY
        : Intent.WARNING;


  // we should show different parameters for different runners: queues, user...
  const lsf_runner = (config.runners?.lsf !== undefined || config.lsf !== undefined);
  const any_runner_configured = !!config.lsf || Object.keys(config.runners || {}).filter(t => t !== 'local' && t !== 'default').length > 0;

  const panel_manual = <>
    <FormGroup label="Start from an example" style={{marginBottom: '15px'}}>
      <ButtonGroup variant="outlined" size="small" style={{flexWrap: 'wrap', gap: '4px'}}>
        {["no tuning", "simple-combinations", "list-of-combinations", "1x2 matrix", "function"].map(x => (
          <Button
            key={x}
            onClick={() => updateParameterSearch(templates[x])}
          >
            {x}
          </Button>
        ))}
      </ButtonGroup>
    </FormGroup>
    <FormGroup
      inline
      labelFor="select-search-type"
      helperText={
        !parameter_search ? '' : (
        search_type === "optimize" ? '' :
          search_type === "grid"
          ? `Explores ${combinations} combination${combinations > 1 ? "s" : ""}`
          : `Uniform sampling of ${combinations} combinations`
        )
      }
    >
      <HTMLSelect
        id="select-search-type"
        value={search_type}
        onChange={update('search_type')}
        minimal
      >
        <option key="grid" value="grid">All combinations</option>
        <option key="sampler" value="sampler">Sampling</option>
      </HTMLSelect>
      {(search_type === "sampler") && (
        <input
          id="input-iterations"
          value={search_options.n_iter}
          className={Classes.INPUT}
          style={{ marginLeft: "30px", width: "70px" }}
          placeholder="50"
          aria-label="Number of samples"
          onChange={updateIterations}
          type="number"
          min={1}
          dir="auto"
        />
      )}
    </FormGroup>
    <MonacoEditor
      height={250}
      language={language || 'json'}
      value={parameter_search || ''}
      options={editor_options}
      name="editor-tuning-set"
      onChange={updateParameterSearch}
      editorDidMount={onEditorDidMount}
    />
    {search_type !== "optimize" && <Callout intent={time_intent} >{total_runs} total runs {total_runs > MAX_RUNS && '(' + MAX_RUNS + ' max.)'} </Callout>}
  </>


  const panel_auto = <>
    <Button
      icon="reset"
      disabled={parameter_search_auto === default_parameter_search_auto}
      onClick={() => setConfirmReset(true)}
    >Reset to the default</Button>
    <Alert
      isOpen={confirm_reset}
      icon="reset"
      intent={Intent.WARNING}
      cancelButtonText="Cancel"
      confirmButtonText="Reset"
      canEscapeKeyCancel
      onCancel={() => setConfirmReset(false)}
      onConfirm={() => {
        setConfirmReset(false);
        updateParameterSearchAuto(default_parameter_search_auto);
      }}
    >
      <p>Replace your auto-tuning configuration with the default one? Your edits will be lost.</p>
    </Alert>
    <MonacoEditor
      height={250}
      language='yaml'
      options={editor_options}
      name="editor-tuning-auto"
      onChange={updateParameterSearchAuto}
      value={parameter_search_auto || ''}
    />
  </>

  const available_platforms = config.inputs?.platforms ?? []
  // qaboard.yaml's tuning.branches: the branches whose commits have artifacts, if the CI doesn't save them for all
  const tuning_branches = config.tuning?.branches
  const subproject = git?.path_with_namespace ? project.slice(git.path_with_namespace.length + 1) : ''
  const cannot_tune_on_branch = !!commit?.branch && Array.isArray(tuning_branches) && !branch_matches(commit.branch, tuning_branches, subproject)
    
  return <>
    {!any_runner_configured && <Callout intent={Intent.WARNING} title="Please configure async runners" icon="warning-sign" style={{marginBottom: '15px'}}>
      <p>The simplest way to <a href={`${docs_root}docs/celery-integration`}>get started with async runners is to use Celery</a>.</p>
      <p>Otherwise, your runs may be killed if they take too long.</p>
    </Callout>}
    {cannot_tune_on_branch &&  <Callout intent={Intent.WARNING} title="Tuning may not work" icon="warning-sign" style={{marginBottom: '15px'}}>
      <p>Tuning needs the commit's artifacts, and the CI only saves them on some branches: {tuning_branches.map((pattern, idx) => <span key={idx}>{idx > 0 && ', '}<code>{expand_subproject(pattern, subproject)}</code></span>)}. Your branch, <code>{commit.branch}</code>, doesn't match.</p>
      <p>A workaround is saving them yourself, from your clone of the repository:</p>
      <pre>
        <div>git checkout {(commit?.id ?? '').slice(0, 8)}</div>
        {subproject && <div>cd {subproject}</div>}
        <div>qa save-artifacts</div>
      </pre>
    </Callout>}
    <FormGroup
      helperText={is_missing('experiment_name', experiment_name) ? "Give the batch a label" : "Tip: reuse the label of an existing batch to add runs to it"}
      label="Batch label"
      labelInfo="(required)"
      labelFor="batch-label"
      intent={is_missing('experiment_name', experiment_name) ? Intent.DANGER : undefined}
   >
      <InputGroup
        id="batch-label"
        style={{ width: "300px" }}
        placeholder="my-tuning-experiment"
        value={experiment_name}
        onChange={updateExperimentName}
        onBlur={touch('experiment_name')}
        intent={is_missing('experiment_name', experiment_name) ? Intent.DANGER : undefined}
        type="text"
        dir="auto"
      />
    </FormGroup>

    <FormGroup
      label="Batch of inputs+configurations"
      labelInfo="(required)"
      intent={is_missing('selected_group', selected_group) ? Intent.DANGER : undefined}
      helperText={<>
        {tests.length > 0 && <PopoverNext
            inheritDarkTheme popoverClassName={Classes.DARK}
            placement="right" hoverCloseDelay={300} interactionKind={"hover"}
            content={<div style={{padding: '10px'}}>
              <ul style={{maxWidth: "1200px", maxHeight: "800px", overflow: "auto"}} >
                {tests.map((t, idx) => <li key={idx} style={{marginBottom: '5px'}}>
                  <span style={{marginRight: '5px'}}>{t.input_path}</span>
                  {t.configurations.map(c =>
                    <Tag key={JSON.stringify(c)} intent={Intent.PRIMARY} round style={{marginRight: '5px', marginBottom: '5px'}}>
                      {typeof(c) === 'string' ? c : JSON.stringify(c)}
                    </Tag>
                  )}
              </li>)}
              </ul>
            </div>}
            >
          <span style={{borderBottom: '1px dotted currentColor', textDecoration: 'none'}}>{tests.length} tests. </span>
        </PopoverNext>}
        <p style={{marginBottom: '5px'}}>
          {is_missing('selected_group', selected_group) && "Choose a batch. "}
          Batches are listed in <button type="button" style={link_button_style} onClick={() => updateSelected({ selected_views: 'groups' })}>Available Tests</button>.
        </p>
        {error && <p><Tag icon='warning-sign' intent={Intent.DANGER}>{error}</Tag></p>}
        {selected_group_info_loading && <span className={Classes.TEXT_MUTED}><Spinner size={12} style={{display: 'inline-flex', marginRight: '5px'}}/>Listing the tests…</span>}
      </>}
      labelFor="selected-group"
    >
      <InputGroup
        id="selected-group"
        style={{ width: "300px" }}
        placeholder="my-batch, batch-*"
        onChange={updateSelectedGroup}
        onBlur={touch('selected_group')}
        intent={is_missing('selected_group', selected_group) ? Intent.DANGER : undefined}
        value={selected_group}
        type="text"
        dir="auto"
      />
    </FormGroup>
    {!!selected_group && !selected_group_info_loading && <>
      <BatchDefinitions definitions={definitions} style={{ marginTop: '-10px' }} />
      <BatchWarnings
        warnings={warnings}
        title={tests.length === 0 ? "Why the batch has no tests" : "Check the batch files"}
        style={{ marginBottom: '15px' }}
      />
    </>}

    {available_platforms.length > 0 &&
    <RadioGroup onChange={update('platform')} selectedValue={platform}>
      {available_platforms.map(p => <Radio
        key={p.name}
        labelElement={<span>{p.label || p.name || 'undefined name/label!'}</span>}
        value={p.name}
        large
      />)}
    </RadioGroup>}


    <Tabs renderActiveTabPanelOnly id="search-type" selectedTabId={search_type !== "optimize" ? "search-manual" : "search-optimize"} onChange={updateSearchTab}  defaultSelectedTabId="search-manual">
      <Tab id="search-manual" title="Manual tuning" panel={panel_manual} />
      <Tab id="search-optimize" title={<>Automated tuning</>} panel={panel_auto} />
      <TabsExpander />
      <a href={`${docs_root}docs/${search_type !== "optimize" ? 'tuning-from-the-webapp' : 'auto-optimization'}`} target="_blank" rel="noopener noreferrer">
        {search_type !== "optimize" ? 'How to tune from QA-Board' : 'How auto-tuning works'}
      </a>
    </Tabs>

    <FormGroup
      helperText={!user ? "Please provide a user in the input below"
                        : experiment_name.length === 0 ? 'Please give the batch a label (the input is above)'
                        : selected_group_info.tests.length === 0 ? "The batch has no tests: see why under its name"
                        : search_type === "optimize" ? undefined
                        : combinations === "invalid" ? "The tuning parameters are not valid JSON, or the function throws"
                        : total_runs > MAX_RUNS ? `Too many runs: ${total_runs} (at most ${MAX_RUNS}). Use “Sampling” or fewer inputs.`
                        : total_runs >= 1000 ? "Over 1000 runs: check the cluster has room"
                        : undefined}
      intent={(combinations === "invalid" || total_runs > MAX_RUNS) && search_type !== "optimize" ? Intent.DANGER : undefined}
    >
    <Button
      onClick={onSubmit}
      disabled={
        submitted ||
        !user ||
        experiment_name.length === 0 ||
        (!total_runs && search_type !== "optimize") ||
        total_runs > MAX_RUNS
      }
      large
      intent={search_type !== "optimize" ? (total_runs < 1000 ? Intent.PRIMARY : Intent.DANGER) : Intent.PRIMARY}
    >
      {search_type === "optimize" ? "Start auto-tuning" : (Number.isFinite(total_runs) && total_runs > 0) ? `Start ${total_runs} run${total_runs === 1 ? '' : 's'}` : "Start runs"}
    </Button>
    </FormGroup>

    <FormGroup
        label="Overwrite previous identical runs"
        labelFor="overwrite-old-outputs"
        helperText="On: runs that already exist in this batch run again. Off: they're kept, only missing runs start."
        inline
    >
      <Switch
        id="overwrite-old-outputs"
        checked={overwrite}
        onChange={updateOverwrite}
      />
    </FormGroup>

    {/* {lsf_runner && <FormGroup
      label="Run as"
      helperText="(required)"
      labelFor="input-user"
      intent={!user ? Intent.DANGER : undefined}
      inline
    >
      <input
        id="input-user"
        className={Classes.INPUT}
        style={{ width: "300px" }}
        value={user}
        placeholder='user'
        onChange={update('user')}
        type="text"
        dir="auto"
      />
    </FormGroup>} */}

    {lsf_runner &&<Tooltip content="Runs start on the cluster as this user, with their shell environment">
      <Tag icon="user" large minimal style={{marginRight: '5px', marginBottom: '5px'}}>Will run as <strong>{user}</strong></Tag>
    </Tooltip>}

    {search_type === "optimize" && <>
      <Callout icon="info-sign" title="About auto-tuning">
        <ul>
        <li>The solver is <a href="https://github.com/scikit-optimize/scikit-optimize">scikit-optimize</a>. There are lots of choices for black-box optimization (nevergrad, RoBo, MOE, Ray, hyperopt, SMAC, BayesOpt, spearmint, dlib...), all with varying features, maturity, algorithms and popularity.</li>
        <li>You need to use <a href={`${docs_root}docs/computing-quantitative-metrics`}>QA-Board metrics</a>.</li>
        </ul>
        <p><strong>Do send <a href={support_url || "mailto:arthur.flam@samsung.com"}>feedback</a>!</strong></p>
      </Callout>
    </>}
  </>;
};


export { TuningForm };
