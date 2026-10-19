// What we call one side of the comparison, in its color: "● new", "● ref", or what users renamed it.
// Click it to rename it: the name goes in the URL, and viewers use it. Milestones keep their own name.
import { useState } from "react";
import styled from "styled-components";
import { Classes, Icon, Tooltip } from "@blueprintjs/core";


const Pill = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  max-width: 180px;
  padding: 0 7px 0 6px;
  border-radius: 11px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.2px;
  color: var(--qa-text);
  /* the side's color, tinted: it reads in both themes */
  background: color-mix(in srgb, var(--side-color) 12%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--side-color) 35%, transparent);
  white-space: nowrap;

  .qa-side-dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--side-color);
  }
  .qa-side-text {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .qa-side-edit {
    flex: none;
    opacity: 0;
    color: var(--qa-text-muted);
    transition: opacity 120ms ease;
  }
  &[role="button"] {
    cursor: text;
  }
  &[role="button"]:hover, &[role="button"]:focus-visible {
    background: color-mix(in srgb, var(--side-color) 20%, transparent);
  }
  &[role="button"]:hover .qa-side-edit, &[role="button"]:focus-visible .qa-side-edit {
    opacity: 1;
  }
  &:focus-visible {
    outline: 2px solid var(--side-color);
    outline-offset: 1px;
  }
  input {
    width: ${props => props.$width}ch;
    min-width: 4ch;
    max-width: 150px;
    padding: 0;
    border: none;
    outline: none;
    background: transparent;
    color: inherit;
    font: inherit;
  }
`;

// color: a CSS color. label: what users called it ('' if nothing). fallback: its default name, e.g. "new".
// editable: false for milestones. onRename(label): '' resets it.
export const SideLabel = ({ color, label, fallback, editable = true, onRename, tooltip, className }) => {
  const [draft, setDraft] = useState(null);
  const text = label || fallback;
  const style = { '--side-color': color };
  if (draft !== null) {
    const done = () => {
      const value = draft.trim();
      setDraft(null);
      if (value !== (label ?? '')) onRename(value === fallback ? '' : value);
    };
    return <Pill className={className} style={style} $width={Math.max(draft.length, 3) + 1}>
      <span className="qa-side-dot"/>
      <input
        autoFocus
        value={draft}
        aria-label={`Name instead of “${fallback}”`}
        placeholder={fallback}
        maxLength={60}
        onChange={e => setDraft(e.target.value)}
        onFocus={e => e.target.select()}
        onBlur={done}
        onKeyDown={e => {
          if (e.key === 'Enter') done();
          if (e.key === 'Escape') {
            e.stopPropagation();
            setDraft(null);
          }
        }}
      />
    </Pill>;
  }
  const pill = <Pill
    className={className}
    style={style}
    {...(editable ? {
      role: 'button',
      tabIndex: 0,
      'aria-label': `${text}: rename`,
      onClick: () => setDraft(label || ''),
      onKeyDown: e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setDraft(label || '')),
    } : {})}
  >
    <span className="qa-side-dot"/>
    <span className="qa-side-text">{text}</span>
    {editable && <Icon className="qa-side-edit" icon="edit" size={11}/>}
  </Pill>;
  return tooltip ? <Tooltip content={tooltip} hoverOpenDelay={400} targetProps={{ style: { flex: 'none', alignSelf: 'center', minWidth: 0, marginRight: 8 } }}>{pill}</Tooltip> : pill;
};

// For tooltips: why a milestone's name can't change
export const milestone_label_hint = name => <span>
  Named after its milestone, <strong>{name}</strong>. <span className={Classes.TEXT_MUTED}>Rename the milestone to change it.</span>
</span>;
