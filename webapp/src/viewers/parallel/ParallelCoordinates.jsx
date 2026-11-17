// A parallel coordinates plot: one vertical axis per column, one curved line per row. Standalone: it only needs
// React and Blueprint, see README.md. The logic is in model.js, the canvas drawing in draw.js.
//
// Layers, bottom to top: the lines on canvas tiles (redrawn only when the data, the layout or the brushes change),
// the axes as HTML (labels, brushes, menus), an overlay canvas for the hovered and marked rows, the tooltip.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Icon, Menu, MenuDivider, MenuItem, PopoverNext as Popover } from '@blueprintjs/core';

import {
  GEOMETRY, MISSING, OTHER, analyzeColumn, brushPixels, brushValues, brushedSlots, computeLayout, formatNumber, formatValue,
  moveKey, nearestRow, orderColumns, rangeBrush, selectRows, shortLabel, slotRows, toggleSlot,
} from './model';
import { rowColors } from './colors';
import { drawBase, drawOverlay, prepare } from './draw';
import './parallel.css';

// The lines are drawn on tiles this wide (device pixels): browsers refuse canvases beyond ~16k pixels,
const TILE_PIXELS = 1024;
// ... and only those in view, or about to be, are drawn
const TILE_MARGIN = 256;
const TOOLTIP_COLUMNS = 36;
const NO_MARKS = {};

// What's hovered, outside of React's state: hovering redraws the overlay and the tooltip only
function createHoverStore() {
  let state = null;
  const listeners = new Set(), movers = new Set();
  const pointer = { x: 0, y: 0 };
  return {
    pointer,
    get: () => state,
    set(next) { if (next !== state) { state = next; listeners.forEach(l => l()); } },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    move(x, y) { pointer.x = x; pointer.y = y; movers.forEach(m => m()); },
    onMove(mover) { movers.add(mover); return () => movers.delete(mover); },
  };
}

const slotLabel = slot => slot.type === 'missing' ? 'missing' : slot.type === 'other' ? 'not a number' : slot.type === 'value' ? formatNumber(slot.value) : slot.name;

function Tooltip({ store, axes, rows, marks, colors, color_key, tooltipExtra }) {
  const hover = useSyncExternalStore(store.subscribe, store.get);
  const ref = useRef(null);
  // next to the cursor, never under it, within the window
  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const { x, y } = store.pointer;
      const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
      let left = x + 18;
      if (left + w > vw - 8) left = x - 18 - w;
      const fits = left >= 8;
      if (!fits) left = Math.max(8, Math.min(vw - w - 8, x + 18));
      let top = y + 14;
      if (top + h > vh - 8) top = fits ? Math.max(8, vh - h - 8) : Math.max(8, y - h - 14);
      el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    };
    place();
    return store.onMove(place);
  }, [store, hover]);
  if (!hover) return null;
  if (!hover.single) {
    return <div className="qa-parallel-tooltip" ref={ref} role="tooltip">
      <div className="qa-parallel-tooltip-title">{hover.title}</div>
      <div className="qa-parallel-tooltip-muted">{hover.rows.length.toLocaleString('en-US')} {hover.rows.length === 1 ? 'row' : 'rows'}</div>
    </div>;
  }
  const i = hover.rows[0];
  const row = rows[i];
  if (!row) return null;
  const mark = marks[row.id];
  const shown = axes.slice(0, TOOLTIP_COLUMNS);
  const entries = [];
  let group;
  shown.forEach(axis => {
    const column = axis.column;
    if (column.group !== group && axes.some(a => a.column.group)) {
      group = column.group;
      entries.push(<div className="qa-parallel-tooltip-group" key={`group ${axis.key}`}>{group ?? 'Other'}</div>);
    }
    const value = row.values?.[axis.key];
    entries.push(<div className="qa-parallel-tooltip-row" key={axis.key}>
      <span className="qa-parallel-tooltip-key">
        {axis.key === color_key && <span className="qa-parallel-swatch" style={{ background: colors.palette[colors.index[i]] }}/>}
        {column.label}
      </span>
      <span className={`qa-parallel-tooltip-value${axis.slots[axis.slot[i]]?.type === 'missing' ? ' qa-parallel-tooltip-muted' : ''}`}>{formatValue(column, value)}</span>
    </div>);
  });
  const extra = tooltipExtra?.(row);
  return <div className="qa-parallel-tooltip" ref={ref} role="tooltip">
    <div className="qa-parallel-tooltip-title">
      {row.label ?? `Row ${row.id ?? i}`}
      {mark?.label && <span className="qa-parallel-tooltip-mark" style={mark.color ? { background: mark.color } : undefined}>{mark.label}</span>}
    </div>
    <div className="qa-parallel-tooltip-values" style={{ columnCount: shown.length > 30 ? 3 : shown.length > 14 ? 2 : 1 }}>{entries}</div>
    {axes.length > shown.length && <div className="qa-parallel-tooltip-muted">+ {axes.length - shown.length} more columns</div>}
    {extra != null && extra !== false && <div className="qa-parallel-tooltip-extra">{extra}</div>}
  </div>;
}

function Legend({ legend }) {
  if (!legend) return null;
  const { column } = legend;
  if (legend.type === 'number') {
    const better = side => column.better === side && <span className="qa-parallel-legend-better">better</span>;
    return <span className="qa-parallel-legend" aria-label={`Color scale of ${column.label}`}>
      {better('lower')}
      <span className="qa-parallel-legend-end">{formatValue(column, legend.min)}</span>
      <span className="qa-parallel-gradient" style={{ background: `linear-gradient(to right, ${legend.gradient.join(', ')})` }}/>
      <span className="qa-parallel-legend-end">{formatValue(column, legend.max)}</span>
      {better('higher')}
      {legend.log && <span className="qa-parallel-muted">log</span>}
    </span>;
  }
  return <span className="qa-parallel-legend">
    {legend.items.map(item => <span className="qa-parallel-legend-item" key={item.name} title={`${item.name}: ${item.count} rows`}>
      <span className="qa-parallel-swatch" style={{ background: item.color }}/>
      <span className="qa-parallel-legend-name">{item.name}</span>
    </span>)}
    {legend.more > 0 && <span className="qa-parallel-muted">+ {legend.more} more</span>}
  </span>;
}

/**
 * See README.md for the props.
 */
export function ParallelCoordinates({
  columns, rows, colorBy, onColorByChange, marks = NO_MARKS, selection, onSelectionChange, onHover, onRowClick,
  height = 420, dark, tooltipExtra, empty, className, onTiming,
}) {
  const rootRef = useRef(null), scrollerRef = useRef(null), contentRef = useRef(null), overlayRef = useRef(null);
  const tilesRef = useRef([]);
  const [store] = useState(createHoverStore);
  const n = rows?.length ?? 0;

  // --- the size and the theme ---
  const [size, setSize] = useState({ width: 0, dpr: 1 });
  useLayoutEffect(() => {
    const el = rootRef.current;
    const measure = () => setSize(previous => {
      const next = { width: Math.floor(el.clientWidth) || 960, dpr: Math.min(3, window.devicePixelRatio || 1) };
      return next.width === previous.width && next.dpr === previous.dpr ? previous : next;
    });
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const [detected, setDetected] = useState({ dark: false, surface: null });
  const is_dark = dark ?? detected.dark;
  useLayoutEffect(() => {
    const detect = () => {
      const el = rootRef.current;
      if (!el) return;
      const next = { dark: !!el.closest('.bp6-dark'), surface: getComputedStyle(el).backgroundColor || null };
      setDetected(previous => previous.dark === next.dark && previous.surface === next.surface ? previous : next);
    };
    detect();
    if (typeof MutationObserver === 'undefined') return undefined;
    // the theme is a class on the page
    const observer = new MutationObserver(detect);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [dark]);
  const surface = detected.surface && !/rgba\(.*,\s*0\)|transparent/.test(detected.surface) ? detected.surface : (is_dark ? '#252a31' : '#ffffff');

  // --- what the user set up: the columns' order, which are hidden, log scales and flipped axes, brushes ---
  const [order, setOrder] = useState(null);
  const [hidden, setHidden] = useState({});
  const [options, setOptions] = useState({});
  const [brushes, setBrushes] = useState({});
  const [menu, setMenu] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [brushing, setBrushing] = useState(false);
  // colorBy is controlled with onColorByChange, otherwise it's where we start from
  const [own_color, setOwnColor] = useState({ from: colorBy, key: colorBy });
  if (own_color.from !== colorBy) setOwnColor({ from: colorBy, key: colorBy });
  const color_key = (onColorByChange ? colorBy : own_color.key) ?? null;
  const colorByColumn = key => {
    setOwnColor({ from: colorBy, key });
    onColorByChange?.(key);
  };

  // --- the model ---
  const analyzed = useMemo(() => (columns ?? []).map(c => analyzeColumn(c, rows ?? [])), [columns, rows]);
  const ordered = useMemo(() => orderColumns(analyzed, order), [analyzed, order]);
  const is_hidden = c => hidden[c.key] ?? c.constant;
  const visible = ordered.filter(c => !is_hidden(c));
  const hidden_columns = ordered.filter(is_hidden);
  const has_marks = Object.keys(marks).length > 0;
  const layout = useMemo(() => {
    if (!size.width || visible.length < 2 || !n) return null;
    const t0 = performance.now();
    const resolved = Object.fromEntries(visible.map(c => [c.key, { log: options[c.key]?.log ?? !!c.log, flipped: !!options[c.key]?.flipped }]));
    const result = computeLayout(visible, { width: size.width, height, options: resolved, marks: has_marks });
    onTiming?.({ what: 'layout', ms: performance.now() - t0 });
    return result;
    // `visible` is derived from what's listed
    // oxlint-disable-next-line react/exhaustive-deps
  }, [ordered, hidden, options, size.width, height, has_marks, n]);
  const axes = layout?.axes;
  const color_column = analyzed.find(c => c.key === color_key) ?? null;
  const color_log = color_column ? (options[color_column.key]?.log ?? !!color_column.log) : false;
  const colors = useMemo(() => rowColors(color_column, n, { dark: is_dark, log: color_log }), [color_column, n, is_dark, color_log]);

  const brushed = useMemo(() => axes ? selectRows(axes, brushes, n) : null, [axes, brushes, n]);
  const index_of = useMemo(() => new Map((rows ?? []).map((row, i) => [row.id, i])), [rows]);
  const external = useMemo(() => {
    if (!selection) return null;
    const mask = new Uint8Array(n);
    let count = 0;
    for (const id of selection) { const i = index_of.get(id); if (i !== undefined && !mask[i]) { mask[i] = 1; count++; } }
    return { mask, count };
  }, [selection, index_of, n]);
  const selected = brushed ?? external;
  // by content: callers often build `marks` at every render, and that mustn't redraw the plot
  const marks_content = JSON.stringify(marks);
  const resolved_marks = useMemo(() => Object.entries(JSON.parse(marks_content))
    .map(([id, mark]) => ({ ...mark, row: index_of.get(id) ?? index_of.get(Number(id)) }))
    .filter(mark => mark.row !== undefined), [marks_content, index_of]);

  const scene = useMemo(() => layout && {
    axes: layout.axes, layout, colors, rows, marks: resolved_marks, curve: layout.curve, dark: is_dark, surface, height,
    mask: selected?.mask ?? null, selected_count: selected?.count ?? n, dpr: size.dpr, preview: brushing,
  }, [layout, colors, rows, resolved_marks, is_dark, surface, height, selected, n, size.dpr, brushing]);

  // the callbacks and the scene as the event handlers and the drawing code see them
  const live = useRef({});
  useLayoutEffect(() => { live.current = { scene, onHover, onRowClick, onSelectionChange, onTiming, rows }; });

  // --- drawing ---
  const tile_width = Math.floor(TILE_PIXELS / size.dpr);
  const tiles = layout ? Array.from({ length: Math.ceil(layout.width / tile_width) }, (_, k) => ({ x: k * tile_width, width: Math.min(tile_width, layout.width - k * tile_width) })) : [];
  const dirty = useRef(new Set());
  const paintTiles = () => {
    const { scene: s, onTiming: timing } = live.current;
    const scroller = scrollerRef.current;
    if (!s || !scroller) return;
    const from = scroller.scrollLeft - TILE_MARGIN, to = scroller.scrollLeft + (scroller.clientWidth || s.layout.width) + TILE_MARGIN;
    const t0 = performance.now();
    let painted = 0;
    for (const k of dirty.current) {
      const canvas = tilesRef.current[k];
      const x = k * Math.floor(TILE_PIXELS / s.dpr);
      const width = Math.min(Math.floor(TILE_PIXELS / s.dpr), s.layout.width - x);
      if (!canvas || width <= 0) { dirty.current.delete(k); continue; }
      // the tiles out of view are drawn when they are scrolled to
      if (x > to || x + width < from) continue;
      dirty.current.delete(k);
      const ctx = prepare(canvas, width, s.height, s.dpr);
      if (!ctx) continue;
      ctx.translate(-x, 0);
      drawBase(ctx, s, x, x + width);
      painted++;
    }
    if (painted) timing?.({ what: 'lines', ms: performance.now() - t0 });
  };
  const paintOverlay = () => {
    const { scene: s, onTiming: timing } = live.current;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const width = scroller.clientWidth || s?.layout.width || 0;
    const t0 = performance.now();
    const ctx = prepare(overlayRef.current, width, s?.height ?? 1, s?.dpr ?? 1);
    if (!ctx || !s) return;
    ctx.translate(-scroller.scrollLeft, 0);
    drawOverlay(ctx, s, store.get(), scroller.scrollLeft, scroller.scrollLeft + width);
    timing?.({ what: 'overlay', ms: performance.now() - t0 });
  };
  // shadows on the sides where there is more to scroll to
  const frameRef = useRef(null);
  const markEdges = () => {
    const scroller = scrollerRef.current, frame = frameRef.current;
    if (!scroller || !frame) return;
    frame.classList.toggle('qa-parallel-more-left', scroller.scrollLeft > 2);
    frame.classList.toggle('qa-parallel-more-right', scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 2);
  };
  const n_tiles = tiles.length;
  useEffect(() => {
    markEdges();
    dirty.current = new Set(Array.from({ length: n_tiles }, (_, k) => k));
    paintTiles();
    paintOverlay();
    // the paint functions read the scene from `live`
    // oxlint-disable-next-line react/exhaustive-deps
  }, [scene, n_tiles]);
  const scroll_frame = useRef(0);
  const onScroll = () => {
    cancelAnimationFrame(scroll_frame.current);
    scroll_frame.current = requestAnimationFrame(() => { markEdges(); paintTiles(); paintOverlay(); });
  };

  // --- hovering ---
  const setHover = next => {
    const previous = store.get();
    if (!next && !previous) return;
    if (next && previous && next.single && previous.single && next.rows[0] === previous.rows[0]) return;
    if (next && previous && !next.single && !previous.single && next.id === previous.id) return;
    store.set(next);
    rootRef.current?.classList.toggle('qa-parallel-hovering', !!next);
    paintOverlay();
    const row = next?.single ? live.current.rows[next.rows[0]] : null;
    const previous_row = previous?.single ? live.current.rows[previous.rows[0]] : null;
    if (row !== previous_row) live.current.onHover?.(row ?? null);
  };
  // the hover doesn't survive what it points to
  useEffect(() => () => { store.set(null); }, [store, scene]);
  useEffect(() => { if (!store.get()) rootRef.current?.classList.remove('qa-parallel-hovering'); });

  const pointer = useRef({ frame: 0, x: 0, y: 0 });
  const busy = useRef(false);      // dragging a brush or a title
  const hitTest = () => {
    pointer.current.frame = 0;
    const { scene: s, onTiming: timing } = live.current;
    const content = contentRef.current;
    if (!s || !content || busy.current) return;
    const box = content.getBoundingClientRect();
    const t0 = performance.now();
    const hit = nearestRow(s.axes, pointer.current.x - box.left, pointer.current.y - box.top, { mask: s.mask, curve: s.curve });
    setHover(hit ? { single: true, rows: [hit.row] } : null);
    timing?.({ what: 'hover', ms: performance.now() - t0 });
  };
  const onPointerMove = e => {
    store.move(e.clientX, e.clientY);
    if (busy.current || e.target.closest?.('[data-slot]')) return;
    pointer.current.x = e.clientX;
    pointer.current.y = e.clientY;
    if (!pointer.current.frame) pointer.current.frame = requestAnimationFrame(hitTest);
  };
  const onPointerLeave = () => {
    cancelAnimationFrame(pointer.current.frame);
    pointer.current.frame = 0;
    setHover(null);
  };
  useEffect(() => () => { cancelAnimationFrame(pointer.current.frame); cancelAnimationFrame(scroll_frame.current); }, []);
  const clickRow = () => {
    const hover = store.get();
    if (hover?.single) live.current.onRowClick?.(live.current.rows[hover.rows[0]]);
  };
  const hoverSlot = (axis, k, e) => {
    if (busy.current) return;
    if (e?.clientX !== undefined) store.move(e.clientX, e.clientY);
    else if (e?.currentTarget) { const box = e.currentTarget.getBoundingClientRect(); store.move(box.right, box.top); }
    const slot = axis.slots[k];
    const mask = live.current.scene?.mask;
    let slot_rows = slotRows(axis, k, mask);
    if (!slot_rows.length) slot_rows = slotRows(axis, k);
    setHover({ single: false, id: `${axis.key}\n${slot.name}`, rows: slot_rows, title: `${axis.column.label}: ${slotLabel(slot)}${slot.type === 'value' ? axis.column.suffix ?? '' : ''}` });
  };

  // --- brushing ---
  const last_selection = useRef(null);
  useEffect(() => {
    const ids = brushed ? rows.filter((_, i) => brushed.mask[i]).map(row => row.id) : null;
    const previous = last_selection.current;
    const same = ids === previous || (ids && previous && ids.length === previous.length && ids.every((id, i) => id === previous[i]));
    last_selection.current = ids;
    if (!same) live.current.onSelectionChange?.(ids);
    // rows and brushed change together
    // oxlint-disable-next-line react/exhaustive-deps
  }, [brushed]);
  const setBrush = (key, brush) => setBrushes(previous => {
    const next = { ...previous };
    if (brush) next[key] = brush; else delete next[key];
    return next;
  });
  const brush_drag = useRef(null);
  const contentY = e => e.clientY - contentRef.current.getBoundingClientRect().top;
  const onBrushDown = (axis, e) => {
    if (e.button !== 0 || e.target.closest?.('button')) return;
    const y = contentY(e);
    const brush = brushes[axis.key];
    const part = e.target.dataset?.part;
    const drag = { key: axis.key, mode: 'new', anchor: y, start: y, moved: false, had: !!brush };
    if (brush?.type === 'range' && part) {
      const [y0, y1] = brushPixels(axis, brush);
      if (part === 'top') Object.assign(drag, { mode: 'resize', anchor: y1 });
      else if (part === 'bottom') Object.assign(drag, { mode: 'resize', anchor: y0 });
      else Object.assign(drag, { mode: 'move', offset: y - y0, size: y1 - y0 });
    }
    brush_drag.current = drag;
    busy.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setHover(null);
  };
  const onBrushMove = (axis, e) => {
    const drag = brush_drag.current;
    if (!drag || drag.key !== axis.key) return;
    const y = contentY(e);
    if (!drag.moved && Math.abs(y - drag.start) < 3) return;
    drag.moved = true;
    setBrushing(true);
    if (drag.mode === 'move') {
      const y0 = Math.min(axis.extent[1] - drag.size, Math.max(axis.extent[0], y - drag.offset));
      setBrush(axis.key, rangeBrush(axis, y0, y0 + drag.size));
    } else setBrush(axis.key, rangeBrush(axis, drag.anchor, y));
  };
  const onBrushUp = (axis, e) => {
    const drag = brush_drag.current;
    brush_drag.current = null;
    busy.current = false;
    setBrushing(false);
    if (!drag) return;
    if (!drag.moved) {
      // a click: on a brushed axis it clears the brush, elsewhere it's a click on the hovered line
      if (drag.mode === 'new' && drag.had) setBrush(axis.key, null);
      else if (drag.mode === 'new') { pointer.current.x = e.clientX; pointer.current.y = e.clientY; hitTest(); clickRow(); }
      return;
    }
    const brush = rangeBrush(axis, drag.anchor, contentY(e));
    const [y0, y1] = brushPixels(axis, brush);
    if (drag.mode !== 'move' && y1 - y0 < 3) setBrush(axis.key, null);
  };
  const clearBrushes = () => setBrushes({});

  // --- the columns: reordering, hiding, options ---
  const all_keys = ordered.map(c => c.key);
  const moveColumn = (key, before_key) => setOrder(moveKey(all_keys, key, before_key === null ? all_keys.length : all_keys.indexOf(before_key)));
  const hideColumn = key => { setHidden(h => ({ ...h, [key]: true })); setBrush(key, null); };
  const setOption = (key, option, value) => {
    setOptions(o => ({ ...o, [key]: { ...o[key], [option]: value } }));
    // a range brush is about heights on the axis: it doesn't mean the same once the axis changes
    if (brushes[key]?.type === 'range') setBrush(key, null);
  };
  const title_drag = useRef(null);
  const suppress_click = useRef(false);
  const dropTarget = (key, dx) => {
    const axis = axes.find(a => a.key === key);
    const x = axis.x + dx;
    const others = axes.filter(a => a.key !== key);
    const before = others.find(a => a.x > x) ?? null;
    const j = axes.indexOf(axis);
    const unchanged = (before ? axes.indexOf(before) : axes.length) === j + 1;
    const previous = before ? others[others.indexOf(before) - 1] : others[others.length - 1];
    const marker = before ? (previous ? (previous.x + before.x) / 2 : before.x - 28) : previous.x + 28;
    return { before: before?.key ?? null, unchanged, marker };
  };
  const onTitleDown = (axis, e) => {
    if (e.button !== 0) return;
    title_drag.current = { key: axis.key, start: e.clientX, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onTitleMove = e => {
    const drag = title_drag.current;
    if (!drag) return;
    const dx = e.clientX - drag.start;
    if (!drag.moved && Math.abs(dx) < 5) return;
    drag.moved = true;
    busy.current = true;
    setMenu(null);
    setHover(null);
    setDragging({ key: drag.key, dx, ...dropTarget(drag.key, dx) });
  };
  const onTitleUp = e => {
    const drag = title_drag.current;
    title_drag.current = null;
    if (!drag?.moved) return;
    busy.current = false;
    suppress_click.current = true;
    setTimeout(() => { suppress_click.current = false; }, 0);
    const target = dropTarget(drag.key, e.clientX - drag.start);
    setDragging(null);
    if (!target.unchanged) moveColumn(drag.key, target.before);
  };

  const hidden_control = hidden_columns.length > 0 && <Popover
    placement="bottom-end"
    content={<Menu className="qa-parallel-menu">
      <MenuDivider title="Hidden columns: click to show"/>
      {hidden_columns.map(c => <MenuItem
        key={c.key} icon="eye-open" text={c.label} shouldDismissPopover={false}
        labelElement={c.constant ? <span className="qa-parallel-constant" title="Every row has this value">= {c.constant_value}</span> : undefined}
        onClick={() => setHidden(h => ({ ...h, [c.key]: false }))}
      />)}
      {hidden_columns.length > 3 && <>
        <MenuDivider/>
        <MenuItem icon="eye-open" text="Show all" onClick={() => setHidden(Object.fromEntries(ordered.map(c => [c.key, false])))}/>
      </>}
    </Menu>}
  >
    <button type="button" className="qa-parallel-button" title="Columns that are hidden: those you hid, and those where every row has the same value">
      + {hidden_columns.length} hidden
    </button>
  </Popover>;

  const label = `Parallel coordinates: ${n} ${n === 1 ? 'row' : 'rows'}, ${visible.length} columns${visible.length ? ` (${visible.slice(0, 12).map(c => c.label).join(', ')}${visible.length > 12 ? '…' : ''})` : ''}${color_column ? `, colored by ${color_column.label}` : ''}`;
  const root_class = `qa-parallel${is_dark ? ' bp6-dark qa-parallel-dark' : ''}${className ? ` ${className}` : ''}`;

  if (!layout) {
    return <div className={root_class} ref={rootRef} role="figure" aria-label={label}>
      <div className="qa-parallel-empty" style={{ minHeight: Math.min(height, 180) }}>
        {empty ?? <>
          <strong>Nothing to compare yet</strong>
          <span>{n === 0 ? 'There are no rows.' : n === 1 ? 'There is only one row: lines show how rows differ.' : 'It takes at least two columns whose values differ between rows.'}</span>
        </>}
        {hidden_control}
      </div>
    </div>;
  }

  const menuOf = (axis, j) => {
    const { column, key } = axis;
    return <Menu className="qa-parallel-menu">
      <MenuItem icon="tint" text={color_key === key ? 'Stop coloring by this' : 'Color by this'} onClick={() => colorByColumn(color_key === key ? null : key)}/>
      <MenuItem icon="swap-vertical" text="Flip direction" labelElement={axis.flipped ? <Icon icon="tick"/> : undefined} onClick={() => setOption(key, 'flipped', !axis.flipped)}/>
      {column.type === 'number' && column.positive && column.max > column.min &&
        <MenuItem icon="function" text="Log scale" labelElement={axis.log ? <Icon icon="tick"/> : undefined} onClick={() => setOption(key, 'log', !axis.log)}/>}
      {brushes[key] && <MenuItem icon="filter-remove" text="Clear filter" onClick={() => setBrush(key, null)}/>}
      <MenuDivider/>
      <MenuItem icon="arrow-left" text="Move left" disabled={j === 0} shouldDismissPopover={false} onClick={() => moveColumn(key, axes[j - 1].key)}/>
      <MenuItem icon="arrow-right" text="Move right" disabled={j === axes.length - 1} shouldDismissPopover={false} onClick={() => moveColumn(key, axes[j + 2]?.key ?? null)}/>
      <MenuItem icon="eye-off" text="Hide" disabled={axes.length <= 2} onClick={() => hideColumn(key)}/>
    </Menu>;
  };

  const title_width = j => Math.floor(Math.min(
    layout.spacing - 10,
    j === 0 ? 2 * GEOMETRY.pad_left - 8 : Infinity,
    j === axes.length - 1 ? 2 * (layout.width - axes[j].x) - 8 : Infinity,
  ));

  return <div className={root_class} ref={rootRef} role="figure" aria-label={label}>
    <div className="qa-parallel-toolbar">
      <Popover
        placement="bottom-start"
        content={<Menu className="qa-parallel-menu">
          <MenuItem text="One color" roleStructure="listoption" selected={!color_column} onClick={() => colorByColumn(null)}/>
          <MenuDivider/>
          {ordered.filter(c => !c.constant).map(c => <MenuItem key={c.key} text={c.label} label={c.group} roleStructure="listoption" selected={c.key === color_key} onClick={() => colorByColumn(c.key)}/>)}
        </Menu>}
      >
        <button type="button" className="qa-parallel-button" title="Choose the column that colors the lines">
          <span className="qa-parallel-muted">Color</span> {color_column ? color_column.label : 'one color'} <Icon icon="caret-down" size={12}/>
        </button>
      </Popover>
      <Legend legend={colors.legend}/>
      <span className="qa-parallel-spacer"/>
      <span className="qa-parallel-count" aria-live="polite">
        {brushed
          ? <><strong>{brushed.count.toLocaleString('en-US')}</strong> of {n.toLocaleString('en-US')} shown <span aria-hidden="true">·</span> <button type="button" className="qa-parallel-link" onClick={clearBrushes}>Clear filters</button></>
          : <>{n.toLocaleString('en-US')} rows <span className="qa-parallel-hint">· drag along an axis to filter</span></>}
      </span>
      {hidden_control}
    </div>

    <div className="qa-parallel-frame" ref={frameRef}>
      <div className="qa-parallel-scroll" ref={scrollerRef} onScroll={onScroll}>
        {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
        <div
          className={`qa-parallel-content${dragging ? ' qa-parallel-reordering' : ''}`} ref={contentRef} style={{ width: layout.width, height }}
          onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}
          onClick={e => {
            if (e.target.closest?.('button, .qa-parallel-brush-zone')) return;
            // a click right after a move: the line under the cursor now
            if (e.clientX || e.clientY) { cancelAnimationFrame(pointer.current.frame); pointer.current.x = e.clientX; pointer.current.y = e.clientY; hitTest(); }
            clickRow();
          }}
        >
          {tiles.map((tile, k) => <canvas key={k} className="qa-parallel-lines" ref={el => { tilesRef.current[k] = el; }} style={{ left: tile.x, width: tile.width, height }} aria-hidden="true"/>)}
          {/* stays in view when the plot scrolls; under the axes' labels */}
          <canvas className="qa-parallel-overlay" ref={overlayRef} style={{ width: Math.min(size.width, layout.width), height }} aria-hidden="true"/>

          {layout.has_missing && <div className="qa-parallel-missing" style={{ top: layout.missing_y - 12 }}>
            <span title="Rows without a value for a column go through here">missing</span>
          </div>}

          {layout.groups.map(group => <div
            key={`${group.name} ${group.from}`} className="qa-parallel-group" title={group.name}
            style={{ left: group.x0 - 34, width: group.x1 - group.x0 + 68 }}
          ><span>{group.name}</span></div>)}

          {axes.map((axis, j) => {
            const { column, key } = axis;
            const brush = brushes[key];
            const on = brushedSlots(axis, brush);
            const range = brush?.type === 'range' ? brushPixels(axis, brush) : null;
            const values = range && brushValues(axis, brush);
            const max_label = Math.floor(j === 0 ? GEOMETRY.pad_left - 16 : layout.spacing - 26);
            const better_at_top = column.better && column.type === 'number' ? (column.better === 'higher') !== axis.flipped : null;
            const banded = axis.slots.filter(s => s.band >= 6).slice(0, 60);
            return <div key={key} className={`qa-parallel-axis${brush ? ' qa-parallel-brushed' : ''}${dragging?.key === key ? ' qa-parallel-dragged' : ''}`} style={{ left: axis.x }}>
              <div className={`qa-parallel-axis-line${column.type === 'category' ? ' qa-parallel-axis-line-category' : ''}`} style={{ top: axis.top, height: axis.line_bottom - axis.top }}/>
              {better_at_top !== null && <div
                className={`qa-parallel-better ${better_at_top ? 'qa-parallel-better-top' : 'qa-parallel-better-bottom'}`}
                style={{ top: better_at_top ? axis.top : axis.line_bottom }}
                title={`${column.better === 'higher' ? 'Higher' : 'Lower'} is better`}
              ><span>better</span></div>}
              {banded.map(s => <div key={s.name} className="qa-parallel-band" style={{ top: s.y - s.band / 2 - 1.5, height: s.band + 3 }}/>)}

              {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions */}
              <div
                className="qa-parallel-brush-zone" style={{ top: axis.extent[0], height: axis.extent[1] - axis.extent[0] }}
                onPointerDown={e => onBrushDown(axis, e)} onPointerMove={e => onBrushMove(axis, e)} onPointerUp={e => onBrushUp(axis, e)}
                onPointerCancel={() => { brush_drag.current = null; busy.current = false; setBrushing(false); }}
                onDoubleClick={() => setBrush(key, null)}
              >
                {range && <div
                  className="qa-parallel-brush" data-part="body" style={{ top: range[0] - axis.extent[0], height: Math.max(2, range[1] - range[0]) }}
                  title="Drag to move, drag the ends to resize, double-click to clear"
                >
                  <div className="qa-parallel-brush-handle qa-parallel-brush-top" data-part="top"/>
                  <div className="qa-parallel-brush-handle qa-parallel-brush-bottom" data-part="bottom"/>
                  <button type="button" className="qa-parallel-brush-clear" aria-label={`Clear the filter on ${column.label}`} title="Clear this filter" onClick={() => setBrush(key, null)}>
                    <Icon icon="small-cross" size={12}/>
                  </button>
                  {values && <>
                    <span className="qa-parallel-brush-value qa-parallel-brush-value-top">{formatNumber(axis.flipped ? values[0] : values[1], 3)}</span>
                    <span className="qa-parallel-brush-value qa-parallel-brush-value-bottom">{formatNumber(axis.flipped ? values[1] : values[0], 3)}</span>
                  </>}
                </div>}
              </div>

              {axis.ticks.map((tick, k) => {
                if (tick.hidden) return null;
                if (tick.slot === undefined) {
                  return <div key={k} className={`qa-parallel-tick${tick.end ? ' qa-parallel-tick-end' : ''}`} style={{ top: tick.y }}>
                    <span className="qa-parallel-tick-label" style={{ maxWidth: max_label }} title={tick.title}>{tick.label}</span>
                  </div>;
                }
                const slot = axis.slots[tick.slot];
                const state = on ? (on.has(slot.name) ? ' qa-parallel-on' : ' qa-parallel-off') : '';
                const show_count = !tick.missing && (column.type === 'category' || slot.type === 'other');
                return <div key={k} className={`qa-parallel-tick qa-parallel-tick-slot${tick.missing ? ' qa-parallel-tick-missing' : ''}${state}`} style={{ top: tick.y }}>
                  <button
                    type="button" className="qa-parallel-tick-label" data-slot={slot.name} tabIndex={-1} style={{ maxWidth: max_label }}
                    title={`${tick.title} · ${tick.count} ${tick.count === 1 ? 'row' : 'rows'} · click to filter`}
                    aria-pressed={on ? on.has(slot.name) : undefined}
                    onPointerEnter={e => hoverSlot(axis, tick.slot, e)} onPointerLeave={() => setHover(null)}
                    onFocus={e => hoverSlot(axis, tick.slot, e)} onBlur={() => setHover(null)}
                    onClick={() => setBrush(key, toggleSlot(axis, brush, slot.name))}
                  >
                    <span className="qa-parallel-tick-text">{tick.label}</span>
                    {show_count && <span className="qa-parallel-tick-count">{tick.count}</span>}
                  </button>
                </div>;
              })}

              <div className="qa-parallel-title-slot" style={{ top: layout.title_top, width: title_width(j), transform: dragging?.key === key ? `translateX(calc(-50% + ${dragging.dx}px))` : undefined }}>
                <Popover
                  isOpen={menu === key} placement="bottom" content={menuOf(axis, j)}
                  onInteraction={next => { if (!suppress_click.current) setMenu(next ? key : (m => m === key ? null : m)); }}
                >
                  <button
                    type="button" className={`qa-parallel-title${color_key === key ? ' qa-parallel-title-color' : ''}`}
                    title={`${column.group ? `${column.group}: ` : ''}${column.label}${column.suffix ? ` (${column.suffix.trim()})` : ''}${axis.log ? ' · log scale' : ''}${column.better ? ` · ${column.better} is better` : ''}\nClick for options, drag to move`}
                    aria-label={`${column.label}: options`} aria-haspopup="menu"
                    onPointerDown={e => onTitleDown(axis, e)} onPointerMove={onTitleMove} onPointerUp={onTitleUp}
                    onPointerCancel={() => { title_drag.current = null; busy.current = false; setDragging(null); }}
                  >
                    {color_key === key && <Icon icon="tint" size={11} className="qa-parallel-title-icon"/>}
                    <span className="qa-parallel-title-text">{shortLabel(column.label, Math.floor((title_width(j) - (color_key === key ? 30 : 16) - (brush ? 14 : 0) - (axis.log ? 16 : 0)) / 7.2))}</span>
                    {brush && <Icon icon="filter" size={11} className="qa-parallel-title-icon"/>}
                    {axis.log && <span className="qa-parallel-title-log">log</span>}
                  </button>
                </Popover>
              </div>
            </div>;
          })}
          {dragging && !dragging.unchanged && <div className="qa-parallel-drop" style={{ left: dragging.marker, top: layout.title_top, height: height - layout.title_top }}/>}
        </div>
      </div>
    </div>
    <Tooltip store={store} axes={axes} rows={rows} marks={marks} colors={colors} color_key={color_key} tooltipExtra={tooltipExtra}/>
  </div>;
}

export { MISSING, OTHER };
export default ParallelCoordinates;
