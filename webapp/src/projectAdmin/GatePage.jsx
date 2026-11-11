// /<project>/admin/gate: the rules the project's quality gate holds every commit to (docs/rfcs/project-admin.md).
// Everyone who sees the project reads them: the gate: section of the reference branch's qaboard.yaml, and the project
// rules. Owners (and admins) edit the project rules: `qa gate` checks them on top of the commit's own, and no commit
// can change them.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, Callout, Classes, FormGroup, HTMLSelect, HTMLTable, InputGroup, Intent, Radio, RadioGroup, Switch,
} from "@blueprintjs/core";
import { DateTime } from "luxon";
import styled from "styled-components";

import { useSelected } from "../selection";
import { useSiteConfig } from "../hooks";
import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { parseDate } from "../settings/format";
import { Loading, QueryError } from "../settings/states";
import { usePageTitle, join_title, project_name } from "../pageTitle";
import { ProjectAdminTabs } from "./ProjectAdminTabs";
import { projectSettingsQuery, saveGate } from "./api";
import {
  rule_kinds, aggregates, is_regression_kind, has_aggregate, check_text, limit_text, rule_rows, new_rule,
  form_from_gate, gate_from_form, scope_parts, expect_batches_text,
} from "./rules";


// Below the fixed navbar, like the Access page
const Page = styled.main`
  box-sizing: border-box;
  width: 100%;
  max-width: 1100px;
  min-width: 0;
  padding: 66px clamp(16px, 4%, 40px) 40px;

  section + section {
    margin-top: 28px;
  }
  h4.${Classes.HEADING} {
    margin-bottom: 8px;
  }
  .qa-muted-line {
    margin: 0 0 12px;
    max-width: 720px;
  }
  .qa-note {
    margin: 12px 0 0;
    max-width: 720px;
    font-size: 12px;
  }
`;

const Checks = styled.ul`
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  li {
    padding: 2px 0;
  }
`;

// One rule per line: the metric, what is checked, the limit, how tests are aggregated, then "Only for…" opens a
// second line with the batches and labels it checks
const RuleRow = styled.div`
  display: grid;
  grid-template-columns: minmax(140px, 1.5fr) minmax(200px, 1.5fr) minmax(80px, 0.6fr) minmax(100px, 0.6fr) 30px 30px;
  grid-template-areas: "metric check limit aggregate scope remove" "scopes scopes scopes scopes scopes scopes";
  gap: 8px;
  align-items: center;
  max-width: 900px;
  margin-bottom: 8px;
  > .qa-rule-metric { grid-area: metric; }
  > .qa-rule-check { grid-area: check; }
  > .qa-rule-limit { grid-area: limit; }
  > .qa-rule-aggregate { grid-area: aggregate; }
  > .qa-rule-scope { grid-area: scope; }
  > .qa-rule-remove { grid-area: remove; }
  > .qa-rule-scopes {
    grid-area: scopes;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 8px;
    margin-bottom: 4px;
  }

  /* narrow pages: two lines per rule, and its scope under them */
  @media (max-width: 760px) {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 30px;
    grid-template-areas: "metric check remove" "limit aggregate scope" "scopes scopes scopes";
    padding-bottom: 8px;
    border-bottom: 1px solid var(--qa-border);
    > .qa-rule-scopes { grid-template-columns: minmax(0, 1fr); }
  }
`;

const showSuccess = message => toaster.show({ message, intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 });


// "only `qa batch perf`, only the label nightly"
const Scope = ({ rule }) => {
  const parts = scope_parts(rule);
  if (parts.length === 0) return <span className={Classes.TEXT_MUTED}>every run</span>;
  return parts.map((part, index) => <span key={part.what}>
    {index > 0 && ', '}{part.text}
    {part.names.map((name, i) => <span key={name}>{i > 0 && (part.what === 'batch' ? ' or ' : ', ')}<code>{name}</code></span>)}
  </span>);
};

// Rules, one per limit: {metric, kind, limit, aggregate, batch, label}. Limits are fractions, or as qaboard.yaml
// writes them ("5%"). Which runs they check only when a rule doesn't check them all.
export const RulesTable = ({ rules, label }) => {
  const scoped = rules.some(rule => scope_parts(rule).length > 0);
  return <div style={{ overflowX: 'auto' }}>
    <HTMLTable compact aria-label={label}>
      <thead>
        <tr><th>Metric</th><th>Check</th><th>Limit</th>{scoped && <th>Runs</th>}</tr>
      </thead>
      <tbody>
        {rules.map((rule, index) => <tr key={index}>
          <td><code style={{ overflowWrap: 'anywhere' }}>{rule.metric}</code></td>
          <td>{check_text(rule.kind, rule.aggregate)}</td>
          <td style={{ whiteSpace: 'nowrap' }}>{limit_text(rule.kind, rule.limit)}</td>
          {scoped && <td><Scope rule={rule}/></td>}
        </tr>)}
      </tbody>
    </HTMLTable>
  </div>;
};

// What the gate checks besides metrics. `none`: what no limit on failed runs means
const OtherChecks = ({ max_failed_runs, require_bit_accuracy, expect_batches, none, children }) => {
  const expected = expect_batches_text(expect_batches);
  return <Checks>
    <li>Failed runs allowed: <strong>{max_failed_runs ?? none}</strong></li>
    {require_bit_accuracy && <li>Outputs must be bit-accurate.</li>}
    {expected && <li>Waits for runs from: <strong>{expected}</strong></li>}
    {children}
  </Checks>;
};


// The gate: section of the reference branch's qaboard.yaml, as `qa gate` reads it. Read-only: it belongs to the commits.
export const YamlRules = ({ reference }) => {
  const { rules } = reference;
  // the server only has the configuration of projects that sent results
  if (!reference.has_config)
    return <section aria-label="Rules in qaboard.yaml">
      <h4 className={Classes.HEADING}>Rules in qaboard.yaml</h4>
      <p className={Classes.TEXT_MUTED} style={{ margin: 0 }}>QA-Board hasn't received results from this project yet.</p>
    </section>;
  let content;
  if (reference.error)
    content = <Callout intent={Intent.WARNING} compact style={{ maxWidth: 720 }}>
      <code>qa gate</code> would stop with: {reference.error}
    </Callout>;
  else if (!reference.has_gate && rules.length === 0)
    content = <p style={{ margin: 0 }}>
      This project's qaboard.yaml has no gate section: <code>qa gate</code> only checks that no run failed.
    </p>;
  else
    content = <>
      {rules.length > 0
        ? <RulesTable rules={rules} label="Rules in qaboard.yaml"/>
        : <p className={Classes.TEXT_MUTED} style={{ margin: 0 }}>No rules on metrics.</p>}
      <OtherChecks max_failed_runs={reference.max_failed_runs} require_bit_accuracy={reference.require_bit_accuracy} expect_batches={reference.expect_batches} none="not checked"/>
    </>;
  return <section aria-label="Rules in qaboard.yaml">
    <h4 className={Classes.HEADING}>Rules in qaboard.yaml</h4>
    {content}
    <p className={`${Classes.TEXT_MUTED} qa-note`}>
      From the reference branch{reference.branch && <> (<code>{reference.branch}</code>)</>}. Commits are checked against the rules in their own qaboard.yaml: change them there.
    </p>
  </section>;
};


const looser_rules_choices = [
  { value: 'warn', label: "Say so in the gate's output and comment" },
  { value: 'fail', label: "Fail the gate" },
];

// For those who can't change them
export const ProjectRulesSummary = ({ gate }) => {
  const rules = rule_rows(gate?.rules);
  if (!gate) return <p className={Classes.TEXT_MUTED} style={{ margin: 0 }}>No project rules.</p>;
  const on_looser_rules = looser_rules_choices.find(choice => choice.value === gate.on_looser_rules) ?? looser_rules_choices[0];
  return <>
    {rules.length > 0
      ? <RulesTable rules={rules} label="Project rules"/>
      : <p className={Classes.TEXT_MUTED} style={{ margin: 0 }}>No project rules.</p>}
    <OtherChecks max_failed_runs={gate.max_failed_runs} require_bit_accuracy={!!gate.require_bit_accuracy} expect_batches={gate.expect_batches} none="no project limit">
      <li>When a commit loosens its own rules: <strong>{on_looser_rules.label.toLowerCase()}</strong></li>
    </OtherChecks>
  </>;
};


const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Owners edit the project rules. Limits are kept as typed: the server validates them like `qa gate` reads them,
// and says what to fix.
export const GateEditor = ({ project, gate }) => {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => form_from_gate(gate));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const saved = form_from_gate(gate);
  // When the rules change on the server (another owner saved them, and the page refreshed), a form nobody touched
  // follows them. What owners are editing stays.
  const [base, setBase] = useState(gate);
  if (!same(base, gate)) {
    setBase(gate);
    if (same(form, form_from_gate(base))) setForm(saved);
  }
  const to_save = gate_from_form(form);
  // rows left empty aren't a change
  const changed = !same(to_save, gate_from_form(saved));

  // Warn before closing or reloading the page with unsaved rules, like the tuning page's editor
  useEffect(() => {
    if (!changed) return;
    const onBeforeUnload = e => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [changed]);

  const update = changes => setForm(form => ({ ...form, ...changes }));
  const updateRule = (index, changes) => setForm(form => ({ ...form, rules: form.rules.map((rule, i) => i === index ? { ...rule, ...changes } : rule) }));
  const removeRule = index => setForm(form => ({ ...form, rules: form.rules.filter((_, i) => i !== index) }));

  const submit = event => {
    event.preventDefault();
    if (!changed || saving) return;
    setSaving(true);
    setError(null);
    saveGate(queryClient, project, to_save)
      .then(settings => {
        setForm(form_from_gate(settings.gate));
        showSuccess("Saved the project's gate rules");
      })
      // e.g. "gate.rules[0].max_regression: expected a percentage like 5%..."
      .catch(error => setError(errorMessage(error)))
      .finally(() => setSaving(false));
  };
  const reset = () => {
    setForm(saved);
    setError(null);
  };

  // The "Only for…" line is open for rules with a scope, and those owners opened. Closing it checks every run again.
  const scope_shown = rule => !!rule.scope_open || rule.batch.trim() !== '' || rule.label.trim() !== '';
  const toggleScope = (rule, index) => updateRule(index, scope_shown(rule) ? { scope_open: false, batch: '', label: '' } : { scope_open: true });

  return <form onSubmit={submit} aria-label="Project rules">
    {form.rules.map((rule, index) => <RuleRow key={index} role="group" aria-label={`Rule ${index + 1}`}>
      <InputGroup
        className="qa-rule-metric"
        aria-label="Metric"
        placeholder="metric, e.g. psnr"
        value={rule.metric}
        onChange={e => updateRule(index, { metric: e.target.value })}
      />
      <HTMLSelect
        className="qa-rule-check"
        aria-label="Check"
        fill
        value={rule.kind}
        onChange={e => updateRule(index, { kind: e.target.value })}
        options={rule_kinds.map(kind => ({ value: kind, label: check_text(kind, rule.aggregate) }))}
      />
      <InputGroup
        className="qa-rule-limit"
        aria-label="Limit"
        placeholder={is_regression_kind(rule.kind) ? "5%" : "0.42"}
        value={rule.limit}
        onChange={e => updateRule(index, { limit: e.target.value })}
      />
      {has_aggregate(rule.kind)
        ? <HTMLSelect
          className="qa-rule-aggregate"
          aria-label="Aggregate"
          title="How the tests' values are aggregated"
          fill
          value={rule.aggregate}
          onChange={e => updateRule(index, { aggregate: e.target.value })}
          options={aggregates}
        />
        // each test is checked: nothing to aggregate
        : <span className="qa-rule-aggregate"/>}
      <Button
        className="qa-rule-scope"
        variant="minimal"
        icon="filter"
        active={scope_shown(rule)}
        aria-expanded={scope_shown(rule)}
        aria-label="Only for…"
        title={scope_shown(rule) ? "Check every run again" : "Only for some batches or labels"}
        onClick={() => toggleScope(rule, index)}
      />
      <Button className="qa-rule-remove" variant="minimal" icon="cross" aria-label="Remove the rule" onClick={() => removeRule(index)}/>
      {scope_shown(rule) && <div className="qa-rule-scopes">
        <InputGroup
          aria-label="Only the batches"
          placeholder="only the runs of qa batch…, e.g. perf, unit-*"
          value={rule.batch}
          onChange={e => updateRule(index, { batch: e.target.value })}
        />
        <InputGroup
          aria-label="Only the labels"
          placeholder="only when checking the labels…, e.g. nightly"
          value={rule.label}
          onChange={e => updateRule(index, { label: e.target.value })}
        />
      </div>}
    </RuleRow>)}
    {form.rules.length === 0 && <p className={Classes.TEXT_MUTED} style={{ margin: '0 0 8px' }}>No project rules.</p>}
    <Button icon="plus" text="Add a rule" onClick={() => update({ rules: [...form.rules, new_rule()] })}/>

    <FormGroup
      label="Failed runs allowed"
      labelFor="gate-max-failed-runs"
      helperText="Leave empty for no project limit: the commit's own applies."
      style={{ margin: '20px 0 12px' }}
    >
      <InputGroup
        id="gate-max-failed-runs"
        type="number"
        min={0}
        step={1}
        value={form.max_failed_runs}
        onChange={e => update({ max_failed_runs: e.target.value })}
        style={{ maxWidth: 120 }}
      />
    </FormGroup>
    <FormGroup
      label="Wait for runs from"
      labelFor="gate-expect-batches"
      helperText={<>The batches (<code>qa batch …</code>) that must have runs before the gate decides, comma-separated. Per label: <code>default: ci, perf; nightly: all</code>.</>}
      style={{ margin: '0 0 12px', maxWidth: 560 }}
    >
      <InputGroup
        id="gate-expect-batches"
        placeholder="e.g. ci, perf"
        value={form.expect_batches}
        onChange={e => update({ expect_batches: e.target.value })}
      />
    </FormGroup>
    <Switch
      label="Outputs must be bit-accurate"
      checked={form.require_bit_accuracy}
      onChange={e => update({ require_bit_accuracy: e.target.checked })}
    />
    <RadioGroup
      label="When a commit loosens its own rules"
      name="gate-on-looser-rules"
      style={{ marginTop: 16 }}
      selectedValue={form.on_looser_rules}
      onChange={e => update({ on_looser_rules: e.currentTarget.value })}
    >
      {looser_rules_choices.map(choice => <Radio key={choice.value} value={choice.value} label={choice.label}/>)}
    </RadioGroup>
    <p className={Classes.TEXT_MUTED} style={{ margin: '0 0 16px', fontSize: 12 }}>Compared with the rules of the reference's qaboard.yaml.</p>

    {error && <Callout intent={Intent.DANGER} role="alert" compact style={{ marginBottom: 12, maxWidth: 720 }}>{error}</Callout>}
    <div style={{ display: 'flex', gap: 8 }}>
      <Button type="submit" intent={Intent.PRIMARY} text="Save" loading={saving} disabled={!changed}/>
      <Button text="Reset" disabled={saving || same(form, saved)} onClick={reset}/>
    </div>
  </form>;
};


// "Last changed by alice on Nov 10, 2026, 11:00 AM"
const LastChanged = ({ gate_updated }) => {
  const date = parseDate(gate_updated?.at);
  if (!gate_updated || (!gate_updated.by && !date?.isValid)) return null;
  return <p className={`${Classes.TEXT_MUTED} qa-note`}>
    Last changed{gate_updated.by && <> by {gate_updated.by}</>}
    {date?.isValid && <> on <time dateTime={gate_updated.at}>{date.toLocaleString(DateTime.DATETIME_MED)}</time></>}
  </p>;
};

// `settings`: what the server answers, see projectSettingsQuery
export const ProjectRules = ({ settings }) => <section aria-label="Project rules">
  <h4 className={Classes.HEADING}>Project rules</h4>
  <p className={`${Classes.TEXT_MUTED} qa-muted-line`}>
    Checked on every commit, on top of the commit's own rules. No commit can change them.
  </p>
  {settings.can_manage
    // another project: its own rules
    ? <GateEditor key={settings.project} project={settings.project} gate={settings.gate}/>
    : <ProjectRulesSummary gate={settings.gate}/>}
  <LastChanged gate_updated={settings.gate_updated}/>
  <p className={`${Classes.TEXT_MUTED} qa-note`}>
    Project rules need a recent qa in your CI: older versions ignore them.
  </p>
</section>;


const ProjectGate = ({ project }) => {
  const { data, isPending, error, refetch } = useQuery(projectSettingsQuery(project));
  if (isPending) return <Loading label="Loading the gate's rules"/>;
  // projects users can't see are handled around the page (ProjectAccessGate). Once loaded, the page stays: a
  // failed refresh doesn't throw away what owners are editing.
  if (!data) return <QueryError error={error} refetch={refetch} what="the gate's rules"/>;
  return <>
    <YamlRules reference={data.reference}/>
    <ProjectRules settings={data}/>
  </>;
};


export const GatePage = () => {
  const { project } = useSelected();
  const { docs_root } = useSiteConfig();
  usePageTitle(join_title('Quality gate', project_name(project)));
  return <Page>
    <ProjectAdminTabs project={project} current="gate"/>
    <h2 className={Classes.HEADING} style={{ marginBottom: 4 }}>Quality gate</h2>
    <p className={`${Classes.TEXT_MUTED} qa-muted-line`} style={{ overflowWrap: 'anywhere' }}>
      The rules every commit of <strong>{project}</strong> is held to.
    </p>
    <p style={{ margin: '0 0 20px', maxWidth: 720 }}>
      The gate (<code>qa gate</code>, in your CI) fails a commit whose results regress against the reference.{' '}
      <a href={`${docs_root}docs/quality-gate`} target="_blank" rel="noopener noreferrer">Quality gate docs</a>
    </p>
    <ProjectGate project={project}/>
  </Page>;
};

export default GatePage;
