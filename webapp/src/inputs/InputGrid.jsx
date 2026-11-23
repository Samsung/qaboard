// A grid of inputs' thumbnails, with their names: the Inputs page and collections' pages.
// Only the rows near the screen are rendered (TanStack Virtual), pages of inputs load as users scroll.
// Selecting: click, ctrl/cmd+click, shift+click (src/inputs/gridSelection.js), the checkbox on each tile,
// the keyboard (arrows move, shift+arrows extend, space toggles, ctrl/cmd+A all, Esc none). Enter or double-click opens.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import styled from "styled-components";
import { Checkbox, Classes, Colors, Icon, Tag } from "@blueprintjs/core";

import { click_selection, toggle_selection, select_all, move_focus, empty_selection } from "./gridSelection";
import { input_name, thumbnail_url, database_label } from "./api";


const min_tile = 168;
const gap = 12;
// the name and a line of details under each thumbnail
const caption_height = 44;

// How many columns fit, and how tall rows are
export const grid_layout = width => {
  const usable = width > 0 ? width : 4 * (min_tile + gap);
  const columns = Math.max(1, Math.floor((usable + gap) / (min_tile + gap)));
  const tile = (usable - gap * (columns - 1)) / columns;
  return { columns, tile, row_height: Math.round(tile * 0.75) + caption_height + gap };
};

const Grid = styled.div`
  position: relative;
  outline: none;

  .qa-input-row {
    position: absolute;
    left: 0;
    right: 0;
    display: grid;
    gap: ${gap}px;
  }
  .qa-input-tile {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    border-radius: 4px;
    background: var(--qa-tile-background, ${Colors.WHITE});
    box-shadow: 0 0 0 1px rgba(17, 20, 24, 0.12), 0 1px 1px rgba(17, 20, 24, 0.08);
    cursor: pointer;
    user-select: none;
    outline: none;
    transition: box-shadow 100ms ease-out;
  }
  .${Classes.DARK} & .qa-input-tile, &.${Classes.DARK} .qa-input-tile {
    --qa-tile-background: ${Colors.DARK_GRAY3};
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12);
  }
  .qa-input-tile:hover {
    box-shadow: 0 0 0 1px rgba(45, 114, 210, 0.6), 0 2px 6px rgba(17, 20, 24, 0.15);
  }
  .qa-input-tile:focus-visible {
    box-shadow: 0 0 0 2px ${Colors.BLUE3}, 0 2px 6px rgba(17, 20, 24, 0.2);
  }
  .qa-input-tile[aria-selected="true"] {
    box-shadow: 0 0 0 2px ${Colors.BLUE3};
    background: rgba(45, 114, 210, 0.1);
  }
  .qa-input-tile.qa-removed {
    opacity: 0.45;
  }
  .qa-input-tile.qa-removed .qa-input-name {
    text-decoration: line-through;
  }
  .qa-input-thumb {
    position: relative;
    flex: none;
    border-radius: 4px 4px 0 0;
    overflow: hidden;
    background: repeating-conic-gradient(rgba(143, 153, 168, 0.18) 0 25%, transparent 0 50%) 0 0 / 16px 16px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .qa-input-thumb img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }
  .qa-input-placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    font-size: 12px;
  }
  .qa-input-pick {
    position: absolute;
    top: 6px;
    left: 6px;
    display: flex;
    padding: 3px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.9);
    opacity: 0;
    transition: opacity 100ms;
  }
  .qa-input-pick .${Classes.CONTROL} {
    margin: 0;
    padding-left: 20px;
    min-height: 16px;
    line-height: 16px;
  }
  .qa-input-pick .${Classes.CONTROL_INDICATOR} {
    margin-top: 0;
  }
  .qa-input-tile:hover .qa-input-pick,
  .qa-input-tile:focus-within .qa-input-pick,
  .qa-input-tile[aria-selected="true"] .qa-input-pick,
  &.qa-has-selection .qa-input-pick {
    opacity: 1;
  }
  .qa-input-badge {
    position: absolute;
    top: 6px;
    right: 6px;
  }
  .qa-input-caption {
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-width: 0;
    height: ${caption_height}px;
    padding: 0 8px;
    box-sizing: border-box;
  }
  .qa-input-name {
    font-family: var(--qa-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 12px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .qa-input-meta {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

// Thumbnails that failed: did the server say "busy" (503: too many being made, try again) or no (404...)?
// The 404s are in the browser's cache: asking again is free.
export const thumbnail_retry = async (url, attempt, max_attempts = 3) => {
  if (attempt >= max_attempts) return false;
  try {
    const response = await fetch(url, { credentials: 'same-origin' });
    return response.status === 503;
  } catch {
    return false;
  }
};

// A thumbnail, or a placeholder when no decoder reads the input (the server answers 404).
// When the server is busy (503), it tries again a few times, a bit later each time.
export const Thumbnail = ({ input, size = 256, alt = '' }) => {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const url = thumbnail_url(input, size);
  const onError = async () => {
    if (await thumbnail_retry(url, attempt)) {
      setTimeout(() => setAttempt(a => a + 1), 2000 * (attempt + 1));
    } else {
      setFailed(true);
    }
  };
  if (failed) return <span className={`qa-input-placeholder ${Classes.TEXT_MUTED}`}>
    <Icon icon="media" size={20}/>
    No preview
  </span>;
  // a new URL to try again: browsers don't reload the same src
  const src = attempt > 0 ? `${url}${url.includes('?') ? '&' : '?'}attempt=${attempt}` : url;
  return <img src={src} alt={alt} loading="lazy" decoding="async" draggable={false} onError={onError}/>;
};

export const default_input_meta = input => [
  input.runs !== undefined && input.runs !== null ? `${input.runs} run${input.runs === 1 ? '' : 's'}` : null,
  input.database ? database_label(input.database) : null,
].filter(Boolean).join(' · ');

// `count`: how many inputs (some may not be loaded yet), `item_at(index)`: an input, undefined until loaded.
// `loadMore`: asks for the next page, when rows near the end show. `removed`: ids shown as removed (edit mode).
export const InputGrid = ({
  count, item_at, loadMore, selection = empty_selection, onSelectionChange, onOpen, removed, badge, meta = default_input_meta,
  label = 'Inputs', selectable = true,
}) => {
  // TanStack Virtual's API isn't compatible with the React Compiler's memoization
  "use no memo";
  const container = useRef(null);
  const [width, setWidth] = useState(0);
  const [scroll_margin, setScrollMargin] = useState(0);
  const [focused, setFocused] = useState(0);
  // the tile to focus once it's rendered, after a keyboard move
  const pending_focus = useRef(null);

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // on every render: what's above the grid can change size
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const top = container.current.getBoundingClientRect().top + window.scrollY;
    if (Math.abs(top - scroll_margin) > 1) setScrollMargin(top);
  });

  const { columns, tile, row_height } = grid_layout(width);
  const rows = Math.ceil(count / columns);
  const virtualizer = useWindowVirtualizer({
    count: rows,
    estimateSize: () => row_height,
    overscan: 4,
    scrollMargin: scroll_margin,
  });
  const visible = virtualizer.getVirtualItems();
  const last_row = visible.at(-1)?.index ?? 0;
  useEffect(() => {
    // the next page, before users get there
    if (loadMore && (last_row + 3) * columns >= count - 1) loadMore(last_row * columns);
  }, [last_row, columns, count, loadMore]);
  useEffect(() => {
    virtualizer.measure();
  }, [row_height, virtualizer]);

  const focus_index = Math.min(focused, Math.max(0, count - 1));
  useEffect(() => {
    if (pending_focus.current === null) return;
    const element = container.current?.querySelector(`[data-index="${pending_focus.current}"]`);
    if (element) {
      element.focus({ preventScroll: false });
      pending_focus.current = null;
    }
  });
  const focusIndex = index => {
    setFocused(index);
    pending_focus.current = index;
    virtualizer.scrollToIndex(Math.floor(index / columns), { align: 'auto' });
  };

  const change = next => onSelectionChange?.(next);
  const onClick = (event, index) => {
    setFocused(index);
    if (!selectable) return onOpen?.(index);
    change(click_selection(selection, index, item_at, { shift: event.shiftKey, toggle: event.ctrlKey || event.metaKey }));
  };
  const onKeyDown = event => {
    if (event.target.closest?.('input')) return;
    const index = focus_index;
    if (event.key === 'Enter') {
      event.preventDefault();
      return onOpen?.(index);
    }
    if (!selectable) {
      const next = move_focus(index, event.key, { count, columns });
      if (next !== null) {
        event.preventDefault();
        focusIndex(next);
      }
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      return change(toggle_selection(selection, index, item_at));
    }
    if (event.key === 'Escape' && selection.selected.size > 0) {
      event.preventDefault();
      event.stopPropagation();
      return change(empty_selection);
    }
    if ((event.key === 'a' || event.key === 'A') && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      return change(select_all(count, item_at));
    }
    const next = move_focus(index, event.key, { count, columns });
    if (next === null) return;
    event.preventDefault();
    if (event.shiftKey) {
      const anchored = selection.anchor === null ? { ...selection, anchor: index } : selection;
      change(click_selection(anchored, next, item_at, { shift: true }));
    }
    focusIndex(next);
  };

  const has_selection = selection.selected.size > 0;
  return <Grid
    ref={container}
    role="grid"
    aria-label={label}
    aria-multiselectable={selectable || undefined}
    aria-rowcount={rows}
    aria-colcount={columns}
    className={has_selection ? 'qa-has-selection' : undefined}
    style={{ height: virtualizer.getTotalSize() }}
    onKeyDown={onKeyDown}
  >
    {visible.map(row => <div
      key={row.key}
      role="row"
      aria-rowindex={row.index + 1}
      className="qa-input-row"
      style={{ top: row.start - scroll_margin, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: columns }, (_, column) => {
        const index = row.index * columns + column;
        if (index >= count) return null;
        const input = item_at(index);
        if (!input) return <div key={`loading-${index}`} role="gridcell" aria-busy="true" aria-label="Loading" className="qa-input-tile">
          <div className={`qa-input-thumb ${Classes.SKELETON}`} style={{ height: Math.round(tile * 0.75) }}/>
          <div className="qa-input-caption"><span className={`qa-input-name ${Classes.SKELETON}`}>loading</span></div>
        </div>;
        const name = input_name(input);
        const is_selected = selection.selected.has(input.id);
        const is_removed = removed?.has(input.id);
        // the grid handles the keys (arrows, space, Enter): clicks are the pointer's way to do the same
        // oxlint-disable-next-line jsx-a11y/click-events-have-key-events
        return <div
          key={input.id}
          role="gridcell"
          data-index={index}
          aria-colindex={column + 1}
          aria-selected={selectable ? is_selected : undefined}
          aria-label={`${name}${is_removed ? ', removed' : ''}`}
          tabIndex={index === focus_index ? 0 : -1}
          className={`qa-input-tile${is_removed ? ' qa-removed' : ''}`}
          title={input.path}
          onClick={event => onClick(event, index)}
          onDoubleClick={() => onOpen?.(index)}
          onFocus={() => setFocused(index)}
        >
          <div className="qa-input-thumb" style={{ height: Math.round(tile * 0.75) }}>
            <Thumbnail input={input}/>
            {/* its clicks don't reach the tile: they add or remove it, like ctrl+click */}
            {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- only stops clicks, the checkbox inside is the control */}
            {selectable && <span className="qa-input-pick" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
              <Checkbox
                checked={is_selected}
                aria-label={`Select ${name}`}
                tabIndex={-1}
                onChange={() => {
                  setFocused(index);
                  change(toggle_selection(selection, index, item_at));
                }}
              />
            </span>}
            {(is_removed || badge?.(input)) && <span className="qa-input-badge">
              {is_removed ? <Tag intent="danger">removed</Tag> : badge(input)}
            </span>}
          </div>
          <div className="qa-input-caption">
            <span className="qa-input-name">{name}</span>
            <span className={`qa-input-meta ${Classes.TEXT_MUTED}`}>{meta(input)}</span>
          </div>
        </div>;
      })}
    </div>)}
  </Grid>;
};
