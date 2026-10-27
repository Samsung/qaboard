// The Automated tuning tab: a guided form over the YAML that `qa optimize` reads, for people who aren't optimization
// experts. Each step says what it's for and recommends values. The YAML stays one click away, and is the source of truth:
// the form edits it in place (see optimize_config.js).
import { useEffect, useId, useMemo, useState } from "react";
import styled from "styled-components";
import {
  Alert, Button, Callout, Card, Checkbox, Classes, Collapse, FormGroup, HTMLSelect, Icon, InputGroup, Intent,
  NumericInput, Radio, RadioGroup, SegmentedControl, Switch, TagInput, Tooltip,
} from "@blueprintjs/core";

import MonacoEditor from "../MonacoEditor";
import {
  KINDS, KIND_LABELS, template, parse, set, parameters as get_parameters, setParameter, addParameter, removeParameter,
  changeKind, objectiveMetrics, objective_options, objective_goal, setObjectiveMetric, renameObjectiveMetric,
  recommended_evaluations, suggest_log, metrics_to_choose, check, from_batch, known_parameters, continuation,
} from "./optimize_config";

const Layout = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 20px;
  align-items: start;
  @media (max-width: 1100px) { grid-template-columns: minmax(0, 1fr); }
  .qa-setup-step { margin-bottom: 22px; }
  .qa-setup-step > h3 { display: flex; align-items: center; gap: 10px; margin: 0 0 2px; font-size: 15px; }
  .qa-setup-step > p.qa-setup-how { margin: 0 0 10px 34px; font-size: 13px; }
  .qa-setup-step > .qa-setup-body { margin-left: 34px; }
  .qa-setup-number { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%;
    font-size: 12px; font-weight: 600; background: var(--qa-intent-primary); color: #fff; flex: none; }
  .qa-setup-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--qa-border); }
  .qa-setup-row:last-of-type { border-bottom: none; }
  .qa-setup-row-error { flex-basis: 100%; font-size: 12px; color: #cd4246; }
  .bp6-dark & .qa-setup-row-error { color: #fa999c; }
  .qa-setup-hint { flex-basis: 100%; font-size: 12px; display: flex; align-items: center; gap: 6px; }
  .qa-setup-aside { position: sticky; top: 12px; }
  .qa-setup-check { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 2px 8px; margin-bottom: 10px; }
  .qa-setup-check .title { font-weight: 600; }
  .qa-num { font-variant-numeric: tabular-nums; }
`;

const Code = ({ children }) => <code className={Classes.MONOSPACE_TEXT}>{children}</code>;
const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;

// A number input that lets users type ("0.", "1e-") and only writes valid numbers to the YAML
const NumberField = ({ value, onChange, integer = false, placeholder, width = 90, ...props }) => {
  const [text, setText] = useState(value === undefined || value === null ? '' : String(value));
  useEffect(() => {
    // the YAML changed elsewhere (YAML mode, reset...)
    if (Number(text) !== value) setText(value === undefined || value === null ? '' : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const valid = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text.trim()) && (!integer || Number.isInteger(Number(text)));
  return <InputGroup
    {...props}
    value={text}
    placeholder={placeholder}
    style={{ width }}
    intent={text && !valid ? Intent.DANGER : undefined}
    inputMode="decimal"
    onChange={e => {
      setText(e.target.value);
      const parsed = Number(e.target.value);
      if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(e.target.value.trim()) && (!integer || Number.isInteger(parsed))) onChange(parsed);
    }}
    onBlur={() => valid && setText(String(Number(text)))}
  />;
};

// Categories: numbers stay numbers, like in YAML
const category_value = text => {
  const trimmed = text.trim();
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(trimmed)) return Number(trimmed);
  if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true';
  return trimmed;
};

const Step = ({ number, title, how, children }) => <section className="qa-setup-step">
  <h3><span className="qa-setup-number" aria-hidden="true">{number}</span>{title}</h3>
  {how && <p className={`qa-setup-how ${Classes.TEXT_MUTED}`}>{how}</p>}
  <div className="qa-setup-body">{children}</div>
</section>;

const errors_at = (errors, path) => errors.filter(e => path.every((p, i) => e.path[i] === p)).map(e => e.message);
// `code` in the messages, shared with qa optimize
const Message = ({ text }) => text.split(/`([^`]+)`/).map((part, i) => i % 2 ? <Code key={i}>{part}</Code> : part);
const RowErrors = ({ messages }) => messages.length > 0 && <div className="qa-setup-row-error" role="alert">
  {messages.map(m => <div key={m}><Icon icon="error" size={12}/> <Message text={m}/></div>)}
</div>;

const goal_options = [
  { value: 'max', label: 'Higher is better', icon: 'arrow-up' },
  { value: 'min', label: 'Lower is better', icon: 'arrow-down' },
];

// Another metric the runs return, typed by its key
const OtherMetric = ({ onAdd, onCancel }) => {
  const [key, setKey] = useState('');
  const add = () => key.trim() && onAdd(key.trim());
  return <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
    <InputGroup
      autoFocus
      aria-label="The metric's key"
      placeholder="The key your runs return, e.g. psnr"
      value={key}
      onChange={e => setKey(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') add(); if (e.key === 'Escape') onCancel(); }}
      style={{ width: 260 }}
    />
    <Button icon="add" text="Add" disabled={!key.trim()} onClick={add}/>
    <Button variant="minimal" text="Cancel" onClick={onCancel}/>
  </div>;
};

const sampler_options = [
  { value: 'auto', label: 'Automatic (recommended)', description: 'Gaussian processes when PyTorch is installed where it runs, TPE otherwise.' },
  { value: 'gp', label: 'Gaussian processes', description: 'Learns the most from few evaluations: the best when each evaluation is slow. Needs PyTorch.' },
  { value: 'tpe', label: 'TPE', description: 'Fast and robust, also with many parameters or choices.' },
  { value: 'random', label: 'Random search', description: "Doesn't learn: a baseline to compare with." },
];


export const OptimizeSetup = ({ value, onChange, metrics, tests = 0, commit, experiment_name, mode = 'guided', onModeChange, support_url }) => {
  const id = useId();
  const [confirm_reset, setConfirmReset] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [other_metric, setOtherMetric] = useState(false);
  const { config, errors: parse_errors } = useMemo(() => parse(value), [value]);
  const errors = useMemo(() => config ? check(config, metrics) : [], [config, metrics]);
  const params = useMemo(() => get_parameters(config), [config]);
  const known = useMemo(() => known_parameters(commit), [commit]);
  const previous = useMemo(() => Object.values(commit?.batches ?? {}).filter(b => b.data?.optimization_config?.config), [commit]);
  const default_value = useMemo(() => template(metrics), [metrics]);

  const update = (path, new_value) => onChange(set(value, path, new_value));
  const objective_names = objectiveMetrics(config);
  // declared metrics, then those the runs returned
  const choices = useMemo(() => metrics_to_choose(metrics, commit), [metrics, commit]);
  const available = Object.entries(choices);
  const declared_goal = metric => objective_goal({}, metric, metrics).goal;
  const addMetric = key => onChange(setObjectiveMetric(value, key, { goal: declared_goal(key) ?? undefined }));
  const evaluations = Number.isInteger(config?.evaluations) ? config.evaluations : null;
  const parallel = Number.isInteger(config?.parallel_sampling) ? config.parallel_sampling : 1;
  const patience = typeof config?.early_stopping === 'object' && config?.early_stopping !== null ? config.early_stopping.patience : config?.early_stopping;
  const pareto = config?.pareto === true;
  const recommended = recommended_evaluations(params);
  const solver = config?.solver && typeof config.solver === 'object' ? config.solver : {};
  const continuing = useMemo(() => continuation(commit, experiment_name, config), [commit, experiment_name, config]);

  const header = <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 14 }}>
    <SegmentedControl
      aria-label="How to edit the configuration"
      options={[{ label: 'Guided', value: 'guided' }, { label: 'YAML', value: 'yaml' }]}
      value={mode}
      onValueChange={onModeChange}
    />
    {previous.length > 0 && <HTMLSelect
      aria-label="Start from a previous automated tuning"
      value=""
      onChange={e => {
        const batch = previous.find(b => b.label === e.target.value);
        if (batch) onChange(from_batch(batch));
      }}
      options={[{ value: '', label: 'Start from a previous tuning…' }, ...previous.map(b => ({ value: b.label, label: b.label }))]}
    />}
    <Button variant="minimal" icon="reset" disabled={value === default_value} onClick={() => setConfirmReset(true)}>Start over</Button>
    <Alert
      isOpen={confirm_reset}
      icon="reset"
      intent={Intent.WARNING}
      cancelButtonText="Cancel"
      confirmButtonText="Start over"
      canEscapeKeyCancel
      onCancel={() => setConfirmReset(false)}
      onConfirm={() => { setConfirmReset(false); onChange(default_value); }}
    >
      <p>Replace this configuration with an empty one? Your edits will be lost.</p>
    </Alert>
  </div>;

  const yaml_editor = <>
    <MonacoEditor height={360} language="yaml" options={{ selectOnLineNumbers: true, minimap: { enabled: false } }} name="editor-tuning-auto" onChange={onChange} value={value || ''}/>
    {(parse_errors.length > 0 || errors.length > 0) && <Callout intent={Intent.DANGER} icon="error" title="To fix before starting" style={{ marginTop: 10 }} data-testid="optimize-errors">
      <ul className={Classes.LIST}>{[...parse_errors, ...errors.map(e => e.message)].map(m => <li key={m}><Message text={m}/></li>)}</ul>
    </Callout>}
  </>;

  if (mode === 'yaml' || parse_errors.length > 0 || !config || typeof config !== 'object' || Array.isArray(config))
    return <div data-testid="optimize-setup">
      {header}
      {mode !== 'yaml' && <Callout intent={Intent.WARNING} icon="code" style={{ marginBottom: 10 }}>The guided form needs valid YAML: fix it below, or start over.</Callout>}
      {yaml_editor}
    </div>;

  const kind_options = KINDS.map(k => ({ value: k, label: KIND_LABELS[k] }));
  const summary_items = [
    {
      ok: params.length > 0 && errors_at(errors, ['search_space']).length === 0,
      title: params.length > 0 ? plural(params.length, 'parameter') : 'Add the parameters to tune',
      detail: params.map(p => p.name).filter(Boolean).join(', '),
    },
    {
      ok: objective_names.length > 0 && errors_at(errors, ['objective']).length === 0 && errors_at(errors, ['pareto']).length === 0,
      title: objective_names.length > 0 ? (pareto ? 'Best trade-offs between' : objective_names.length > 1 ? 'Combines' : 'Improves') : 'Choose what to improve',
      detail: objective_names.map(m => choices[m]?.label ?? m).join(pareto ? ' and ' : ', '),
    },
    {
      ok: evaluations !== null && errors_at(errors, ['evaluations']).length === 0 && !continuing?.error,
      title: evaluations !== null ? (continuing ? `${plural(Math.max(0, evaluations - continuing.done), 'more evaluation')}` : `${plural(evaluations, 'evaluation')}${patience ? ' at most' : ''}`) : 'Set the number of evaluations',
      detail: evaluations !== null && tests > 0
        ? `up to ${Math.max(0, evaluations - (continuing?.done ?? 0)) * tests} runs (${plural(tests, 'test')} each)${parallel > 1 ? `, ${parallel} evaluations at a time` : ''}`
        : (tests === 0 ? 'choose the batch of tests above to count the runs' : ''),
    },
  ];
  const ready = errors.length === 0 && !continuing?.error;

  return <div data-testid="optimize-setup">
    {header}
    <Layout>
      <div>
        {continuing && <Callout icon="history" intent={continuing.error ? Intent.WARNING : Intent.PRIMARY} style={{ marginBottom: 16 }} data-testid="optimize-continuing">
          <strong>{continuing.batch.label}</strong> is an automated tuning of this commit: starting with this batch label <strong>continues it</strong>,
          from its {plural(continuing.done, 'evaluation')}.{' '}
          {continuing.error
            ? <>Set more than {continuing.done} evaluations to search further <Button size="small" variant="minimal" intent={Intent.PRIMARY} text={`Use ${continuing.done + Math.max(10, Math.round(continuing.done / 2))}`} onClick={() => update(['evaluations'], continuing.done + Math.max(10, Math.round(continuing.done / 2)))}/>, or use another label to start over.</>
            : <>It runs {plural(Math.max(0, (evaluations ?? 0) - continuing.done), 'more evaluation')}. To start over instead, use another label.</>}
        </Callout>}

        <Step number={1} title="Parameters to tune" how={<>The tuning parameters your code reads, and the values to try. Your code gets them like those of Manual tuning.</>}>
          {params.length === 0 && <p className={Classes.TEXT_MUTED}>No parameter yet.</p>}
          {params.map((p, index) => {
            const row_errors = errors_at(errors, ['search_space', index]);
            const change = changes => onChange(setParameter(value, index, { ...p, ...changes }));
            return <div className="qa-setup-row" key={index} data-testid={`parameter-${index}`}>
              <InputGroup
                aria-label="Parameter name"
                placeholder="name, e.g. threshold"
                value={p.name}
                list={`${id}-known`}
                onChange={e => change({ name: e.target.value })}
                style={{ width: 200, fontFamily: 'var(--bp-font-family-monospace, monospace)' }}
              />
              <HTMLSelect aria-label="Kind" value={p.kind} options={kind_options} onChange={e => onChange(setParameter(value, index, changeKind(p, e.target.value)))}/>
              {p.kind === 'Categorical'
                ? <TagInput
                    aria-label="Values to try"
                    placeholder="values to try, Enter after each"
                    values={p.categories.map(String)}
                    onChange={values => change({ categories: values.map(category_value) })}
                    addOnBlur
                    fill={false}
                    style={{ minWidth: 260, flex: 1 }}
                    tagProps={{ minimal: true }}
                  />
                : <>
                    <span className={Classes.TEXT_MUTED}>from</span>
                    <NumberField aria-label="From" value={p.low} integer={p.kind === 'Integer'} onChange={low => change({ low })}/>
                    <span className={Classes.TEXT_MUTED}>to</span>
                    <NumberField aria-label="To" value={p.high} integer={p.kind === 'Integer'} onChange={high => change({ high })}/>
                    <Tooltip content="Tries values evenly across orders of magnitude, e.g. as many between 0.001 and 0.01 as between 0.01 and 0.1" hoverOpenDelay={300}>
                      <Checkbox label="log scale" checked={p.log} onChange={e => change({ log: e.target.checked })} style={{ margin: 0 }}/>
                    </Tooltip>
                  </>}
              <Button variant="minimal" icon="trash" aria-label={`Remove ${p.name || 'this parameter'}`} onClick={() => onChange(removeParameter(value, index))} style={{ marginLeft: 'auto' }}/>
              {suggest_log(p) && <div className={`qa-setup-hint ${Classes.TEXT_MUTED}`}>
                <Icon icon="lightbulb" size={12}/> The range spans {Math.round(Math.log10(p.high / p.low))} orders of magnitude: a log scale would search it better.
                <Button size="small" variant="minimal" intent={Intent.PRIMARY} text="Use a log scale" onClick={() => change({ log: true })}/>
              </div>}
              {/* a new row: a prompt rather than an error */}
              {p.name
                ? <RowErrors messages={row_errors}/>
                : <div className={`qa-setup-hint ${Classes.TEXT_MUTED}`}><Icon icon="edit" size={12}/> Name it like your code reads it, e.g. <Code>threshold</Code> or <Code>denoise.strength</Code>.</div>}
            </div>;
          })}
          <datalist id={`${id}-known`}>{known.map(name => <option key={name} value={name}>{name}</option>)}</datalist>
          <RowErrors messages={errors.filter(e => e.path.length === 1 && e.path[0] === 'search_space' && params.length > 0).map(e => e.message)}/>
          <Button icon="add" text="Add a parameter" onClick={() => onChange(addParameter(value, { kind: 'Real', name: '', low: 0, high: 1 }))} style={{ marginTop: 8 }} data-testid="add-parameter"/>
        </Step>

        <Step number={2} title="What “better” means" how={<>The metrics to improve, any your runs return, averaged over the batch's runs. Say which way is better for each: the search looks for the parameters with the best ones.</>}>
          {objective_names.map(metric => {
            const options = objective_options(config, metric);
            const { goal, from } = objective_goal(config, metric, metrics);
            const label = choices[metric]?.label ?? metric;
            const declared = declared_goal(metric);
            const weight = options.weight ?? 1;
            return <div className="qa-setup-row" key={metric} data-testid={`objective-${metric}`}>
              <HTMLSelect
                aria-label="Metric"
                value={metric}
                onChange={e => onChange(renameObjectiveMetric(value, metric, e.target.value, declared_goal(e.target.value)))}
                options={[
                  ...available.filter(([key]) => key === metric || !objective_names.includes(key)).map(([key, m]) => ({ value: key, label: m?.label ?? key })),
                  ...(available.some(([key]) => key === metric) ? [] : [{ value: metric, label: metric }]),
                ]}
              />
              <SegmentedControl
                size="small"
                aria-label={`Which way is better for ${label}`}
                options={goal_options}
                value={goal ?? ''}
                intent={goal ? Intent.NONE : Intent.DANGER}
                onValueChange={g => onChange(setObjectiveMetric(value, metric, { ...options, goal: g }))}
              />
              {!pareto && <>
                <span className={Classes.TEXT_MUTED} style={{ marginLeft: 8 }}>weight</span>
                <NumberField aria-label={`Weight of ${metric}`} value={weight} onChange={w => onChange(setObjectiveMetric(value, metric, { ...options, weight: w }))} width={80}/>
              </>}
              <Button variant="minimal" icon="trash" aria-label={`Remove ${metric}`} disabled={objective_names.length === 1} onClick={() => update(['objective', metric], undefined)} style={{ marginLeft: 'auto' }}/>
              {from === 'config' && declared && declared !== goal && <div className={`qa-setup-hint ${Classes.TEXT_MUTED}`}>
                <Icon icon="info-sign" size={12}/> Your project says {declared === 'max' ? 'higher' : 'lower'} is better for {label}: this search does the opposite.
              </div>}
              <RowErrors messages={errors_at(errors, ['objective', metric])}/>
            </div>;
          })}
          <RowErrors messages={errors.filter(e => e.path.length === 1 && e.path[0] === 'objective' && objective_names.length > 0).map(e => e.message)}/>
          {other_metric
            ? <OtherMetric onAdd={key => { addMetric(key); setOtherMetric(false); }} onCancel={() => setOtherMetric(false)}/>
            : <HTMLSelect
              aria-label="Add a metric"
              value=""
              onChange={e => e.target.value === '\u0000other' ? setOtherMetric(true) : e.target.value && addMetric(e.target.value)}
              options={[
                { value: '', label: objective_names.length ? '+ Add a metric' : '+ Choose a metric' },
                ...available.filter(([key]) => !objective_names.includes(key)).map(([key, m]) => ({ value: key, label: m?.label ?? key })),
                { value: '\u0000other', label: 'Another metric…' },
              ]}
              style={{ marginTop: 8 }}
            />}
          {objective_names.length > 1 && <RadioGroup
            selectedValue={pareto ? 'pareto' : 'weights'}
            onChange={e => update(['pareto'], e.currentTarget.value === 'pareto' ? true : undefined)}
            style={{ marginTop: 12 }}
          >
            <Radio value="weights" labelElement={<span><strong>Combine them into one score</strong> <span className={Classes.TEXT_MUTED}>— the weights say how much each counts, e.g. 0.005 per MB means 2 MB more must buy 0.01 of mAP.</span></span>}/>
            <Radio value="pareto" disabled={objective_names.length > 3} labelElement={<span><strong>Find the best trade-offs</strong> <span className={Classes.TEXT_MUTED}>— no weights to guess: each metric is optimized on its own, and you pick among the best trade-offs at the end (2 or 3 metrics).</span></span>}/>
          </RadioGroup>}
          <RowErrors messages={errors_at(errors, ['pareto'])}/>
        </Step>

        <Step number={3} title="Budget" how={<>Each evaluation runs the batch with new parameters. More evaluations find better parameters, and take longer.</>}>
          <FormGroup inline label="Evaluations" labelFor={`${id}-evaluations`} style={{ marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <NumberField id={`${id}-evaluations`} value={evaluations ?? undefined} integer onChange={n => update(['evaluations'], n)} width={80}/>
              {params.length > 0 && <span className={Classes.TEXT_MUTED}>
                Recommended for {plural(params.length, 'parameter')}: about {recommended}.
                {evaluations !== recommended && <Button size="small" variant="minimal" intent={Intent.PRIMARY} text={`Use ${recommended}`} onClick={() => update(['evaluations'], recommended)}/>}
              </span>}
            </div>
          </FormGroup>
          <RowErrors messages={errors_at(errors, ['evaluations'])}/>
          <FormGroup inline label="At the same time" labelFor={`${id}-parallel`} helperText="Several evaluations at once finish sooner; the search learns a bit less from each." style={{ marginBottom: 6 }}>
            <NumericInput id={`${id}-parallel`} min={1} max={32} value={parallel} onValueChange={n => Number.isInteger(n) && n >= 1 && update(['parallel_sampling'], n === 1 ? undefined : n)} style={{ width: 60 }}/>
          </FormGroup>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Switch
              label="Stop early when it stops improving"
              checked={patience !== undefined && patience !== null}
              onChange={e => update(['early_stopping'], e.target.checked ? { patience: Math.max(10, Math.round((evaluations ?? 30) / 3)) } : undefined)}
              style={{ margin: 0 }}
            />
            {patience !== undefined && patience !== null && <>
              <span className={Classes.TEXT_MUTED}>after</span>
              <NumberField aria-label="Patience" value={patience} integer onChange={n => update(['early_stopping', 'patience'], n)} width={60}/>
              <span className={Classes.TEXT_MUTED}>evaluations without a better result</span>
            </>}
          </div>
          <RowErrors messages={errors_at(errors, ['early_stopping']).concat(errors_at(errors, ['parallel_sampling']))}/>
        </Step>

        <Button variant="minimal" icon={advanced ? 'chevron-down' : 'chevron-right'} onClick={() => setAdvanced(!advanced)} data-testid="optimize-advanced">Advanced settings</Button>
        <Collapse isOpen={advanced}>
          <div style={{ padding: '10px 0 0 34px' }}>
            <FormGroup label="How the search picks parameters" labelFor={`${id}-sampler`} helperText={sampler_options.find(o => o.value === (solver.sampler ?? 'auto'))?.description}>
              <HTMLSelect id={`${id}-sampler`} value={solver.sampler ?? 'auto'} options={sampler_options} onChange={e => update(['solver', 'sampler'], e.target.value === 'auto' ? undefined : e.target.value)}/>
            </FormGroup>
            <FormGroup inline label="Random evaluations first" labelFor={`${id}-startup`} helperText="To explore before the search starts aiming. Default: 10.">
              <NumberField id={`${id}-startup`} value={solver.n_startup_trials} integer placeholder="10" onChange={n => update(['solver', 'n_startup_trials'], n)} width={60}/>
            </FormGroup>
            <FormGroup inline label="Random seed" labelFor={`${id}-seed`} helperText="The same seed and settings try the same parameters.">
              <NumberField id={`${id}-seed`} value={solver.seed} integer placeholder="101" onChange={n => update(['solver', 'seed'], n)} width={80}/>
            </FormGroup>
            <Switch label="Keep the runs of every best evaluation, not only of the latest" checked={!!config.keep_all_best_iters} onChange={e => update(['keep_all_best_iters'], e.target.checked || undefined)}/>
            <RowErrors messages={errors_at(errors, ['solver']).concat(errors_at(errors, ['preset_params']))}/>
            <p className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>
              Parameters to fix (<Code>preset_params</Code>) and the objective's <Code>loss</Code> and <Code>target</Code> are in the YAML.
            </p>
          </div>
        </Collapse>
      </div>

      <Card compact className="qa-setup-aside" data-testid="optimize-summary">
        <h4 style={{ marginTop: 0 }}>{ready ? <><Icon icon="tick-circle" intent={Intent.SUCCESS}/> Ready to start</> : 'To start'}</h4>
        {summary_items.map((item, i) => <div className="qa-setup-check" key={i}>
          <Icon icon={item.ok ? 'tick-circle' : 'circle'} intent={item.ok ? Intent.SUCCESS : Intent.NONE} className={item.ok ? undefined : Classes.TEXT_MUTED}/>
          <div>
            <div className="title">{item.title}</div>
            {item.detail && <div className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>{item.detail}</div>}
          </div>
        </div>)}
        {continuing && <div className="qa-setup-check">
          <Icon icon="history" intent={Intent.PRIMARY}/>
          <div><div className="title">Continues {continuing.batch.label}</div><div className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>after its {plural(continuing.done, 'evaluation')}</div></div>
        </div>}
        <p className={Classes.TEXT_MUTED} style={{ fontSize: 12, marginBottom: 0 }}>
          Results show in <strong>Tuning Analysis</strong> as they arrive. If the search stops, start it again with the same label: it resumes.
        </p>
        {support_url && <p style={{ fontSize: 12, marginTop: 6, marginBottom: 0 }}>Questions, ideas? Send <a href={support_url}>feedback</a>.</p>}
      </Card>
    </Layout>
  </div>;
};

export default OptimizeSetup;
