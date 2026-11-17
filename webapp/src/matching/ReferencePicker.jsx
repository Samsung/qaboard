// Picks the reference run a run compares with: for this run only (a pin), or for all the runs like it (a name rule
// or a preference, see src/matching/rules.js). Opened from the run card's reference tag, or the run's menu.
// Loaded when opened: it's not in the run cards' bundle.
import { useMemo, useState } from "react";
import { Button, Classes, Icon, InputGroup, Radio, RadioGroup } from "@blueprintjs/core";
import styled from "styled-components";

import { useComparison, useSiteConfig } from "../hooks";
import { runName } from "../utils/runName";
import { metric_formatter } from "../components/metrics";
import { TextChange } from "../configurations/ConfigurationsTags";
import { reference_candidates, rules_for_all } from "./match";
import { rule_text } from "./names";
import { fact_text, preferences_for, without_pin } from "./rules";
import { save_rules } from "./save";

const SHOWN = 100;

const Picker = styled.div`
  width: min(480px, calc(100vw - 32px));
  display: flex;
  flex-direction: column;
  .picker-head { padding: 10px 12px 6px; display: flex; flex-direction: column; gap: 6px; }
  .picker-head .${Classes.RADIO} { margin: 0 12px 0 0; }
  .picker-head .${Classes.LABEL} { margin: 0; }
  .picker-list { margin: 0; padding: 0 4px 4px; max-height: 360px; overflow-y: auto; }
  /* the group stays in sight while scrolling its runs */
  .picker-group { position: sticky; top: 0; z-index: 1; background: var(--qa-surface); padding: 6px 8px 2px; font-size: 12px; }
  .picker-group .label { text-transform: uppercase; letter-spacing: .05em; font-size: 11px; }
  .picker-group code { font-size: 11px; }
  .picker-item { display: grid; grid-template-columns: 16px 1fr auto; gap: 2px 8px; width: 100%; padding: 6px 8px; border: 0;
    border-radius: 3px; background: none; color: inherit; text-align: left; cursor: pointer; font: inherit; }
  .picker-item.active { background: var(--qa-hover); }
  .picker-item .picker-name { font-family: var(--bp-typography-family-mono, monospace); font-size: 12px; overflow-wrap: anywhere; min-width: 0; }
  .picker-item .picker-metric { font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .picker-item .picker-why { grid-column: 2 / 4; display: flex; flex-wrap: wrap; gap: 4px; font-size: 12px; }
  .picker-fact { font-family: var(--bp-typography-family-mono, monospace); font-size: 11px; padding: 0 4px; border-radius: 2px; background: var(--qa-surface-alt); }
  .picker-foot { border-top: 1px solid var(--qa-border); padding: 8px 12px 10px; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
  .picker-hint { min-height: 18px; }
  .picker-in-use { font-weight: 600; color: var(--qa-side-1); }
`;

const group_title = (kind, output) => ({
  pair: <span className="label">Paired by name</span>,
  input: <span className="label">Same input</span>,
  // ids are case-sensitive: not uppercased
  id: <><span className="label">Same metadata.id</span> <code>{output.test_input_metadata?.id}</code></>,
  similar: <span className="label">Similar name</span>,
}[kind]);

const metric_text = (output, o, metric) => {
  const value = o.metrics?.[metric?.key];
  if (typeof value !== 'number') return null;
  const own = output.metrics?.[metric.key];
  const delta = typeof own === 'number' ? own - value : null;
  return `${metric.short_label ?? metric.key} ${metric_formatter(value, metric)}${delta !== null ? ` · Δ ${delta >= 0 ? '+' : '−'}${metric_formatter(Math.abs(delta), metric)}` : ''}`;
};

export default function ReferencePicker({ output, onClose }) {
  const { ref_batch, ref_lookup, selected, metrics } = useComparison();
  const { docs_root } = useSiteConfig();
  const rules = selected.reference_rules;
  const [filter, setFilter] = useState('');
  const [scope, setScope] = useState('run');
  const [active, setActive] = useState(0);

  const candidates = useMemo(
    () => reference_candidates({ output, batch: ref_batch, index: ref_lookup, rules }),
    [output, ref_batch, ref_lookup, rules],
  );
  const shown = useMemo(() => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    return candidates
      .filter(c => words.every(w => `${c.o.test_input_path} ${preferences_for(c.o, output).map(fact_text).join(' ')}`.toLowerCase().includes(w)))
      .slice(0, SHOWN);
  }, [candidates, filter, output]);
  const index = Math.min(active, Math.max(0, shown.length - 1));
  const current = ref_batch?.outputs?.[output.reference_id];
  const auto = candidates.find(c => c.kind !== 'similar');
  const metric = metrics?.available_metrics?.[metrics?.default_metric]
    ? { key: metrics.default_metric, ...metrics.available_metrics[metrics.default_metric] }
    : null;

  const highlighted = shown[index];
  const for_all = highlighted && scope === 'all' && highlighted.o !== current
    ? rules_for_all({ output, candidate: highlighted, current, rules, index: ref_lookup })
    : null;
  const pick = c => {
    if (!c) return;
    const all = scope === 'all' && c.o !== current ? rules_for_all({ output, candidate: c, current, rules, index: ref_lookup }) : null;
    onClose();
    if (all) {
      const what = all.added.pairs.length ? all.added.pairs.map(rule_text).join(', ') : `reference runs with ${all.added.prefer.map(fact_text).join(', ')}`;
      return save_rules(rules, all.rules, `Every run like this one now compares with ${what}`);
    }
    if (c.o === current) return;
    // picking what the rules pick anyway undoes the pin
    const unpinned = without_pin(rules, output.id);
    save_rules(rules, c.o === auto?.o ? unpinned : { ...unpinned, pins: { ...unpinned.pins, [output.id]: c.o.id } }, `${runName(output)} now compares with ${c.o.test_input_path}`);
  };

  let hint;
  if (!highlighted) hint = null;
  else if (highlighted.o === current) hint = 'The reference run in use.';
  else if (scope === 'run') hint = <>Compare <b>this run</b> with it. The others don't change.</>;
  else if (!for_all) hint = <>No rule for all runs would pick it: only <b>this run</b> will compare with it.</>;
  else if (for_all.added.pairs.length) hint = <>Every run whose name has <code>{for_all.added.pairs.map(p => p.from).join(', ')}</code> compares with the reference run named with <code>{for_all.added.pairs.map(p => p.to).join(', ')}</code>.</>;
  else hint = <>Prefer reference runs with <code>{for_all.added.prefer.map(fact_text).join(', ')}</code>, for every run.</>;

  const onKeyDown = event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(Math.min(shown.length - 1, index + 1)); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive(Math.max(0, index - 1)); }
    // a focused button or link handles its own Enter
    if (event.key === 'Enter' && !event.target.closest('button, a, [role="radio"], input[type="radio"]')) { event.preventDefault(); pick(highlighted); }
  };

  return <Picker onKeyDown={onKeyDown} role="dialog" aria-label={`Compare ${runName(output)} with another reference run`}>
    <div className="picker-head">
      <strong>Compare {runName(output)} with…</strong>
      {/* before the list: users choose the scope, then click a run, which applies it */}
      <RadioGroup inline label="Apply to" selectedValue={scope} onChange={event => setScope(event.currentTarget.value)}>
        <Radio label="This run" value="run"/>
        <Radio label="All runs like this" value="all"/>
      </RadioGroup>
      {candidates.length > 6 && <InputGroup
        size="small"
        autoFocus
        leftIcon="search"
        placeholder="Filter: a name, a setting…"
        aria-label="Filter the reference runs"
        value={filter}
        onChange={event => { setFilter(event.target.value); setActive(0); }}
      />}
    </div>
    <div className="picker-list" role="listbox" aria-label="Reference runs" tabIndex={candidates.length > 6 ? -1 : 0} autoFocus={candidates.length <= 6}>
      {shown.map((c, i) => {
        const facts = preferences_for(c.o, output);
        const metric_line = metric_text(output, c.o, metric);
        return <div key={c.o.id} role="presentation">
          {(i === 0 || shown[i - 1].kind !== c.kind) && <div role="presentation" className={`picker-group ${Classes.TEXT_MUTED}`}>{group_title(c.kind, output)}</div>}
          <button
            type="button"
            role="option"
            aria-selected={c.o === current}
            aria-label={c.o.test_input_path}
            className={`picker-item${i === index ? ' active' : ''}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(c)}
          >
            <Icon icon={c.o === current ? 'record' : 'circle'} size={12} style={{ marginTop: 3, color: c.o === current ? 'var(--qa-side-1)' : undefined }} className={c.o === current ? undefined : Classes.TEXT_MUTED}/>
            {/* names paired or alike: what changes from the run's name, like settings' changes */}
            <span className="picker-name">{c.kind === 'pair' || c.kind === 'similar'
              ? <TextChange before={output.test_input_path ?? ''} after={c.o.test_input_path ?? ''}/>
              : c.o.test_input_path}</span>
            <span className={`picker-metric ${Classes.TEXT_MUTED}`}>{metric_line}</span>
            <span className={`picker-why ${Classes.TEXT_MUTED}`}>
              {c.o === current && <span className="picker-in-use">in use</span>}
              {facts.slice(0, 3).map(f => <span key={f.key} className="picker-fact">{fact_text(f)}</span>)}
              {facts.length > 3 && <span>+{facts.length - 3}</span>}
              {!facts.length && c.kind !== 'similar' && c.o.test_input_path === output.test_input_path && <span>same settings</span>}
            </span>
          </button>
        </div>;
      })}
      {!shown.length && <div role="presentation" className={Classes.TEXT_MUTED} style={{ padding: '6px 8px' }}>{candidates.length ? 'No reference run matches the filter' : 'No reference run on this input, with its id, or with a similar name'}</div>}
      {candidates.length > shown.length && !filter && <div role="presentation" className={Classes.TEXT_MUTED} style={{ padding: '6px 8px', fontSize: 12 }}>{candidates.length - shown.length} more: filter to find them</div>}
    </div>
    <div className="picker-foot">
      <span className={`picker-hint ${Classes.TEXT_MUTED}`}>{hint}</span>
      <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <a href={`${docs_root ?? ''}docs/user-guide/reference-runs`} target="_blank" rel="noopener noreferrer">How runs find their reference ↗</a>
        {output.reference_match?.by === 'pin' && <Button size="small" variant="minimal" text="Use the default for this run" onClick={() => {
          onClose();
          save_rules(rules, without_pin(rules, output.id), `${runName(output)} compares with its default reference run again`);
        }}/>}
      </span>
    </div>
  </Picker>;
}
