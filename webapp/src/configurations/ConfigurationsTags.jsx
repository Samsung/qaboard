// Runs' configurations as tags: one per setting. Runs shown together only show what's specific to them,
// what all runs share is behind a "··· N shared" tag. Compared to a reference run, settings are
// marked as added (+), removed (−) or changed (old → new), and hovering any tag explains it.
import { createContext, useContext, useState } from "react";
import styled from "styled-components";
import {
  Button,
  Classes,
  Colors,
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
import { config_tokens, diff_configurations, count_changes, string_change, change_key, hidden_keys } from "./tokens";


// What all the runs on the page share (see shared_configuration), null when we show a single run
export const SharedConfigurationContext = createContext(null);
export const useSharedConfiguration = () => useContext(SharedConfigurationContext);
export const useHideSharedSettings = () => usePrefsStore(state => state.hide_shared_settings);


// The configuration in the format of tuning's search spaces
export const tuning_format = configurations => {
  const merged = {};
  configurations.forEach(config => {
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

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const shorten = (text, n = 60) => text.length > n ? `${text.slice(0, n - 1)}…` : text;
const shorten_start = (text, n = 24) => text.length > n ? `…${text.slice(-(n - 4))}` : text;
const shorten_end = (text, n = 24) => text.length > n ? `${text.slice(0, n - 4)}…` : text;
const setting_text = token => token.kind === 'param' ? `${token.key}: ${token.text}` : token.text;


const Was = styled.del`
  text-decoration: line-through;
  opacity: 0.65;
`;
const Now = styled.ins`
  text-decoration: none;
  font-weight: 600;
`;
const Arrow = () => <span aria-hidden="true" style={{ margin: '0 3px', opacity: 0.6 }}>→</span>;

// "isp.awb.gain": the path is lighter than the key
const Key = ({ name }) => {
  const dot = name.lastIndexOf('.');
  return <>
    {dot > 0 && <span style={{ opacity: 0.65 }}>{name.slice(0, dot + 1)}</span>}
    <strong>{name.slice(dot + 1)}</strong>:{' '}
  </>;
};

// A setting, or how it changed
export const SettingText = ({ d, full = false }) => {
  const { op, token, ref } = d;
  const short = full ? (x => x) : shorten;
  if (op === 'changed' && token.kind === 'param')
    return <><Key name={token.key} /><Was>{short(ref.text)}</Was><Arrow /><Now>{short(token.text)}</Now></>;
  if (op === 'changed') {
    const { prefix, before, after, suffix } = string_change(ref.text, token.text);
    return <>
      {full ? prefix : shorten_start(prefix)}
      {before && <Was>{short(before)}</Was>}
      {before && after && <Arrow />}
      {after && <Now>{short(after)}</Now>}
      {full ? suffix : shorten_end(suffix)}
    </>;
  }
  const text = token.kind === 'param' ? <><Key name={token.key} />{short(token.text)}</> : short(token.text);
  return op === 'removed' ? <Was style={{ opacity: 1 }}>{text}</Was> : text;
};


const op_style = {
  added: { intent: Intent.SUCCESS, icon: 'plus' },
  removed: { intent: Intent.DANGER, icon: 'minus' },
  changed: { intent: Intent.WARNING },
};

// What hovering a setting tells
const Explanation = ({ d, shared }) => {
  const { op, token, ref } = d;
  const status = {
    added: [Intent.SUCCESS, 'plus', 'Added', "The reference run doesn't have this setting."],
    removed: [Intent.DANGER, 'minus', 'Removed', 'Only the reference run has this setting.'],
    changed: [Intent.WARNING, 'exchange', 'Changed', 'The reference run has another value.'],
  }[op] ?? (shared ? [Intent.NONE, 'people', 'Shared', `All ${shared.runs} runs have this setting.`] : null);
  const long = token.text.length > 60 || (ref?.text.length ?? 0) > 60;
  if (!status && !long) return null;
  return <div style={{ padding: '6px 8px', maxWidth: 420 }}>
    {status && <p style={{ margin: 0 }}>
      <Icon icon={status[1]} intent={status[0]} size={12} style={{ marginRight: 5 }} />
      <strong>{status[2]}</strong>: {status[3]}
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

const CopyMenu = ({ d, configurations, shared }) => {
  const { token } = d;
  const item = configurations[token.item];
  const tuning = tuning_format(configurations);
  const explanation = <Explanation d={d} shared={shared} />;
  return <Menu>
    {explanation}
    {explanation && <MenuDivider />}
    <MenuItem icon="duplicate" text="Copy this setting" onClick={() => copyWithToast(setting_text(token))} />
    {d.op !== 'removed' && token.kind === 'param' && typeof item === 'object' && <MenuItem
      icon="duplicate"
      text="Copy its group as JSON"
      onClick={() => copyWithToast(JSON.stringify(item, null, 2))}
    />}
    <MenuItem
      icon="duplicate"
      text="Copy full configuration"
      onClick={() => copyWithToast(JSON.stringify(configurations, null, 2), { what: 'the configuration' })}
    />
    {tuning && <MenuItem
      icon="duplicate"
      text="Copy full configuration in tuning format"
      onClick={() => copyWithToast(tuning, { what: 'the configuration in tuning format' })}
    />}
  </Menu>;
};


const wrapper_style = { marginRight: '5px', marginBottom: '3px', fontWeight: 400, maxWidth: '100%' };

const Setting = ({ d, configurations, intent, inverted, interactive, muted, shared }) => {
  const { icon, intent: op_intent } = op_style[d.op] ?? {};
  const tag = <Tag
    round
    minimal={!inverted}
    interactive={interactive}
    intent={op_intent ?? (muted ? Intent.NONE : intent)}
    icon={icon}
    style={wrapper_style}
    // the browser's search (Ctrl+F) finds it, and the hover menu explains
    aria-label={d.op === 'same' ? undefined : `${d.op}: ${setting_text(d.token)}`}
  >
    <SettingText d={d} />
  </Tag>;
  if (!interactive) return tag;
  return <PopoverNext
    placement="bottom"
    hoverCloseDelay={200}
    interactionKind="hover"
    content={<CopyMenu d={d} configurations={configurations} shared={muted ? shared : null} />}
  >
    {tag}
  </PopoverNext>;
};


const GapTag = styled(Tag)`
  &&& {
    background: transparent;
    box-shadow: none;
    border: 1px dashed ${Colors.GRAY3};
    color: ${Colors.GRAY1};
    cursor: pointer;
  }
  .${Classes.DARK} &&& {
    color: ${Colors.GRAY4};
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
const Gap = ({ tokens, changes, shared, configurations, onShow }) => {
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
        icon="duplicate"
        text="Copy full configuration"
        onClick={() => copyWithToast(JSON.stringify(configurations, null, 2), { what: 'the configuration' })}
      />
      <p className={Classes.TEXT_MUTED} style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
        The top of the page lists them. To always show them, use the controls panel.
      </p>
    </div>}
  >
    <GapTag round minimal icon="more" style={wrapper_style} aria-label={`${label}, hidden. Click to show them.`} onClick={onShow}>
      {tokens.length > 0 ? `${tokens.length} shared` : `${plural(changes.length, 'change')} in all runs`}
    </GapTag>
  </PopoverNext>;
};


/**
 * A run's configuration.
 * - reference: the configuration of its reference run, when it's different (as in output.reference_mismatch)
 * - collapse: when we show many runs (see SharedConfigurationContext), hide the settings they all share,
 *   and the changes from the reference they all have. They're behind a "··· N shared" tag, first.
 */
export const ConfigurationsTags = ({ configurations, reference = null, inverted, intent = Intent.PRIMARY, toplevel = true, collapse = true }) => {
  const shared = useSharedConfiguration();
  const hide_shared = useHideSharedSettings();
  const [show_shared, setShowShared] = useState(false);
  configurations = configurations ?? [];
  const ops = reference
    ? diff_configurations(configurations, reference)
    : config_tokens(configurations).map(token => ({ op: 'same', token }));

  const is_shared = d => !!shared && d.op === 'same' && shared.keys.has(d.token.full);
  const in_all_runs = d => d.op !== 'same' && !!shared?.changes_in_all_runs?.has(change_key(d));
  // what all runs share is less important (we don't grey out short configurations all runs have, like "base")
  const mute_shared = !!shared && (shared.varies || shared.collapse);
  const can_hide = collapse && toplevel && !!shared && hide_shared;
  const hides_shared = can_hide && shared.collapse;
  const hidden_tokens = [];
  const hidden_changes = [];
  const items = [];
  ops.forEach((d, idx) => {
    const shared_setting = is_shared(d);
    if (!show_shared && hides_shared && shared_setting) return hidden_tokens.push(d.token);
    if (!show_shared && can_hide && in_all_runs(d)) return hidden_changes.push(d);
    items.push(<Setting
      key={idx}
      d={d}
      configurations={configurations}
      intent={intent}
      inverted={inverted}
      interactive={toplevel}
      muted={mute_shared && shared_setting}
      shared={shared}
    />);
  });
  if (hidden_tokens.length > 0 || hidden_changes.length > 0)
    items.unshift(<Gap
      key="hidden"
      tokens={hidden_tokens}
      changes={hidden_changes}
      shared={shared}
      configurations={configurations}
      onShow={() => setShowShared(true)}
    />);
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
const ValueChange = ({ d }) => <SettingText
  d={{ op: 'changed', token: { ...d.token, kind: 'string' }, ref: { ...d.ref, kind: 'string' } }}
  full
/>;

const Legend = () => <p className={Classes.TEXT_MUTED} style={{ fontSize: 12, margin: '8px 0 0 0' }}>
  <strong>+</strong> only in this run · <strong>−</strong> only in the reference run · <strong>~</strong> changed: reference → this run
</p>;

// A run's configuration compared with its reference's, like `git diff`: the changes, with a setting around them
export const ConfigurationDiff = ({ configurations, reference, context = 1 }) => {
  const [show_all, setShowAll] = useState(false);
  const ops = diff_configurations(configurations ?? [], reference ?? []);
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
        ? <><td className="key"><Key name={token.key} /></td><td>{op === 'changed' ? <ValueChange d={d} /> : token.text}</td></>
        : <td colSpan={2}>{op === 'changed' ? <SettingText d={d} full /> : token.text}</td>}
    </tr>);
  });
  flush();
  const summary = [
    changes.changed > 0 && `${changes.changed} changed`,
    changes.added > 0 && `${changes.added} added`,
    changes.removed > 0 && `${changes.removed} removed`,
  ].filter(Boolean).join(', ');
  return <div style={{ padding: 10, maxWidth: 560, minWidth: 280 }}>
    <p style={{ marginBottom: 8 }}>
      <strong>Configuration compared to the reference run</strong>
      {summary && <span className={Classes.TEXT_MUTED}>: {summary}</span>}
    </p>
    <DiffTable className={Classes.MONOSPACE_TEXT}><tbody>{rows}</tbody></DiffTable>
    <Legend />
  </div>;
};
