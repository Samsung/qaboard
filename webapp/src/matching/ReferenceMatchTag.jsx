// On run cards, how the run found its reference run: nothing in the usual case (the same input and settings), a quiet
// tag when it's another input or there's a choice, amber only when there's nothing to compare with. It opens the
// reference picker, as does the run's menu (useReferencePicker). Cards are many: the popover only exists while it's open.
import { lazy, Suspense, useEffect } from "react";
import { Classes, Intent, PopoverNext, Spinner, Tag } from "@blueprintjs/core";

import { useComparison } from "../hooks";
import { useReferencePicker } from "./pickerStore";
import { can_have_reference } from "./match";
import { name_changes, paired_name, rule_of_change, similar_positions } from "./names";
import { fact_text, run_facts } from "./rules";

const ReferencePicker = lazy(() => import("./ReferencePicker"));

const tag_style = { marginLeft: 6, verticalAlign: 'baseline' };
const quiet_style = { ...tag_style, background: 'none' };
const runs = n => `${n} reference run${n === 1 ? '' : 's'}`;

// The tag, or null when there's nothing to say: { text, title, intent, icon, quiet, clickable }.
// The user guide lists them: website/docs/user-guide/reference-runs.mdx#pick-another
export const describe_match = (output, match, reference, ref_lookup, rules) => {
  if (!match) {
    const similar = ref_lookup ? similar_positions(paired_name(output.test_input_path, rules.pairs), ref_lookup).length : 0;
    // with similar names, there's something to do: the tag is quiet, the row above the runs says it too
    return similar
      ? { text: `no reference · ${similar} similar`, icon: 'disable', quiet: true, clickable: true,
          title: `No reference run on this input${output.test_input_metadata?.id ? ' or with its id' : ''}. ${runs(similar)} with a similar name: click to choose.` }
      : { text: 'no reference', icon: 'disable', intent: Intent.WARNING,
          title: 'No reference run on this input, with its id, or with a similar name' };
  }
  if (match.by === 'pin') return { text: 'picked by you', icon: 'pin', clickable: true, title: 'You picked this reference run, for this run only' };
  if (match.preferred && reference) {
    const facts = run_facts(reference);
    const why = rules.prefer.filter(p => facts[p.key] === p.value).map(fact_text).join(', ');
    return { text: why, icon: 'star', clickable: true, title: `Picked because you prefer reference runs with ${why}` };
  }
  if (match.tied > 0) return {
    text: `1 of ${match.tied + 1}`, icon: 'layers', quiet: true, clickable: true,
    title: `${runs(match.tied + 1)} fit equally well. Using the first: click to choose.`,
  };
  if (match.by !== 'id' && match.by !== 'pair') return null;
  // another input: say which. "≈" a metadata.id, "↔" a change of name
  const others = match.others > 0 ? ` ${runs(match.others)} more could do: click to choose.` : '';
  if (match.by === 'id') return {
    text: `≈ ${output.test_input_metadata?.id}${match.others > 0 ? ` · ${match.others + 1}` : ''}`, quiet: true, clickable: match.others > 0,
    title: `Compared with ${reference?.test_input_path}, which has the same metadata.id.${others}`,
  };
  const changes = reference ? name_changes(output.test_input_path ?? '', reference.test_input_path ?? '') : null;
  return {
    text: `↔ ${changes?.length ? changes.map(c => rule_of_change(c).to).join(' ') : reference?.test_input_path}${match.others > 0 ? ` · ${match.others + 1}` : ''}`,
    quiet: true, clickable: match.others > 0,
    title: `Compared with ${reference?.test_input_path}, paired by name.${others}`,
  };
};

export const ReferenceMatchTag = ({ output }) => {
  const comparison = useComparison();
  const is_open = useReferencePicker(state => state.open_for === String(output.id));
  const open = useReferencePicker(state => state.open);
  const close = useReferencePicker(state => state.close);
  // a card that goes away (filtered out, another view) doesn't leave its picker to open again when it's back
  useEffect(() => () => {
    if (useReferencePicker.getState().open_for === String(output.id)) close();
  }, [output.id, close]);
  if (!comparison) return null;
  const { ref_batch, ref_lookup, selected } = comparison;
  // nothing to compare with: no reference runs, or a run that has no reference by nature
  if (!ref_lookup?.outputs?.length || !can_have_reference(output)) return null;

  const reference = ref_batch?.outputs?.[output.reference_id];
  const tag = describe_match(output, output.reference_match, reference, ref_lookup, selected.reference_rules);
  const target = tag
    ? <Tag
        minimal
        interactive={tag.clickable}
        intent={tag.intent}
        icon={tag.icon}
        className={tag.quiet ? Classes.TEXT_MUTED : undefined}
        style={{ ...(tag.quiet ? quiet_style : tag_style), cursor: tag.clickable ? 'pointer' : 'help' }}
        title={tag.title}
        onClick={tag.clickable ? () => open(output.id) : undefined}
        role={tag.clickable ? 'button' : undefined}
        tabIndex={tag.clickable ? 0 : undefined}
        onKeyDown={tag.clickable ? event => (event.key === 'Enter' || event.key === ' ') && open(output.id) : undefined}
        aria-haspopup={tag.clickable ? 'dialog' : undefined}
      >{tag.text}</Tag>
    // opened from the run's menu: the picker needs a target
    : <span aria-hidden="true"/>;
  if (!is_open) return target;
  return <PopoverNext
    isOpen
    placement="bottom-start"
    onClose={close}
    content={<Suspense fallback={<Spinner size={20} style={{ margin: 12 }}/>}><ReferencePicker output={output} onClose={close}/></Suspense>}
  >
    {target}
  </PopoverNext>;
};
