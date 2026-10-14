import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";

import { http, errorMessage, isArtifactsError } from "../../api/http";
import { requestLogin } from "../authentication/login";
import { useUser, useRefreshCommit, updateSelected, useSiteConfig } from "../../hooks";
import { usePrefsStore, useTuningForm } from "../../stores/prefs";

import MonacoEditor from "../MonacoEditor";

import {
  Classes,
  Callout,
  Intent,
  Button,
  FormGroup,
  HTMLSelect,
  Radio,
  RadioGroup,
  Switch,
  Tag,
  Tooltip,
  Popover,
  Icon,
  Tab,
  Tabs,
} from "@blueprintjs/core";
import { toaster } from "../../toaster"


import templates from './templates'
import { BatchDefinitions, BatchWarnings } from './BatchReport'


const MAX_RUNS = 5000;

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
const useGroupInfo = ({ project, selected_group, commit_id, available_tests_files, is_logged }) => {
  const query = useQuery({
    queryKey: ['tests-group', project, selected_group, commit_id ?? null, available_tests_files],
    queryFn: async ({ signal }) => {
      const params = { project, name: selected_group, commit: commit_id };
      // background: no "Log in" toast, the form already says to log in
      return (await http.post('/api/v1/tests/group', { groups: Object.values(available_tests_files ?? {}) }, { params, signal, background: true })).data;
    },
    // the server needs to know who asks
    enabled: !!selected_group && is_logged,
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


// Waits for users to stop typing
const useDebounced = (value, delay) => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timeout);
  }, [value, delay]);
  return debounced;
};

// Asks the server what would go wrong if we started now (unknown batch, missing artifacts...)
const no_check = { errors: [], warnings: [] };
const useTuningCheck = ({ project, commit_id, request, is_logged }) => {
  const debounced_request = useDebounced(request, 500);
  const query = useQuery({
    queryKey: ['tuning-check', project, commit_id, debounced_request],
    queryFn: async ({ signal }) => (await http.post(`/api/v1/commit/${commit_id}/batch/check`, debounced_request, { params: { project }, signal, background: true })).data,
    enabled: !!commit_id && is_logged,
    placeholderData: keepPreviousData,
  });
  // we don't block users if the check itself fails: the server checks again when they start
  if (query.error) return { errors: [], warnings: [`Could not check the batch settings: ${errorMessage(query.error)}`] };
  return query.data ? { errors: query.data.errors ?? [], warnings: query.data.warnings ?? [] } : no_check;
};


// Starts tuning experiments. What users enter is remembered per project.
const TuningForm = ({ project, config, metrics, commit, available_tests_files }) => {
  const logged_user = useUser();
  const { docs_root } = useSiteConfig();
  const form = useTuningForm(project);
  const updateTuning = usePrefsStore(state => state.updateTuning);
  const refresh = useRefreshCommit();
  const [submitted, setSubmitted] = useState(false);
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
    android_device = "openstf",
  } = form;
  const user = logged_user.user_name || form.user || default_user;

  const { combinations, language } = useMemo(
    () => combinations_info(parameter_search, search_options, search_type),
    [parameter_search, search_options, search_type],
  );
  const is_logged = logged_user.is_logged;
  const { group_info: selected_group_info, loading: selected_group_info_loading, error } = useGroupInfo({
    project, selected_group, commit_id: commit?.id, available_tests_files, is_logged,
  });

  // The batch's settings, as sent to the server
  const request = useMemo(() => {
    let combinations;
    try {
      combinations = search_type === 'optimize' ? parameter_search_auto : eval_combinations(parameter_search).combinations;
    } catch {
      combinations = undefined; // the editor already says it's invalid
    }
    return {
      project,
      batch_label: experiment_name,
      platform,
      configuration: 'xxxxxxxxx',
      tuning_search: {
        search_type,
        search_options: search_type !== 'grid' ? search_options : {},
        parameter_search: combinations,
      },
      selected_group,
      groups: Object.values(available_tests_files ?? {}),
      user,
      android_device,
      overwrite,
    };
  }, [project, experiment_name, platform, search_type, search_options, parameter_search, parameter_search_auto, selected_group, available_tests_files, user, android_device, overwrite]);
  const check = useTuningCheck({ project, commit_id: commit?.id, request, is_logged });
  // the answer to the last submit, until users change something
  const [submit_check, setSubmitCheck] = useState(null);
  const current_check = submit_check?.request === request ? submit_check : check;
  // the inputs already say when the name or the batch are missing
  const check_errors = (experiment_name && selected_group) ? current_check.errors : [];
  const check_warnings = current_check.warnings;

  // TODO: remove at some point, or expose via tuning.runners.lsf.forbidden_users...
  const forbidden_user = form.user === 'ispq';
  useEffect(() => {
    if (!forbidden_user) return;
    updateTuning(project, { user: '' });
    toaster.show({
      message: <span>Sorry, using the <strong>ispq</strong> user for tuning is not allowed anymore!</span>,
      intent: Intent.WARNING,
      timeout: 10000,
    });
  }, [forbidden_user, project, updateTuning]);

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
    toaster.show({
      message: "Sent!",
      intent: Intent.SUCCESS
    });
    http.post(`/api/v1/commit/${commit.id}/batch`, request, { params: { project } })
      .then(({ data }) => {
        setSubmitted(false);
        toaster.show({
          message: "Acknowledged! You can select the batch here ➡️",
          intent: Intent.SUCCESS
        });
        // e.g. only the source files of the artifacts could be restored
        if (data?.warning) toaster.show({message: data.warning, intent: Intent.WARNING, timeout: 15000});
        setTimeout(() => refresh(project, commit.id),  1*1000)
        setTimeout(() => refresh(project, commit.id),  5*1000)
        setTimeout(() => refresh(project, commit.id), 10*1000)
      })
      .catch(error => {
        setSubmitted(false);
        const data = error.response?.data
        if (Array.isArray(data?.errors)) setSubmitCheck({ request, errors: data.errors, warnings: data.warnings ?? [] });
        // The batch's page tells users why, and shows the logs
        toaster.show({
          message: data?.submission
            ? "The batch failed to start. Select it to see why, and its logs."
            : isArtifactsError(error) ? errorMessage(error) : `The batch did not start: ${errorMessage(error)}`,
          intent: isArtifactsError(error) ? Intent.WARNING : Intent.DANGER,
          timeout: 15000,
        });
        refresh(project, commit.id);
      });
  };

  const { tests, warnings, definitions } = selected_group_info;
  const total_runs = combinations * tests.length;
  const time_intent =
    (combinations === "invalid" || total_runs===0 || total_runs > MAX_RUNS)
      ? Intent.DANGER
      : total_runs < 100
        ? Intent.PRIMARY
        : Intent.WARNING;


  // we should show different parameters for different runners: queues, user...
  const lsf_runner = (config.runners?.lsf !== undefined || config.lsf !== undefined);
  const any_runner_configured = !!config.lsf || Object.keys(config.runners || {}).filter(t => t !== 'local' && t !== 'default').length > 0;

  const panel_manual = <>
    <Callout title="Click to see examples of parameter tuning" icon="info-sign" style={{marginBottom: '15px'}}>
      <p>
      {["no tuning", "simple-combinations", "list-of-combinations", "1x2 matrix", "function"].map(x => (
        <Button
          style={{margin: '4px'}}
          key={x}
          onClick={() => updateParameterSearch(templates[x])}
        >
          {x}
        </Button>
      ))}
    </p>
    </Callout>
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
          onChange={updateIterations}
          type="numeric"
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
    <Button onClick={() => updateParameterSearchAuto(default_parameter_search_auto)}>Reset</Button>
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
  const cannot_tune_on_branch = project.startsWith('CDE-Users/HW_ALG') && !((commit?.branch ?? '').split('/')?.[1]  ?? '').includes(project.split('/').slice(-1)) && commit?.branch !== "develop"
    
  return <>
    {!any_runner_configured && <Callout intent={Intent.WARNING} title="Please configure async runners" icon="warning-sign" style={{marginBottom: '15px'}}>
      <p>The simplest way to <a href={`${docs_root}docs/celery-integration`}>get started with async runners is to use Celery</a>.</p>
      <p>Otherwise, your runs may be killed if they take too long.</p>
    </Callout>}
    {check_warnings.length > 0 && <Callout intent={Intent.WARNING} title="Before you start" icon="warning-sign" style={{marginBottom: '15px'}} data-testid="tuning-check-warnings">
      <ul className={Classes.LIST}>{check_warnings.map(w => <li key={w}>{w}</li>)}</ul>
    </Callout>}
    {cannot_tune_on_branch &&  <Callout intent={Intent.WARNING} title="Tuning may not work" icon="warning-sign" style={{marginBottom: '15px'}}>
      <p>For tuning to work, your branch name (<code>{commit?.branch}</code>) must match the project (<code>{project}</code>).</p>
      <p>A workaround is calling from Windows/Linux:</p>
      <pre>
        <div>cd HW_ALG</div>
        <div>git checkout {(commit?.id ?? '').slice(0, 8)}</div>
        <div>cd {project.replace('CDE-Users/HW_ALG/', '')}</div>
        <div>qa save-artifacts</div>
      </pre>
    </Callout>}
    <FormGroup
      helperText={!experiment_name ? "(required)" : "Tip: You can add runs to an existing experiment"}
      label={`Experiment name:`}
      labelFor="batch-label"
      intent={!experiment_name ? Intent.DANGER : Intent.PRIMARY}
   >
      <input
        id="batch-label"
        className={Classes.INPUT}
        style={{ width: "300px" }}
        placeholder="my-tuning-experiment"
        value={experiment_name}
        onChange={updateExperimentName}
        type="text"
        dir="auto"
      />
    </FormGroup>

    <FormGroup
      label="Batch of inputs+configurations:"
      intent={!selected_group ? Intent.DANGER : Intent.PRIMARY}
      helperText={<>
        {tests.length > 0 && <Popover
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
          <span style={{borderBottom: '1px dotted #000', textDecoration: 'none'}}>{tests.length} tests. </span>
        </Popover>}
        <p style={{marginBottom: '5px'}}>
          To know what batches you can use, go to the tab <Tag icon="layout-group-by" interactive minimal round onClick={() => updateSelected({ selected_views: 'groups' })}>Available Tests</Tag>.
          </p>
        {error && <p><Tag icon='warning-sign' intent={Intent.DANGER}>{error}</Tag></p>}
        {selected_group_info_loading && <Icon icon="time"/>}
      </>}
      labelFor="selected-group"
    >
      <input
        id="selected-group"
        className={Classes.INPUT}
        intent={Intent.PRIMARY}
        style={{ width: "300px" }}
        placeholder="my-batch, batch-*"
        onChange={updateSelectedGroup}
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

    {(project!=='dvs/psp_swip' && project!=='tof/swip_tof' && available_platforms.length > 0) &&
    <RadioGroup onChange={update('platform')} selectedValue={platform}>
      {available_platforms.map(p => <Radio
        key={p.name}
        labelElement={<span>{p.label || p.name || 'undefined name/label!'}</span>}
        value={p.name}
        large
      />)}
    </RadioGroup>}

    {((project==='dvs/psp_swip' || project==='tof/swip_tof' )&& available_platforms.length === 0) &&
    <RadioGroup onChange={update('platform')} selectedValue={platform}>
      <Radio labelElement={<span>Linux</span>} value="lsf" large />
      <Radio label={<span>Android</span>} value="s8" large/>
    </RadioGroup>}

    {platform.startsWith("s8") && (
      <FormGroup
        label="Android device"
        helperText="Choose a device from the openstf farm, or your own (host:port)"
        labelFor="input-android-device"
      >
        <input
          id="input-android-device"
          className={Classes.INPUT}
          style={{ width: "300px" }}
          value={android_device}
          placeholder="openstf"
          onChange={update('android_device')}
          type="text"
          dir="auto"
        />
      </FormGroup>
    )}


    <Tabs renderActiveTabPanelOnly id="search-type" selectedTabId={search_type !== "optimize" ? "search-manual" : "search-optimize"} onChange={updateSearchTab}  defaultSelectedTabId="search-manual">
      <Tab id="search-manual" title="Manual tuning" panel={panel_manual} />
      <Tab id="search-optimize" title={<>Automated tuning</>} panel={panel_auto} />
    </Tabs>

    <FormGroup
      helperText={!user ? "Please provide a user in the input below"
                        : (experiment_name.length === 0 ? 'Please give a name to the tuning experiment (the input is above)' : (selected_group_info.tests.length === 0 ? "The batch has no tests: see why under its name" : undefined))}
      intent={(!user || experiment_name.length === 0 || !total_runs) ? Intent.DANGER : undefined}
    >
    {!is_logged && <Callout intent={Intent.PRIMARY} icon="log-in" title="Log in to start runs" style={{marginBottom: '10px'}} data-testid="tuning-login">
      <p>Runs started from QA-Board run as you. Once you are logged in, QA-Board also lists the batch's tests and checks your settings.</p>
      <Button icon="log-in" intent={Intent.PRIMARY} text="Log in" onClick={requestLogin}/>
    </Callout>}
    {check_errors.length > 0 && <Callout intent={Intent.DANGER} title="Fix this to start" icon="error" style={{marginBottom: '10px'}} data-testid="tuning-check-errors">
      <ul className={Classes.LIST}>{check_errors.map(e => <li key={e}>{e}</li>)}</ul>
    </Callout>}
    <Button
      onClick={onSubmit}
      disabled={
        submitted ||
        !is_logged ||
        check_errors.length > 0 ||
        !user ||
        experiment_name.length === 0 ||
        (!total_runs && search_type !== "optimize") ||
        total_runs > MAX_RUNS
      }
      large
      intent={search_type !== "optimize" ? (total_runs < 1000 ? Intent.PRIMARY : Intent.DANGER) : Intent.PRIMARY}
    >
      Send
    </Button>
    </FormGroup>

    <FormGroup
        label="Overwrite previous identical runs"
        labelFor="overwrite-old-outputs"
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

    {lsf_runner && is_logged && <Tooltip content="Make sure to setup your shell environment correctly">
      <Tag icon="user" large minimal style={{marginRight: '5px', marginBottom: '5px'}}>Will run as <strong>{user}</strong></Tag>
    </Tooltip>}

    {search_type === "optimize" && <>
      <Callout icon="info-sign" title="About auto-tuning">
        <ul>
        <li>The solver is <a href="https://github.com/scikit-optimize/scikit-optimize">scikit-optimize</a>. There are lots of choices for black-box optimization (nevergrad, RoBo, MOE, Ray, hyperopt, SMAC, BayesOpt, spearmint, dlib...), all with varying features, maturity, algorithms and popularity.</li>
        <li>You need to use <a href={`${docs_root}docs/computing-quantitative-metrics`}>QA-Board metrics</a>.</li>
        </ul>
        <p><strong>Do send <a href="mailto:arthur.flam@samsung.com">feedback</a>!</strong></p>
      </Callout>
    </>}
  </>;
};


export { TuningForm };
