// A form to configure automated tuning without writing YAML by hand.
//
// The YAML text stays the single source of truth -- it is what gets submitted and what
// `qa optimize` reads -- so this form is a *view* on it: edits are parsed from the text
// and serialized right back. The YAML editor below the form shows every change live,
// which also teaches the syntax. Comments are rewritten away on the first form edit;
// anyone who cares about comments can keep editing the YAML directly.
import React from "react";

import {
  Button,
  Callout,
  Classes,
  ControlGroup,
  FormGroup,
  HTMLSelect,
  InputGroup,
  Intent,
  NumericInput,
  Switch,
  Tag,
  TagInput,
} from "@blueprintjs/core";

import { load as yamlLoad } from 'js-yaml';
import {
  DIMENSION_KINDS,
  SAMPLERS,
  addDimension,
  changeDimensionKind,
  objectiveMetrics,
  parseOptimizeConfig,
  removeDimension,
  serializeOptimizeConfig,
  updateDimension,
  validateOptimizeConfig,
} from './optimize_config';


// "0.1" -> 0.1, "1e-7" -> 1e-7, "banana" kept as-is so the validator can complain
const asScalar = text => {
  try {
    const value = yamlLoad(text);
    return value === null ? '' : value;
  } catch (e) {
    return text;
  }
};

const NumberInput = ({ value, placeholder, onChange }) =>
  <InputGroup
    size={10}
    placeholder={placeholder}
    value={value === undefined ? '' : String(value)}
    onChange={e => onChange(asScalar(e.target.value))}
  />;


const DimensionRow = ({ dimension, onChange, onChangeKind, onRemove }) => {
  const kind = Object.keys(dimension)[0];
  const options = dimension[kind];
  const set = update => onChange(kind, { ...options, ...update });
  return <ControlGroup style={{marginBottom: '5px'}}>
    <HTMLSelect value={kind} options={DIMENSION_KINDS} onChange={e => onChangeKind(e.target.value)} />
    <InputGroup placeholder="parameter name" value={options.name || ''} onChange={e => set({ name: e.target.value })} />
    {kind === 'Categorical'
      ? <TagInput
          placeholder="categories, press Enter after each"
          values={(options.categories || []).map(String)}
          onChange={values => set({ categories: values.map(asScalar) })}
        />
      : <>
          <NumberInput placeholder="low" value={options.low} onChange={low => set({ low })} />
          <NumberInput placeholder="high" value={options.high} onChange={high => set({ high })} />
          <Switch
            style={{margin: 'auto 5px'}}
            label="log-scale"
            title="Sample uniformly in log-space: for parameters spanning orders of magnitude, like learning rates"
            checked={options.prior === 'log-uniform'}
            onChange={e => {
              const { prior, ...rest } = options;
              onChange(kind, e.target.checked ? { ...rest, prior: 'log-uniform' } : rest);
            }}
          />
        </>
    }
    <Button icon="trash" minimal title="Remove this parameter" onClick={onRemove} />
  </ControlGroup>;
};


const OptimizeForm = ({ value, onChange, metrics }) => {
  const { config, parse_error } = parseOptimizeConfig(value || '');
  if (parse_error !== null)
    return <Callout intent={Intent.WARNING} title="The YAML below cannot be parsed">
      <p>Fix it in the editor to use this form.</p>
      <pre style={{whiteSpace: 'pre-wrap'}}>{parse_error}</pre>
    </Callout>;

  const update = mutate => {
    const next = { ...config };
    mutate(next);
    onChange(serializeOptimizeConfig(next));
  };

  const search_space = config.search_space || [];
  const objective = config.objective || {};
  const selected_metrics = objectiveMetrics(config);
  const available_metrics = Object.keys((metrics || {}).available_metrics || {});
  const addable_metrics = available_metrics.filter(m => !selected_metrics.includes(m));
  const patience = typeof config.early_stopping === 'object' && config.early_stopping !== null
    ? config.early_stopping.patience : config.early_stopping;
  const errors = validateOptimizeConfig(config);

  return <div style={{marginBottom: '10px'}}>
    <FormGroup
      label={<strong>Parameters to optimize</strong>}
      helperText="Integer/Real explore a range, Categorical explores a fixed set of values."
    >
      {search_space.map((dimension, index) =>
        <DimensionRow
          key={index}
          dimension={dimension}
          onChange={(kind, options) => update(c => { c.search_space = updateDimension(search_space, index, kind, options); })}
          onChangeKind={kind => update(c => { c.search_space = changeDimensionKind(search_space, index, kind); })}
          onRemove={() => update(c => { c.search_space = removeDimension(search_space, index); })}
        />
      )}
      <Button icon="plus" text="Add a parameter" onClick={() => update(c => { c.search_space = addDimension(search_space, 'Real'); })} />
    </FormGroup>

    <FormGroup
      label={<strong>Objective</strong>}
      helperText="Minimized automatically -- metrics configured as bigger-is-better are inverted."
    >
      {selected_metrics.map(metric =>
        <ControlGroup key={metric} style={{marginBottom: '5px'}}>
          <Tag minimal large style={{marginRight: '5px'}}>{metric}</Tag>
          <FormGroup inline label="weight" style={{marginBottom: 0}}>
            <NumberInput
              value={(objective[metric] || {}).weight ?? 1}
              onChange={weight => update(c => { c.objective = { ...objective, [metric]: { ...(objective[metric] || {}), weight } }; })}
            />
          </FormGroup>
          <Button
            icon="trash" minimal
            disabled={selected_metrics.length === 1}
            title={selected_metrics.length === 1 ? "The objective needs at least one metric" : "Remove this metric"}
            onClick={() => update(c => {
              const { [metric]: removed, ...rest } = objective;
              c.objective = rest;
            })}
          />
        </ControlGroup>
      )}
      {addable_metrics.length > 0 &&
        <HTMLSelect
          value=""
          options={[{value: "", label: "Add a metric..."}, ...addable_metrics.map(m => ({value: m, label: m}))]}
          onChange={e => {
            const metric = e.target.value;
            if (metric) update(c => { c.objective = { ...objective, [metric]: { weight: 1 } }; });
          }}
        />
      }
    </FormGroup>

    <FormGroup label={<strong>Search</strong>}>
      <ControlGroup style={{flexWrap: 'wrap', gap: '10px'}}>
        <FormGroup inline label="evaluations" helperText="total runs" style={{marginBottom: 0}}>
          <NumberInput value={config.evaluations} onChange={evaluations => update(c => { c.evaluations = evaluations; })} />
        </FormGroup>
        <FormGroup inline label="in parallel" style={{marginBottom: 0}}>
          <NumericInput
            style={{width: '60px'}}
            min={1}
            value={config.parallel_sampling ?? 1}
            onValueChange={n => Number.isInteger(n) && n >= 1 && update(c => { c.parallel_sampling = n; })}
          />
        </FormGroup>
        <FormGroup inline label="sampler" style={{marginBottom: 0}}>
          <HTMLSelect
            value={(config.solver || {}).sampler || 'gp'}
            options={SAMPLERS}
            onChange={e => update(c => { c.solver = { ...(config.solver || {}), sampler: e.target.value }; })}
          />
        </FormGroup>
      </ControlGroup>
      <div style={{marginTop: '10px'}}>
        <Switch
          inline
          label="Stop early when the search stops improving"
          checked={patience !== undefined && patience !== null}
          onChange={e => update(c => {
            if (e.target.checked) c.early_stopping = { patience: 15 };
            else delete c.early_stopping;
          })}
        />
        {patience !== undefined && patience !== null &&
          <FormGroup inline label="after" helperText="evaluations without a new best" style={{marginBottom: 0, display: 'inline-flex'}}>
            <NumericInput
              style={{width: '60px'}}
              min={1}
              value={patience}
              onValueChange={n => Number.isInteger(n) && n >= 1 && update(c => { c.early_stopping = { patience: n }; })}
            />
          </FormGroup>
        }
      </div>
      <Switch
        inline
        label="Pareto mode: optimize each metric separately and report the front of best trade-offs"
        disabled={config.pareto !== true && (selected_metrics.length < 2 || selected_metrics.length > 3)}
        title={selected_metrics.length < 2 ? "Needs 2 or 3 metrics in the objective" : undefined}
        checked={config.pareto === true}
        onChange={e => update(c => {
          if (e.target.checked) c.pareto = true;
          else delete c.pareto;
        })}
      />
    </FormGroup>

    {errors.length > 0
      ? <Callout intent={Intent.DANGER} title="This configuration is not valid yet">
          <ul>{errors.map((error, index) => <li key={index}>{error}</li>)}</ul>
        </Callout>
      : <Callout intent={Intent.SUCCESS} icon="tick">
          {search_space.length} parameter{search_space.length > 1 ? 's' : ''},{' '}
          {config.evaluations} evaluations
          {(config.parallel_sampling ?? 1) > 1 && <>, {config.parallel_sampling} in parallel</>}
          {patience > 0 && <>, early stopping after {patience} without improvement</>}
          {config.pareto === true && <>, Pareto front over {selected_metrics.join(' / ')}</>}
          . Interrupted searches resume automatically.
        </Callout>
    }
    <p className={Classes.TEXT_MUTED} style={{marginTop: '5px'}}>
      Every change is written to the YAML below -- edit either one. Form edits rewrite comments away.
    </p>
  </div>;
};

export default OptimizeForm;
