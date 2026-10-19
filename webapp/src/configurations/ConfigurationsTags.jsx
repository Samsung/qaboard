// Runs' settings as tags: one per setting of their configuration, then of their tuning parameters.
// Runs shown together only show what's specific to them: what all runs share is behind a "··· N shared" tag.
// Compared to a reference run, settings are marked as added (+), removed (−) or changed (old → new),
// and hovering any tag explains it.
import { createContext, useContext, useState } from "react";
import styled from "styled-components";
import {
  Button,
  Classes,
  Icon,
  Intent,
  Menu,
  MenuDivider,
  MenuItem,
  PopoverNext,
  Tag,
} from "@blueprintjs/core";

import { copyWithToast } from "../utils/clipboard";
import { usePrefsStore } from "../stores/prefs";
import { run_tokens, reference_tokens, diff_tokens, count_changes, string_change, change_key, format_value, value_separator, hidden_keys } from "./tokens";


// What all the runs on the page share (see shared_configuration), null when we show a single run
export const SharedConfigurationContext = createContext(null);
export const useSharedConfiguration = () => useContext(SharedConfigurationContext);
export const useHideSharedSettings = () => usePrefsStore(state => state.hide_shared_settings);


// The settings in the format of tuning's search spaces
export const tuning_format = items => {
  const merged = {};
  items.forEach(config => {
    if (typeof config === 'object' && config !== null) {
      Object.entries(config)
        .filter(([k]) => !hidden_keys.includes(k))
        .forEach(([key, value]) => {
          // numeric vectors would be read as a list of values to try
          merged[key] = Array.isArray(value) && value.every(item => typeof item === 'number') ? [[[value]]] : [value];
        });
    }
  });
  return Object.keys(merged).length > 0 ? JSON.stringify(merged, null, 2) : null;
};

const shell_quote = text => /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
// The options of `qa` that run with these settings, e.g. -c base -c '{"gain": 4}' --tuning '{"nr": 2}'
export const qa_options = (configurations, tuning) => [
  ...(configurations ?? []).map(c => `-c ${shell_quote(typeof c === 'string' ? c : JSON.stringify(c))}`),
  ...(has_tuning(tuning) ? [`--tuning ${shell_quote(JSON.stringify(tuning))}`] : []),
].join(' ');

const has_tuning = tuning => !!tuning && Object.keys(tuning).length > 0;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const shorten = (text, n = 60) => text.length > n ? `${text.slice(0, n - 1)}…` : text;
const shorten_start = (text, n = 24) => text.length > n ? `…${text.slice(-(n - 4))}` : text;
const shorten_end = (text, n = 24) => text.length > n ? `${text.slice(0, n - 4)}…` : text;
export const setting_text = token => token.kind === 'param' ? `${token.key}: ${token.display}` : token.text;
// "isp.nr.strength": 2 as {"isp": {"nr": {"strength": 2}}}, "layers[1].type" as {"layers": [null, {"type": ...}]}
const setting_json = token => {
  const path = token.key.split(/\.|(?=\[)/).map(part => part.startsWith('[') ? Number(part.slice(1, -1)) : part);
  return JSON.stringify(path.reduceRight((value, key) => {
    if (typeof key !== 'number') return { [key]: value };
    const array = Array(key + 1).fill(null);
    array[key] = value;
    return array;
  }, token.value));
};

// Long lists show their first values, and their size: [0, 0.1, 0.2, …] 256 values, [[1, 0, 0], …] 3×3
const max_value_length = 48;
const list_size = list => list.length > 0 && list.every(row => Array.isArray(row) && row.length === list[0].length)
  ? `${list.length}×${list[0].length}`
  : `${list.length} values`;
const ShortValue = ({ token }) => {
  const { display, value } = token;
  if (display.length <= max_value_length) return display;
  if (!Array.isArray(value)) return shorten(display, max_value_length);
  const items = [];
  let length = 0;
  for (const item of value) {
    const text = format_value(item);
    if (items.length > 0 && length + text.length > max_value_length - 12) break;
    items.push(shorten(text, max_value_length - 12));
    length += text.length + 2;
  }
  return <>[{items.join(', ')}, …] <span style={{ opacity: 0.65 }}>{list_size(value)}</span></>;
};


const Was = styled.del`
  text-decoration: line-through;
  opacity: 0.65;
`;
const Now = styled.ins`
  text-decoration: none;
  font-weight: 600;
`;
const Arrow = () => <span aria-hidden="true" style={{ margin: '0 3px', opacity: 0.6 }}>→</span>;

// Tuning parameters are settings like the others, with a wrench
const TuningMark = () => <Icon icon="wrench" size={10} title="Tuning parameter" style={{ opacity: 0.6, marginRight: 4, verticalAlign: 'baseline' }} />;

// "isp.awb.gain": the path is lighter than the key
const Key = ({ token }) => {
  const name = token.key;
  const dot = name.lastIndexOf('.');
  return <>
    {token.source === 'tuning' && <TuningMark />}
    {dot > 0 && <span style={{ opacity: 0.65 }}>{name.slice(0, dot + 1)}</span>}
    <strong>{name.slice(dot + 1)}</strong>:{' '}
  </>;
};

// A setting, or how it changed. `elide`: hide that many characters of a string, e.g. a long folder all runs share
// `value_only`: a changed setting's value, without its key
export const SettingText = ({ d, full = false, elide = 0, value_only = false }) => {
  const { op, token, ref } = d;
  const short = full ? (x => x) : shorten;
  // long values, e.g. lists: only where they changed, [1, 0.98, 0.95 → 0.9]
  const key = !value_only && token.kind === 'param' && <Key token={token} />;
  if (op === 'changed' && token.kind === 'param' && Math.max(ref.display.length, token.display.length) <= 24)
    return <>{key}<Was>{ref.display}</Was><Arrow /><Now>{token.display}</Now></>;
  if (op === 'changed' && token.kind === 'param') {
    const { prefix, before, after, suffix } = string_change(ref.display, token.display, value_separator);
    return <>
      {key}
      {full ? prefix : shorten_start(prefix, 16)}
      {before && <Was>{short(before)}</Was>}
      {before && after && <Arrow />}
      {after && <Now>{short(after)}</Now>}
      {full ? suffix : shorten_end(suffix, 16)}
    </>;
  }
  if (op === 'changed') {
    const { prefix, before, after, suffix } = string_change(ref.display, token.display);
    return <>
      {full ? prefix : shorten_start(prefix)}
      {before && <Was>{short(before)}</Was>}
      {before && after && <Arrow />}
      {after && <Now>{short(after)}</Now>}
      {full ? suffix : shorten_end(suffix)}
    </>;
  }
  const string = elide > 0 && !full ? `…${token.text.slice(elide)}` : token.text;
  const text = token.kind === 'param' ? <><Key token={token} />{full ? token.display : <ShortValue token={token} />}</> : short(string);
  return op === 'removed' ? <Was style={{ opacity: 1 }}>{text}</Was> : text;
};


const op_style = {
  added: { intent: Intent.SUCCESS, icon: 'plus' },
  removed: { intent: Intent.DANGER, icon: 'minus' },
  changed: { intent: Intent.WARNING },
};

// What hovering a setting tells
const Explanation = ({ d, shared, elided }) => {
  const { op, token, ref } = d;
  const status = {
    added: [Intent.SUCCESS, 'plus', 'Added', "The reference run doesn't have this setting."],
    removed: [Intent.DANGER, 'minus', 'Removed', 'Only the reference run has this setting.'],
    changed: [Intent.WARNING, 'exchange', 'Changed', 'The reference run has another value.'],
  }[op] ?? (shared ? [Intent.NONE, 'people', 'Shared', `All ${shared.runs} runs have this setting.`] : null);
  const tuning = token.source === 'tuning';
  const long = elided || token.display.length > max_value_length || (ref?.display.length ?? 0) > max_value_length;
  if (!status && !long && !tuning) return null;
  return <div style={{ padding: '6px 8px', maxWidth: 420 }}>
    {status && <p style={{ margin: 0 }}>
      <Icon icon={status[1]} intent={status[0]} size={12} style={{ marginRight: 5 }} />
      <strong>{status[2]}</strong>: {status[3]}
    </p>}
    {tuning && <p className={Classes.TEXT_MUTED} style={{ margin: status ? '4px 0 0 0' : 0 }}>
      <TuningMark />Tuning parameter (<code>qa --tuning</code>): applied after the configuration.
    </p>}
    {(op === 'changed' || long) && <table className={Classes.MONOSPACE_TEXT} style={{ fontSize: 12, marginTop: 4, borderSpacing: '6px 2px' }}>
      <tbody>
        {op === 'changed' && <tr><td className={Classes.TEXT_MUTED}>Reference</td><td style={{ wordBreak: 'break-all' }}>{setting_text(ref)}</td></tr>}
        <tr>
          {op === 'changed' && <td className={Classes.TEXT_MUTED}>This run</td>}
          <td colSpan={op === 'changed' ? 1 : 2} style={{ wordBreak: 'break-all' }}>{setting_text(token)}</td>
        </tr>
      </tbody>
    </table>}
  </div>;
};

// Copy the settings: as text, JSON, `qa` options, or a tuning search space
const CopyAllItems = ({ configurations, tuning }) => {
  const search_space = tuning_format([...configurations, tuning]);
  return <>
    <MenuItem
      icon="console"
      text="Copy as qa options"
      label={<code>-c … --tuning …</code>}
      onClick={() => copyWithToast(qa_options(configurations, tuning), { what: 'the qa options' })}
    />
    <MenuItem
      icon="duplicate"
      text="Copy configuration as JSON"
      onClick={() => copyWithToast(JSON.stringify(configurations, null, 2), { what: 'the configuration' })}
    />
    {has_tuning(tuning) && <MenuItem
      icon="duplicate"
      text="Copy tuning parameters as JSON"
      onClick={() => copyWithToast(JSON.stringify(tuning, null, 2), { what: 'the tuning parameters' })}
    />}
    {search_space && <MenuItem
      icon="duplicate"
      text="Copy as a tuning search space"
      onClick={() => copyWithToast(search_space, { what: 'the tuning search space' })}
    />}
  </>;
};

const CopyMenu = ({ d, configurations, tuning, shared, elided }) => {
  const { token } = d;
  const explanation = <Explanation d={d} shared={shared} elided={elided} />;
  return <Menu>
    {explanation}
    <MenuDivider title={d.op === 'removed' ? "This setting (the reference's)" : "This setting"} />
    <MenuItem icon="duplicate" text="Copy" label={<code>{shorten(setting_text(token), 30)}</code>} onClick={() => copyWithToast(setting_text(token))} />
    {token.kind === 'param' && <MenuItem icon="duplicate" text="Copy as JSON" onClick={() => copyWithToast(setting_json(token))} />}
    <MenuDivider title="This run" />
    <CopyAllItems configurations={configurations} tuning={tuning} />
  </Menu>;
};


const wrapper_style = { marginRight: '5px', marginBottom: '3px', fontWeight: 400, maxWidth: '100%' };

const Setting = ({ d, configurations, tuning, intent, inverted, interactive, muted, shared }) => {
  const { icon, intent: op_intent } = op_style[d.op] ?? {};
  const elide = d.token.kind === 'string' ? shared?.elided?.get(d.token.text) ?? 0 : 0;
  const Component = muted && !op_intent ? SharedTag : Tag;
  const tag = <Component
    round
    minimal={!inverted}
    interactive={interactive}
    intent={op_intent ?? (muted ? Intent.NONE : intent)}
    icon={icon}
    style={wrapper_style}
    // the browser's search (Ctrl+F) finds it, and the hover menu explains
    aria-label={d.op === 'same' ? undefined : `${d.op}: ${setting_text(d.token)}`}
  >
    <SettingText d={d} elide={d.op === 'changed' ? 0 : elide} />
  </Component>;
  if (!interactive) return tag;
  return <PopoverNext
    placement="bottom"
    hoverCloseDelay={200}
    interactionKind="hover"
    content={<CopyMenu d={d} configurations={configurations} tuning={tuning} shared={muted ? shared : null} elided={elide > 0} />}
  >
    {tag}
  </PopoverNext>;
};


// Settings all runs share: outlined when they're shown, dashed when they're hidden
const SharedTag = styled(Tag)`
  &&& {
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--qa-border);
    color: var(--qa-text-muted);
  }
`;
const GapTag = styled(Tag)`
  &&& {
    background: transparent;
    box-shadow: none;
    border: 1px dashed currentColor;
    color: var(--qa-text-muted);
    cursor: pointer;
  }
  &&&:hover {
    background: var(--qa-hover);
    color: var(--qa-text);
  }
`;

// The settings all runs share, as muted tags
export const SharedSettings = ({ tokens, limit }) => {
  const shown = limit ? tokens.slice(0, limit) : tokens;
  return <>
    {shown.map(token => <Tag key={token.full} round minimal style={wrapper_style}>
      <SettingText d={{ op: 'same', token }} />
    </Tag>)}
  </>;
};

const ChangesInAllRuns = ({ changes }) => <>
  {changes.map((d, i) => <Tag key={i} round minimal {...op_style[d.op]} style={wrapper_style}><SettingText d={d} /></Tag>)}
</>;

// What we hide in a run: hover to see it, click to show it
const Gap = ({ tokens, changes, shared, configurations, tuning, onShow }) => {
  const label = tokens.length > 0
    ? `${plural(tokens.length, 'setting')} shared by all ${shared.runs} runs`
    : `${plural(changes.length, 'change')} from the reference that all runs have`;
  return <PopoverNext
    placement="bottom"
    hoverOpenDelay={150}
    hoverCloseDelay={200}
    interactionKind="hover"
    content={<div style={{ padding: 10, maxWidth: 460 }}>
      <p style={{ marginBottom: 6 }}>
        <Icon icon="eye-off" size={12} style={{ marginRight: 5 }} />
        Hidden to show what's specific to this run:
      </p>
      <div style={{ maxHeight: 240, overflowY: 'auto', marginBottom: 8 }}>
        {tokens.length > 0 && <>
          <p className={Classes.TEXT_MUTED} style={{ margin: '4px 0' }}>{plural(tokens.length, 'setting')} all {shared.runs} runs share</p>
          <SharedSettings tokens={tokens} />
        </>}
        {changes.length > 0 && <>
          <p className={Classes.TEXT_MUTED} style={{ margin: '4px 0' }}>{plural(changes.length, 'change')} from the reference all runs have</p>
          <ChangesInAllRuns changes={changes} />
        </>}
      </div>
      <Button size="small" icon="eye-open" text="Show them" onClick={onShow} style={{ marginRight: 5 }} />
      <Button
        size="small"
        variant="minimal"
        icon="console"
        text="Copy as qa options"
        onClick={() => copyWithToast(qa_options(configurations, tuning), { what: 'the qa options' })}
      />
      <p className={Classes.TEXT_MUTED} style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
        The top of the page lists them. To always show them, use the View options panel (press o).
      </p>
    </div>}
  >
    <GapTag round minimal icon="more" style={wrapper_style} aria-label={`${label}, hidden. Click to show them.`} onClick={onShow}>
      {tokens.length > 0 ? `${tokens.length} shared` : `${plural(changes.length, 'change')} in all runs`}
    </GapTag>
  </PopoverNext>;
};


/**
 * A run's settings: its configuration's, then its tuning parameters'.
 * - mismatch: how its reference run differs (output.reference_mismatch): we mark how the settings differ
 * - collapse: when we show many runs (see SharedConfigurationContext), hide the settings they all share,
 *   and the changes from the reference they all have. They're behind "··· N shared" tags, where they are
 *   when they're at the start or the end, else in one tag, first.
 */
export const ConfigurationsTags = ({ configurations, tuning = null, mismatch = null, inverted, intent = Intent.NONE, toplevel = true, collapse = true }) => {
  const shared = useSharedConfiguration();
  const hide_shared = useHideSharedSettings();
  const [show_shared, setShowShared] = useState(false);
  configurations = configurations ?? [];
  const tokens = run_tokens(configurations, tuning);
  const reference = mismatch ? reference_tokens({ configurations, extra_parameters: tuning, reference_mismatch: mismatch }) : null;
  const ops = reference ? diff_tokens(tokens, reference) : tokens.map(token => ({ op: 'same', token }));

  const is_shared = d => !!shared && d.op === 'same' && shared.keys.has(d.token.full);
  const in_all_runs = d => d.op !== 'same' && !!shared?.changes_in_all_runs?.has(change_key(d));
  // what all runs share is less important (we don't grey out short configurations all runs have, like "base")
  const mute_shared = !!shared && (shared.varies || shared.collapse);
  const can_hide = collapse && toplevel && !!shared && hide_shared && !show_shared;

  // [setting] or a block of hidden settings {tokens, changes}
  const entries = [];
  ops.forEach((d, idx) => {
    const shared_setting = is_shared(d);
    const hidden_token = can_hide && shared.collapse && shared_setting;
    const hidden_change = can_hide && in_all_runs(d);
    if (hidden_token || hidden_change) {
      let block = entries.at(-1);
      if (!block?.hidden) entries.push(block = { hidden: true, tokens: [], changes: [] });
      if (hidden_token) block.tokens.push(d.token);
      else block.changes.push(d);
      return;
    }
    entries.push(<Setting
      key={idx}
      d={d}
      configurations={configurations}
      tuning={tuning}
      intent={intent}
      inverted={inverted}
      interactive={toplevel}
      muted={mute_shared && shared_setting}
      shared={shared}
    />);
  });
  // Hidden settings stay where they are when they're a prefix and/or a suffix: more blocks would be noisy
  const blocks = entries.filter(e => e.hidden);
  const in_place = blocks.length <= 1 || (blocks.length === 2 && entries[0].hidden && entries.at(-1).hidden);
  const gap = (block, key) => <Gap
    key={key}
    tokens={block.tokens}
    changes={block.changes}
    shared={shared}
    configurations={configurations}
    tuning={tuning}
    onShow={() => setShowShared(true)}
  />;
  const items = in_place
    ? entries.map((e, i) => e.hidden ? gap(e, `gap-${i}`) : e)
    : [
      gap({ tokens: blocks.flatMap(b => b.tokens), changes: blocks.flatMap(b => b.changes) }, 'gap'),
      ...entries.filter(e => !e.hidden),
    ];
  if (show_shared)
    items.push(<Tag key="hide" round minimal interactive icon="eye-off" style={wrapper_style} onClick={() => setShowShared(false)}>
      Hide shared
    </Tag>);

  if (!toplevel) return items;
  return <span>{items}</span>;
};


const row_colors = {
  added: 'rgba(35, 133, 81, 0.15)',
  removed: 'rgba(205, 66, 70, 0.15)',
  changed: 'rgba(200, 118, 25, 0.15)',
};
const signs = { added: '+', removed: '−', changed: '~', same: '' };

const DiffTable = styled.table`
  border-collapse: collapse;
  font-size: 12px;
  width: 100%;
  td {
    padding: 2px 8px;
    vertical-align: top;
    word-break: break-all;
  }
  td.sign {
    width: 1em;
    font-weight: 600;
    text-align: center;
  }
  td.key {
    width: 1%;
    white-space: nowrap;
  }
`;

// e.g. [1, 2, 3] → [1, 2, 4] highlights only the last number
const ValueChange = ({ d }) => <SettingText d={d} full value_only />;

const Legend = () => <p className={Classes.TEXT_MUTED} style={{ fontSize: 12, margin: '8px 0 0 0' }}>
  <strong>+</strong> only in this run · <strong>−</strong> only in the reference run · <strong>~</strong> changed: reference → this run
  {' '}· <TuningMark />tuning parameter
</p>;

// As text, like `git diff`
const diff_text = ops => ops.filter(d => d.op !== 'same').flatMap(d => d.op === 'changed'
  ? [`- ${setting_text(d.ref)}`, `+ ${setting_text(d.token)}`]
  : [`${d.op === 'added' ? '+' : '-'} ${setting_text(d.token)}`]).join('\n');

// A run's settings compared with its reference's, like `git diff`: the changes, with a setting around them
export const ConfigurationDiff = ({ configurations, tuning = null, mismatch, context = 1 }) => {
  const [show_all, setShowAll] = useState(false);
  configurations = configurations ?? [];
  const reference = reference_tokens({ configurations, extra_parameters: tuning, reference_mismatch: mismatch }) ?? [];
  const ops = diff_tokens(run_tokens(configurations, tuning), reference);
  const changes = count_changes(ops);
  const near_change = i => ops.slice(Math.max(0, i - context), i + context + 1).some(d => d.op !== 'same');
  const rows = [];
  let hidden = 0;
  const flush = () => {
    if (hidden === 0) return;
    rows.push(<tr key={`gap-${rows.length}`} className={Classes.TEXT_MUTED}>
      <td className="sign"><Icon icon="more" size={12} /></td>
      <td colSpan={2}>
        <Button
          size="small"
          variant="minimal"
          text={plural(hidden, 'unchanged setting')}
          title="Show all the settings"
          onClick={() => setShowAll(true)}
          style={{ minHeight: 0, padding: '0 4px', fontSize: 12 }}
        />
      </td>
    </tr>);
    hidden = 0;
  };
  ops.forEach((d, i) => {
    if (!show_all && !near_change(i)) {
      hidden++;
      return;
    }
    flush();
    const { op, token } = d;
    rows.push(<tr key={i} style={{ background: row_colors[op] }} className={op === 'same' ? Classes.TEXT_MUTED : undefined}>
      <td className="sign" aria-label={op}>{signs[op]}</td>
      {token.kind === 'param'
        ? <><td className="key"><Key token={token} /></td><td>{op === 'changed' ? <ValueChange d={d} /> : token.display}</td></>
        : <td colSpan={2}>{op === 'changed' ? <SettingText d={d} full /> : token.text}</td>}
    </tr>);
  });
  flush();
  const summary = [
    changes.changed > 0 && `${changes.changed} changed`,
    changes.added > 0 && `${changes.added} added`,
    changes.removed > 0 && `${changes.removed} removed`,
  ].filter(Boolean).join(', ');
  const ref_configurations = mismatch?.configurations ?? configurations;
  const ref_tuning = mismatch?.extra_parameters ?? tuning;
  return <div style={{ padding: 10, maxWidth: 560, minWidth: 280 }}>
    <p style={{ marginBottom: 8 }}>
      <strong>Settings compared to the reference run</strong>
      {summary && <span className={Classes.TEXT_MUTED}>: {summary}</span>}
    </p>
    <DiffTable className={Classes.MONOSPACE_TEXT}><tbody>{rows}</tbody></DiffTable>
    <Legend />
    {mismatch?.alternatives > 0 && <p style={{ fontSize: 12, margin: '8px 0 0 0' }}>
      <Icon icon="git-branch" size={12} intent={Intent.WARNING} style={{ marginRight: 5 }} />
      {mismatch.alternatives === 1 ? 'Another reference run differs' : `${mismatch.alternatives} other reference runs differ`} by
      as many settings: we picked the one with the closest values.
    </p>}
    <div style={{ marginTop: 8 }}>
      <Button size="small" variant="minimal" icon="duplicate" text="Copy the changes" onClick={() => copyWithToast(diff_text(ops), { what: 'the changes' })} />
      <Button
        size="small"
        variant="minimal"
        icon="console"
        text="Copy the reference's qa options"
        onClick={() => copyWithToast(qa_options(ref_configurations, ref_tuning), { what: "the reference's qa options" })}
      />
    </div>
  </div>;
};
