// A table logged at a step (its .table.json): sortable columns, a filter, rows drawn as they scroll into view, image
// cells as thumbnails. The reference's table at the same step is a click away.
import { useDeferredValue, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button, ButtonGroup, Classes, Dialog, DialogBody, HTMLSelect, Icon, InputGroup } from "@blueprintjs/core";

import { fileQuery } from "../../api/queries";
import { ViewerError, ViewerLoading } from "../ViewerStates";
import { useMediaContext } from "./context";
import { BY_ROW, cellText, columnHistogram, diffTables, is_media_cell, keyColumn, numericColumns, parseTable, tableRows } from "./table";

const ROW_HEIGHT = 30;
const IMAGE_ROW_HEIGHT = 52;
const MAX_HEIGHT = 420;

const format_number = value => Number.isInteger(value) ? String(value) : Math.abs(value) >= 1e5 || (value !== 0 && Math.abs(value) < 1e-3) ? value.toExponential(3) : String(+value.toPrecision(5));

const Cell = ({ cell, output, onOpen }) => {
  const { fileUrl } = useMediaContext();
  if (is_media_cell(cell)) {
    if (cell.kind === 'image') {
      const src = fileUrl(output, cell.path);
      return <button type="button" onClick={() => onOpen({ src, title: cell.caption ?? cell.path })} aria-label={`Enlarge ${cell.caption ?? cell.path}`} style={{ padding: 0, border: 'none', background: 'none', cursor: 'zoom-in', lineHeight: 0 }}>
        <img src={src} alt={cell.caption ?? cell.path} title={cell.caption ?? cell.path} loading="lazy" style={{ height: IMAGE_ROW_HEIGHT - 8, maxWidth: 120, objectFit: 'contain', imageRendering: 'pixelated' }}/>
      </button>;
    }
    return <a href={fileUrl(output, cell.path)} target="_blank" rel="noopener noreferrer"><Icon icon="document" size={12}/> {cell.path.split('/').pop()}</a>;
  }
  if (typeof cell === 'number') return format_number(cell);
  if (cell === null || cell === undefined) return <span className={Classes.TEXT_DISABLED}>—</span>;
  return cellText(cell);
};

// A numeric column's distribution, in its header
// the distribution of a numeric column, in its header: from 10 values, below that it's noise
const MIN_SPARKLINE_VALUES = 10;
const Sparkline = ({ histogram }) => {
  const total = histogram ? histogram.counts.reduce((a, b) => a + b, 0) : 0;
  if (total < MIN_SPARKLINE_VALUES) return null;
  const max = histogram.counts.reduce((a, b) => Math.max(a, b), 1);
  const width = 3 * histogram.counts.length;
  return <svg width={width} height={13} aria-hidden style={{ flex: 'none', marginRight: 4, opacity: 0.6 }}>
    <title>{`${format_number(histogram.min)} to ${format_number(histogram.max)}`}</title>
    {histogram.counts.map((count, i) => count > 0 && <rect key={i} x={i * 3} y={12 - Math.max(1.5, 11 * count / max)} width={2.6} height={Math.max(1.5, 11 * count / max)} fill="currentColor"/>)}
    <line x1={0} x2={width} y1={12.5} y2={12.5} stroke="currentColor" strokeWidth={0.5}/>
  </svg>;
};

const STATUS_STYLES = {
  added: { boxShadow: 'inset 3px 0 0 #238551', background: 'rgba(35, 133, 81, 0.08)' },
  removed: { boxShadow: 'inset 3px 0 0 #cd4246', background: 'rgba(205, 66, 70, 0.08)', opacity: 0.75 },
};
const CHANGED_STYLE = { background: 'rgba(251, 179, 96, 0.28)' };

// diff: the new table against the reference's (diffTables), aligned with table.rows, to mark rows and cells
export const Table = ({ table, output, output_ref, filter, sort, onSortChange, diff }) => {
  const scroll = useRef(null);
  const [opened, setOpened] = useState(null);
  const rows = tableRows(table, { filter, sort });
  const numeric = numericColumns(table);
  const has_images = table.rows.some(row => row.some(cell => is_media_cell(cell) && cell.kind === 'image'));
  const row_height = has_images ? IMAGE_ROW_HEIGHT : ROW_HEIGHT;
  const height = Math.min(MAX_HEIGHT, row_height * rows.length + 2);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => row_height,
    overscan: 10,
    // jsdom (the tests) has no layout
    initialRect: { width: 800, height: MAX_HEIGHT },
  });
  const histograms = table.columns.map((_, c) => numeric[c] ? columnHistogram(table.rows, c) : null);
  const template = table.columns.map((_, c) => numeric[c] ? 'minmax(70px, max-content)' : 'minmax(90px, 1fr)').join(' ');
  const toggleSort = column => onSortChange(
    sort?.column !== column ? { column, order: numeric[column] ? -1 : 1 }
      : sort.order === (numeric[column] ? -1 : 1) ? { column, order: -sort.order } : null,
  );
  const cell_style = c => ({ padding: '0 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: numeric[c] ? 'right' : 'left', fontVariantNumeric: numeric[c] ? 'tabular-nums' : undefined, display: 'flex', alignItems: 'center', justifyContent: numeric[c] ? 'flex-end' : 'flex-start' });
  return <div role="table" aria-rowcount={rows.length} style={{ fontSize: 12, border: '1px solid rgba(128, 128, 128, 0.3)', borderRadius: 2, maxWidth: '100%', overflowX: 'auto' }}>
    <div role="row" style={{ display: 'grid', gridTemplateColumns: template, fontWeight: 600, borderBottom: '1px solid rgba(128, 128, 128, 0.3)', minWidth: 'min-content' }}>
      {table.columns.map((column, c) => <div role="columnheader" key={c} aria-sort={sort?.column === c ? (sort.order > 0 ? 'ascending' : 'descending') : 'none'} style={{ ...cell_style(c), height: ROW_HEIGHT, cursor: 'pointer', userSelect: 'none' }} tabIndex={0} onClick={() => toggleSort(c)} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggleSort(c))} title={`Sort by ${column}`}>
        {numeric[c] && <Sparkline histogram={histograms[c]}/>}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{column}</span>
        {sort?.column === c && <Icon icon={sort.order > 0 ? 'caret-up' : 'caret-down'} size={12} style={{ marginLeft: 2 }}/>}
      </div>)}
    </div>
    <div ref={scroll} style={{ height, overflowY: 'auto', minWidth: 'min-content' }}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map(virtual => {
          const row = table.rows[rows[virtual.index]];
          const change = diff?.[rows[virtual.index]];
          return <div role="row" key={virtual.key} data-index={virtual.index} data-status={change?.status} style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${virtual.start}px)`, height: row_height, display: 'grid', gridTemplateColumns: template, borderBottom: '1px solid rgba(128, 128, 128, 0.12)', ...STATUS_STYLES[change?.status] }}>
            {table.columns.map((_, c) => {
              const changed = change?.changed.has(c);
              const was = changed ? change.ref_row[table.ref_columns?.[c] ?? c] : undefined;
              return <div role="cell" key={c} data-changed={changed || undefined} title={changed ? `${cellText(was) || '(empty)'} in the reference` : undefined} style={{ ...cell_style(c), ...(changed ? CHANGED_STYLE : {}) }}>
                <Cell cell={row[c]} output={change?.status === 'removed' ? output_ref : output} onOpen={setOpened}/>
              </div>;
            })}
          </div>;
        })}
      </div>
    </div>
    <Dialog isOpen={!!opened} onClose={() => setOpened(null)} title={opened?.title} style={{ width: 'auto', maxWidth: '90vw' }}>
      <DialogBody>{opened && <img src={opened.src} alt={opened.title} style={{ maxWidth: '80vw', maxHeight: '70vh', minWidth: 200, imageRendering: 'pixelated', display: 'block', margin: 'auto' }}/>}</DialogBody>
    </Dialog>
  </div>;
};

const useTable = (url, is_running) => {
  const query = useQuery(fileQuery(url, { is_running }));
  let table = null, error = query.error;
  if (query.data !== undefined) {
    try {
      table = parseTable(query.data);
    } catch (e) {
      error = e;
    }
  }
  return { table, error, pending: !!url && query.isPending };
};

// item_new, item_ref: the tables logged at the step (media.js), the reference's can be missing. identity: the runs'
// manifests { new, ref }, to tell whether images in cells changed
const TableView = ({ item_new, item_ref, output_new, output_ref, names, identity }) => {
  const { fileUrl } = useMediaContext();
  const [side, setSide] = useState('new');
  const [filter, setFilter] = useState('');
  const deferred_filter = useDeferredValue(filter);
  const [sort, setSort] = useState(null);
  const [key_column, setKeyColumn] = useState(null);
  const shown_side = item_ref ? side : 'new';
  const query_new = useTable(fileUrl(output_new, item_new.path), output_new?.is_running);
  const query_ref = useTable(item_ref ? fileUrl(output_ref, item_ref.path) : undefined, output_ref?.is_running);
  const both = !!query_new.table && !!query_ref.table;
  let table = null, diff = null, error, pending, path;
  if (shown_side === 'diff' && both) {
    const column = key_column ?? keyColumn(query_new.table);
    diff = diffTables(query_new.table, query_ref.table, column, identity);
    table = { columns: query_new.table.columns, rows: diff.map(d => d.row), ref_columns: query_new.table.columns.map(name => query_ref.table.columns.indexOf(name)) };
    path = item_new.path;
  } else {
    const query = shown_side === 'reference' ? query_ref : query_new;
    ({ table, error, pending } = query);
    if (shown_side === 'diff') ({ error, pending } = query_new.error ? query_new : query_ref);
    path = shown_side === 'reference' ? item_ref.path : item_new.path;
  }
  const output = shown_side === 'reference' ? output_ref : output_new;
  const shown = table ? tableRows(table, { filter: deferred_filter }).length : 0;
  const counts = diff ? ['changed', 'added', 'removed'].map(status => [status, diff.filter(d => d.status === status).length]).filter(([, n]) => n > 0) : [];
  return <div data-testid="table-view">
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0', flexWrap: 'wrap' }}>
      {item_ref && <ButtonGroup size="small">
        <Button active={shown_side === 'new'} onClick={() => setSide('new')} text={names.new}/>
        <Button active={shown_side === 'reference'} onClick={() => setSide('reference')} text={names.ref}/>
        <Button active={shown_side === 'diff'} onClick={() => setSide('diff')} icon="changes" text="Diff"/>
      </ButtonGroup>}
      {shown_side === 'diff' && query_new.table && <label style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        rows joined
        <HTMLSelect minimal value={key_column ?? keyColumn(query_new.table)} onChange={e => setKeyColumn(Number(e.target.value))} aria-label="Rows joined by"
          options={[{ value: BY_ROW, label: 'by row' }, ...query_new.table.columns.map((name, c) => ({ value: c, label: `by ${name}` }))]}/>
      </label>}
      <InputGroup size="small" leftIcon="search" placeholder="Filter rows" aria-label="Filter rows" value={filter} onChange={e => setFilter(e.target.value)} style={{ width: 180 }}/>
      {table && <span className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>
        {shown === table.rows.length ? `${table.rows.length} rows` : `${shown} of ${table.rows.length} rows`}
        {diff && (counts.length ? `: ${counts.map(([status, n]) => `${n} ${status}`).join(', ')}` : ', identical')}
      </span>}
    </div>
    {error ? <ViewerError path={path} error={error}/>
      : pending || !table ? <ViewerLoading height={120}/>
      : <Table table={table} output={output} output_ref={output_ref} filter={deferred_filter} sort={sort} onSortChange={setSort} diff={diff}/>}
  </div>;
};

export default TableView;
