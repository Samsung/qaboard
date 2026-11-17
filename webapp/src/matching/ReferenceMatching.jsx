// Above the runs, next to the settings they share (src/configurations/ConfigurationOverview.jsx): how the runs find
// their reference run. Hidden in the usual case: it shows when runs have no reference, when several reference runs fit
// equally well (tied), or when users changed the rules (src/matching/rules.js), in the URL so that links show the same
// pairs. It suggests the changes of name that pair the runs without reference.
import { useMemo, useState } from "react";
import { AnchorButton, Button, Classes, ControlGroup, Icon, InputGroup, Intent, Tag } from "@blueprintjs/core";

import { useComparison, useSiteConfig } from "../hooks";
import { toaster } from "../toaster";
import { plural } from "../utils/plural";
import { TextChange } from "../configurations/ConfigurationsTags";
import { can_have_reference } from "./match";
import { suggest_pairs, rule_text, name_changes, rule_of_change, paired_by } from "./names";
import { add_rules, fact_text } from "./rules";
import { save_rules } from "./save";

const line_style = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', margin: '1px 0' };
const code_style = { whiteSpace: 'nowrap' };
const no_rules = { pairs: [], prefer: [], pins: {} };

// Typed by users: "reg0x1A=05" and "reg0x1A=03". When they differ by one part, the rule is on that part.
const typed_rule = (from, to) => {
  const changes = name_changes(from, to);
  const rule = changes?.length === 1 ? rule_of_change(changes[0]) : null;
  return rule?.from && rule?.to ? rule : { from, to };
};

// What there is to say about how runs find their reference, null when there's nothing
export const useReferenceMatching = () => {
  const comparison = useComparison();
  const { new_batch, ref_batch, ref_lookup, selected } = comparison ?? {};
  const rules = selected?.reference_rules;
  return useMemo(() => {
    if (!new_batch || !rules || !ref_lookup?.outputs?.length) return null;
    const outputs = (new_batch.filtered?.outputs ?? []).map(id => new_batch.outputs[id]).filter(o => o && can_have_reference(o));
    const without = outputs.filter(o => !o.reference_match);
    const tied = outputs.filter(o => o.reference_match?.tied > 0 && o.reference_match.by !== 'pin' && !o.reference_match.preferred).length;
    // picks for runs shown here: those of other runs (another batch, filtered out) or of reference runs gone don't apply
    const picked = outputs.filter(o => o.reference_match?.by === 'pin').length;
    const stale_picks = Object.keys(rules.pins).length - picked;
    if (!rules.custom && !tied && !without.length) return null;
    const suggestions = without.length
      ? suggest_pairs({ unmatched: without, outputs, index: ref_lookup, labels: { new: new_batch.label, reference: ref_batch?.label }, pairs: rules.pairs })
      : [];
    return { rules, outputs, without: without.length, tied, picked, stale_picks, suggestions, ref_lookup };
  }, [new_batch, ref_batch, ref_lookup, rules]);
};

// The row's values: one line per thing to know, with what users can do about it
export const ReferenceMatchingValues = ({ status }) => {
  const [typing, setTyping] = useState(false);
  const [all_suggestions, setAllSuggestions] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { rules, suggestions } = status;
  const add_pair = (rule, pairs) => save_rules(rules, add_rules(rules, { pairs: [rule] }), `${plural(pairs, 'run')} paired by name: ${rule_text(rule)}`);
  // a change that pairs a single run is often another scene: it's not offered first
  const [first, ...others] = suggestions[0]?.pairs > 1 ? suggestions : [null, ...suggestions];
  const shown_others = all_suggestions ? others : [];

  const suggestion = (s, primary) => <span key={`${s.rule.from}|${s.rule.to}`} style={line_style}>
    <code style={code_style}><TextChange before={s.rule.from} after={s.rule.to}/></code>
    <span className={Classes.TEXT_MUTED}>pairs {plural(s.pairs, 'run')}{s.pairs === 1 && ': check it’s the same scene'}</span>
    <Button size="small" intent={primary ? Intent.PRIMARY : undefined} text="Pair" aria-label={`Pair ${rule_text(s.rule)}`} onClick={() => add_pair(s.rule, s.pairs)}/>
  </span>;

  return <>
    {status.without > 0 && <div style={line_style}>
      <span>
        <Icon icon="disable" size={12} className={Classes.TEXT_MUTED} style={{ marginRight: 5 }}/>
        {plural(status.without, 'run')} {status.without === 1 ? 'has' : 'have'} no reference run.
        {!suggestions.length && <span className={Classes.TEXT_MUTED}> No name change pairs them. Runs with close names say so on their tag.</span>}
      </span>
      {first && <span className={Classes.TEXT_MUTED}>Pair them by name:</span>}
      {first && suggestion(first, true)}
      {others.length > 0 && <Tag round minimal interactive icon={all_suggestions ? 'chevron-up' : 'more'} onClick={() => setAllSuggestions(!all_suggestions)}>
        {all_suggestions ? 'Show less' : plural(others.length, first ? 'other change' : 'change of name')}
      </Tag>}
    </div>}
    {shown_others.length > 0 && <div style={{ ...line_style, paddingLeft: 17 }}>{shown_others.map(s => suggestion(s, false))}</div>}

    {rules.pairs.length > 0 && <div style={line_style}>
      <span className={Classes.TEXT_MUTED}>Paired by name:</span>
      {rules.pairs.map(p => <Tag key={`${p.from}|${p.to}`} minimal intent={Intent.PRIMARY} aria-label={`Paired by name: ${rule_text(p)}`}
        onRemove={() => save_rules(rules, { ...rules, pairs: rules.pairs.filter(q => q !== p) }, `Removed ${rule_text(p)}`)}>
        <code style={code_style}><TextChange before={p.from} after={p.to}/></code>
      </Tag>)}
    </div>}
    {rules.prefer.length > 0 && <div style={line_style}>
      <span className={Classes.TEXT_MUTED}>Preferred reference runs:</span>
      {rules.prefer.map(p => <Tag key={`${p.key}=${p.value}`} minimal intent={Intent.PRIMARY} icon="star"
        onRemove={() => save_rules(rules, { ...rules, prefer: rules.prefer.filter(q => q !== p) }, `Removed the preference for ${fact_text(p)}`)}>{fact_text(p)}</Tag>)}
    </div>}
    {(status.picked > 0 || status.stale_picks > 0) && <div style={line_style}>
      <span>
        {status.picked > 0 && `${plural(status.picked, 'run')} compared with a reference run you picked`}
        {status.picked > 0 && status.stale_picks > 0 && ' · '}
        {status.stale_picks > 0 && <span className={Classes.TEXT_MUTED}>{plural(status.stale_picks, 'pick')} for runs or reference runs not shown here</span>}
      </span>
      <Button size="small" variant="minimal" text="Clear" onClick={() => save_rules(rules, { ...rules, pins: {} }, 'Cleared the reference runs you picked')}/>
    </div>}
    {status.tied > 0 && <div style={line_style} className={Classes.TEXT_MUTED}>
      <span>
        <Icon icon="layers" size={12} style={{ marginRight: 5 }}/>
        {plural(status.tied, 'run')} {status.tied === 1 ? 'has' : 'have'} several reference runs that fit equally well: using the first. Click their <b>1 of N</b> tag to choose.
      </span>
    </div>}

    {typing
      ? <form style={{ ...line_style, maxWidth: 560 }} onSubmit={event => {
          event.preventDefault();
          if (!from.trim() || !to.trim() || from.trim() === to.trim()) return;
          const rule = typed_rule(from.trim(), to.trim());
          const pairs = paired_by(rule, status.outputs, status.ref_lookup);
          if (!pairs) return toaster.show({ message: `No run has "${rule.from}" in its name where "${rule.to}" would make it a reference run's name. Type whole parts, between separators like _ - . = /`, intent: Intent.WARNING, timeout: 8000 });
          add_pair(rule, pairs);
          setFrom(''); setTo(''); setTyping(false);
        }}>
        <ControlGroup fill style={{ flex: '1 1 auto' }}>
          <InputGroup size="small" autoFocus placeholder="Name part in the runs: reg0x1A=05" aria-label="Name part in the runs" value={from} onValueChange={setFrom}/>
          <InputGroup size="small" placeholder="…in the reference runs: reg0x1A=03" aria-label="Name part in the reference runs" value={to} onValueChange={setTo}/>
          <Button size="small" type="submit" text="Pair" disabled={!from.trim() || !to.trim()}/>
          <Button size="small" variant="minimal" text="Cancel" onClick={() => setTyping(false)}/>
        </ControlGroup>
      </form>
      : (status.without > 0 || rules.pairs.length > 0) && <Button size="small" variant="minimal" icon="add" text="Pair other names…" className={Classes.TEXT_MUTED} onClick={() => setTyping(true)} style={{ marginLeft: -6 }}/>}
  </>;
};

export const ReferenceMatchingActions = ({ status }) => {
  const { docs_root } = useSiteConfig();
  const { rules } = status;
  const removed = [
    rules.pairs.length && plural(rules.pairs.length, 'name pair'),
    rules.prefer.length && plural(rules.prefer.length, 'preference'),
    Object.keys(rules.pins).length && plural(Object.keys(rules.pins).length, 'pick'),
  ].filter(Boolean).join(', ');
  return <>
    {rules.custom && <Button
      size="small"
      variant="minimal"
      icon="reset"
      text="Reset to default matching"
      title={`Removes ${removed}. Each run is then compared with the reference run on the same input, else with the same metadata.id, like the checks from the CLI and the API.`}
      onClick={() => save_rules(rules, no_rules, `Back to the default matching: removed ${removed}`)}
    />}
    <AnchorButton
      size="small"
      variant="minimal"
      icon="help"
      className={Classes.TEXT_MUTED}
      aria-label="How runs find their reference run"
      title="How runs find their reference run"
      href={`${docs_root ?? ''}docs/user-guide/reference-runs`}
      target="_blank"
      rel="noopener noreferrer"
    />
  </>;
};
