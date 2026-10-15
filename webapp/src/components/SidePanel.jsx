// A panel docked on the right of the page, under its fixed header, like an inspector: it's part of the layout
// (the content area gets narrower), it collapses to a rail of icons (one per section), and it can be resized.
// When the content area is too narrow, the open panel covers the page instead.
// Used by the commit page's View options.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import styled from "styled-components";
import { Button, Classes, Collapse, Icon, Tag, Tooltip } from "@blueprintjs/core";

import { is_typing } from "./HelpSheet";
import { sidebar } from "../design/tokens";

export const rail_width = 40;
export const min_width = 260;
export const max_width = 480;
export const default_width = 300;
// Until users choose, the panel starts open when the content area has room for it and for the results
const open_by_default_from = 1500;
// Below this, the open panel covers the content instead of narrowing it
const overlay_below = 1000;

const expanded_key = 'controls-panel-expanded';
const width_key = 'view-options-width';
// The room the panel takes on the right of the content area (see .qa-content-area in App.css)
const space_variable = '--qa-side-panel-space';

const clamp_width = width => Math.round(Math.min(max_width, Math.max(min_width, width)));

const read = (key, fallback) => {
  try {
    const saved = localStorage.getItem(key);
    return saved !== null ? JSON.parse(saved) : fallback;
  } catch {
    return fallback;
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private browsing, storage full...
  }
};

// The content area: the window minus the sidebar
const sider_width = parseInt(sidebar.width.default, 10);
const subscribe = callback => {
  window.addEventListener('resize', callback);
  return () => window.removeEventListener('resize', callback);
};
const useContentWidth = () => useSyncExternalStore(subscribe, () => window.innerWidth - sider_width, () => 1440 - sider_width);

// Open or collapsed: the user's choice is remembered, else it depends on the room
export const useSidePanelExpanded = () => {
  const [expanded, setExpandedState] = useState(() => read(expanded_key, window.innerWidth - sider_width >= open_by_default_from));
  const setExpanded = useCallback(value => {
    setExpandedState(value);
    write(expanded_key, value);
  }, []);
  return [expanded, setExpanded];
};


const Aside = styled.aside`
  position: fixed;
  top: ${props => props.$top}px;
  right: 0;
  bottom: 0;
  z-index: 19;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  background: var(--qa-surface);
  border-left: 1px solid var(--qa-border);
  transition: width 150ms cubic-bezier(0.4, 0, 0.2, 1);
  &[data-resizing] {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
  &[data-overlay] {
    box-shadow: -4px 0 16px rgba(17, 20, 24, 0.2);
  }
  .bp6-dark &[data-overlay] {
    box-shadow: -4px 0 16px rgba(0, 0, 0, 0.5);
  }
`;

const Header = styled.div`
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 40px;
  padding: 0 8px 0 16px;
  border-bottom: 1px solid var(--qa-border);
  h6 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    white-space: nowrap;
  }
  .side-panel-actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 2px;
  }
`;

// Only the body scrolls
const Body = styled.div`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--qa-border) transparent;
`;

// A drag handle on the left edge: a line shows on hover, while dragging, or when focused
const ResizeHandle = styled.div`
  position: absolute;
  top: 0;
  bottom: 0;
  left: -4px;
  width: 8px;
  cursor: col-resize;
  touch-action: none;
  z-index: 1;
  &::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 3px;
    width: 2px;
    background: transparent;
    transition: background 100ms;
  }
  &:hover::after, &[data-active]::after, &:focus-visible::after {
    background: var(--qa-intent-primary);
  }
  &:focus-visible {
    outline: none;
  }
`;

// Sections like Blueprint's compact Section: a small header that folds them, separated by lines
const SectionBlock = styled.section`
  & + & {
    border-top: 1px solid var(--qa-border);
  }
  scroll-margin-top: 0;
`;
const SectionHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 36px;
  padding: 0 12px 0 8px;
  .side-panel-section-toggle {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    align-self: stretch;
    padding: 0 8px;
    margin: 0;
    border: none;
    border-radius: 2px;
    background: none;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    color: var(--qa-text-muted);
    text-align: left;
    cursor: pointer;
    &:hover {
      color: var(--qa-text);
    }
    &:focus-visible {
      outline: 2px solid var(--qa-intent-primary);
      outline-offset: -2px;
    }
  }
`;
const SectionContent = styled.div`
  padding: 0 16px 16px;
`;

const Rail = styled.div`
  width: ${rail_width - 1}px;
  height: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 4px 0 8px;
  .side-panel-rail-item {
    position: relative;
  }
  .side-panel-separator {
    width: 20px;
    border-top: 1px solid var(--qa-border);
    margin: 2px 0;
  }
  .side-panel-rail-label {
    writing-mode: vertical-rl;
    margin-top: 4px;
    padding: 10px 0;
    width: 30px;
    border: none;
    border-radius: 2px;
    background: none;
    font: inherit;
    font-size: 12px;
    color: var(--qa-text-muted);
    cursor: pointer;
    &:hover {
      color: var(--qa-text);
      background: var(--qa-hover);
    }
  }
  .side-panel-rail-bottom {
    margin-top: auto;
  }
`;

// What differs from the defaults
export const ChangedDot = styled.span`
  position: absolute;
  top: 4px;
  right: 4px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--qa-intent-primary);
  box-shadow: 0 0 0 2px var(--qa-surface);
  pointer-events: none;
`;

const Kbd = ({ children }) => <kbd className={Classes.KEY} style={{ marginLeft: 6 }}>{children}</kbd>;

// A section's state, on hover of its rail icon
const SectionTooltip = ({ section }) => <div style={{ maxWidth: 260 }}>
  <div><strong>{section.title}</strong>{section.summary && <>: {section.summary}</>}</div>
  {section.changes.length > 0 && <div style={{ marginTop: 4, opacity: 0.8 }}>
    {section.summary_has_changes ? 'Differs from the defaults' : <>Changed: {section.changes.join(', ')}</>}
  </div>}
</div>;

export const ChangesTooltip = ({ changes }) => <div style={{ maxWidth: 260 }}>
  <div style={{ marginBottom: 4 }}>Changed from the project's defaults:</div>
  {changes.map(change => <div key={change}>{change}</div>)}
</div>;


/**
 * sections: [{ id, title, icon, summary, changes: [], summary_has_changes, meta, isOpen, content }]
 * onToggleSection(id), onOpenSection(id): a rail icon opens its section
 * changes: what differs from the defaults (a count in the header, its list on hover)
 * reset: { onClick, tooltip } when there is something to reset
 * scrollTo: { id }, a new object each time a section should be brought into view
 */
const SidePanel = ({
  title,
  shortcut,
  top,
  expanded,
  setExpanded,
  sections,
  onToggleSection,
  onOpenSection,
  changes = [],
  reset,
  scrollTo,
  children,
}) => {
  const content_width = useContentWidth();
  const overlay = content_width < overlay_below;
  const [width, setWidth] = useState(() => clamp_width(read(width_key, default_width)));
  const [resizing, setResizing] = useState(false);
  // After a click, the button clicked is gone: focus goes to its counterpart (expand <-> collapse)
  const toggle_ref = useRef(null);
  const focus_toggle = useRef(false);
  // a section to bring into view once open, after a click on its rail icon
  const scroll_target = useRef(null);

  // The content area makes room for the panel (only the rail when the open panel covers the page)
  const space = expanded && !overlay ? width : rail_width;
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty(space_variable, `${space}px`);
    return () => root.style.removeProperty(space_variable);
  }, [space]);
  // the content area follows the panel's width transition, but not on the first render
  useEffect(() => {
    const root = document.documentElement;
    const frame = requestAnimationFrame(() => root.setAttribute('data-side-panel-ready', ''));
    return () => {
      cancelAnimationFrame(frame);
      root.removeAttribute('data-side-panel-ready');
    };
  }, []);
  useEffect(() => {
    if (!resizing) return;
    const root = document.documentElement;
    root.setAttribute('data-side-panel-resizing', '');
    return () => root.removeAttribute('data-side-panel-resizing');
  }, [resizing]);

  const toggle = useCallback(({ focus = false } = {}) => {
    focus_toggle.current = focus;
    setExpanded(!expanded);
  }, [expanded, setExpanded]);

  // "o" shows or hides the panel, unless typing
  useEffect(() => {
    if (!shortcut) return;
    const onKeyDown = event => {
      if (event.key !== shortcut || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || event.repeat) return;
      if (is_typing(event.target)) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shortcut, toggle]);

  // Covering the page, Esc closes it
  useEffect(() => {
    if (!(expanded && overlay)) return;
    const onKeyDown = event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      setExpanded(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [expanded, overlay, setExpanded]);

  useEffect(() => {
    const target = scroll_target.current ?? (expanded ? scrollTo?.id : null);
    scroll_target.current = null;
    if (expanded && target) {
      const section = document.getElementById(`side-panel-section-${target}`);
      section?.scrollIntoView?.({ block: 'start' });
      section?.querySelector('button')?.focus({ preventScroll: true });
    } else if (focus_toggle.current) {
      toggle_ref.current?.focus();
    }
    focus_toggle.current = false;
  }, [expanded, scrollTo]);

  // Resizing: drag the left edge, or focus it and use the arrows. Double-click goes back to the default width
  const updateWidth = value => {
    const clamped = clamp_width(value);
    setWidth(clamped);
    write(width_key, clamped);
  };
  const drag = useRef(null);
  const onPointerDown = event => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { x: event.clientX, width };
    setResizing(true);
  };
  const onPointerMove = event => {
    if (!drag.current) return;
    setWidth(clamp_width(drag.current.width + drag.current.x - event.clientX));
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    setResizing(false);
    write(width_key, width);
  };
  const onResizeKey = event => {
    const step = event.shiftKey ? 64 : 16;
    const next = {
      ArrowLeft: width + step,
      ArrowRight: width - step,
      Home: max_width,
      End: min_width,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    updateWidth(next);
  };

  const changed_count = changes.length;

  if (!expanded)
    return <Aside $top={top} style={{ width: rail_width }} aria-label={title}>
      <Rail>
        <Tooltip content={<>Show the {title.toLowerCase()}{shortcut && <Kbd>{shortcut}</Kbd>}</>} placement="left">
          <Button
            ref={toggle_ref}
            icon="chevron-left"
            variant="minimal"
            aria-label={`Show the ${title.toLowerCase()}`}
            aria-expanded={false}
            onClick={() => toggle({ focus: true })}
          />
        </Tooltip>
        <div className="side-panel-separator" />
        {sections.map(section => <div className="side-panel-rail-item" key={section.id}>
          <Tooltip content={<SectionTooltip section={section} />} placement="left" hoverOpenDelay={150}>
            <Button
              icon={section.icon}
              variant="minimal"
              aria-label={`${section.title}: ${section.summary}${section.changes.length ? ' (changed)' : ''}`}
              onClick={() => {
                onOpenSection(section.id);
                scroll_target.current = section.id;
                setExpanded(true);
              }}
            />
          </Tooltip>
          {section.changes.length > 0 && <ChangedDot data-testid={`changed-${section.id}`} />}
        </div>)}
        {/* the label is for the eyes: the button above is the same for keyboards and screen readers */}
        <button type="button" className="side-panel-rail-label" tabIndex={-1} aria-hidden onClick={() => toggle()}>{title}</button>
        {reset && <div className="side-panel-rail-bottom">
          <Tooltip content={reset.tooltip} placement="left">
            <Button icon="reset" variant="minimal" aria-label="Reset" onClick={reset.onClick} />
          </Tooltip>
        </div>}
      </Rail>
    </Aside>;

  return <Aside
    $top={top}
    style={{ width }}
    aria-label={title}
    data-overlay={overlay || undefined}
    data-resizing={resizing || undefined}
  >
    <ResizeHandle
      // a focusable separator is a widget, which <hr> can't be
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize the ${title.toLowerCase()}`}
      aria-valuenow={width}
      aria-valuemin={min_width}
      aria-valuemax={max_width}
      tabIndex={0}
      title="Drag to resize. Double-click for the default width."
      data-active={resizing || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => updateWidth(default_width)}
      onKeyDown={onResizeKey}
    />
    <Header>
      <h6 className={Classes.HEADING}>{title}</h6>
      {changed_count > 0 && <Tooltip content={<ChangesTooltip changes={changes} />} placement="bottom">
        <Tag minimal round intent="primary" tabIndex={0} aria-label={`${changed_count} changed from the defaults`}>{changed_count}</Tag>
      </Tooltip>}
      <div className="side-panel-actions">
        {reset && <Tooltip content={reset.tooltip} placement="bottom">
          <Button icon="reset" text="Reset" variant="minimal" size="small" onClick={reset.onClick} />
        </Tooltip>}
        <Tooltip content={<>Collapse{shortcut && <Kbd>{shortcut}</Kbd>}</>} placement="bottom-end">
          <Button
            ref={toggle_ref}
            icon="chevron-right"
            variant="minimal"
            size="small"
            aria-label={`Collapse the ${title.toLowerCase()}`}
            aria-expanded
            onClick={() => toggle({ focus: true })}
          />
        </Tooltip>
      </div>
    </Header>
    <Body>
      {children}
      {sections.map(section => <SectionBlock key={section.id} id={`side-panel-section-${section.id}`} aria-labelledby={`side-panel-toggle-${section.id}`}>
        <SectionHeader>
          <button
            type="button"
            id={`side-panel-toggle-${section.id}`}
            className="side-panel-section-toggle"
            aria-expanded={section.isOpen}
            aria-controls={`side-panel-content-${section.id}`}
            onClick={() => onToggleSection(section.id)}
          >
            <Icon icon={section.isOpen ? "chevron-down" : "chevron-right"} size={12} aria-hidden />
            {section.title}
          </button>
          {section.meta}
        </SectionHeader>
        <Collapse isOpen={section.isOpen}>
          <SectionContent id={`side-panel-content-${section.id}`}>{section.content}</SectionContent>
        </Collapse>
      </SectionBlock>)}
    </Body>
  </Aside>;
};

export default SidePanel;
