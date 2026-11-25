// The keys of the "Logged media" section, grouped by prefix, to jump to one: kind, how many steps and the last (when
// keys differ there), pins
import { Button, Classes, Icon, InputGroup, Tag } from "@blueprintjs/core";

import { KIND_ICONS } from "./kinds";
import { formatStep } from "./media";

export const FILTER_FROM = 6;
const link_style = { border: 'none', background: 'none', padding: 0, color: 'inherit', font: 'inherit', fontSize: 12, textAlign: 'left', cursor: 'pointer' };

export const KeysFilter = ({ filter, setFilter, style }) => <InputGroup size="small" leftIcon="search" placeholder="Filter keys" aria-label="Filter keys" value={filter} onChange={e => setFilter(e.target.value)} style={style}/>;

// entries: { [key]: { kind, steps, only_ref } }, the keys of both runs
const Contents = ({ groups, pinned, entries, names, collapsed, onToggleGroup, onPin, onJump, filter, setFilter, total }) => {
  // the keys' steps, when they aren't all the same: what tells them apart
  const signatures = new Set(Object.values(entries).map(entry => `${entry.steps.length}:${entry.steps.at(-1)}`));
  const show_steps = signatures.size > 1;
  // the pinned keys the filter keeps, like the groups' (LoggedMedia)
  const needle = (filter ?? '').trim().toLowerCase();
  const pinned_shown = [...pinned].filter(key => entries[key] && key.toLowerCase().includes(needle));
  const entry = key => <li key={key} className="qa-media-contents-entry" style={{ display: 'flex', alignItems: 'center', gap: 4, minHeight: 22, fontSize: 12 }}>
    <Icon icon={KIND_ICONS[entries[key].kind]} size={11} className={Classes.TEXT_MUTED}/>
    <button type="button" className="qa-media-link" onClick={() => onJump(key)} style={{ ...link_style, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={entries[key].only_ref ? `${key}: not logged by ${names.new}` : key}>
      {key.includes('/') ? key.slice(key.indexOf('/') + 1) : key}
    </button>
    {entries[key].only_ref && <Tag minimal size="small" intent="warning" style={{ fontSize: 10, minHeight: 16, padding: '0 4px' }}>only {names.reference}</Tag>}
    {show_steps && <span className={Classes.TEXT_MUTED} style={{ fontSize: 10, whiteSpace: 'nowrap' }} title={`${entries[key].steps.length} steps, the last ${formatStep(entries[key].steps.at(-1))}`}>
      {entries[key].steps.length}× · {formatStep(entries[key].steps.at(-1))}
    </span>}
    <Button
      size="small" variant="minimal" className="qa-media-contents-pin" icon={pinned.has(key) ? 'unpin' : 'pin'} aria-pressed={pinned.has(key)}
      aria-label={pinned.has(key) ? `Unpin ${key}` : `Pin ${key}`} onClick={() => onPin(key)} style={{ minHeight: 18, minWidth: 18, padding: 0 }}
    />
  </li>;
  return <nav aria-label="Logged media keys" data-testid="media-contents">
    {total > FILTER_FROM && <KeysFilter filter={filter} setFilter={setFilter} style={{ marginBottom: 6 }}/>}
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {pinned_shown.length > 0 && <>
        <li className={Classes.TEXT_MUTED} style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, margin: '2px 0' }}>Pinned</li>
        {pinned_shown.map(entry)}
      </>}
      {groups.map(({ group, keys }) => !group ? keys.map(entry) : <li key={group}>
        <button type="button" className="qa-media-link" onClick={() => onToggleGroup(group)} aria-expanded={!collapsed[group]} style={{ ...link_style, display: 'flex', alignItems: 'center', gap: 4, fontWeight: 600, minHeight: 22 }}>
          <Icon icon={collapsed[group] ? 'chevron-right' : 'chevron-down'} size={12}/>{group}<span className={Classes.TEXT_MUTED} style={{ fontWeight: 400 }}>{keys.length}</span>
        </button>
        {!collapsed[group] && <ul style={{ listStyle: 'none', margin: 0, paddingLeft: 14 }}>{keys.map(entry)}</ul>}
      </li>)}
    </ul>
  </nav>;
};

export default Contents;
