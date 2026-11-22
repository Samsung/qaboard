// A table logged at a step (its .table.json): sortable columns, a filter, rows drawn as they scroll into view, image
// cells as thumbnails. The reference's table at the same step is a click away.
import { useDeferredValue, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button, ButtonGroup, Classes, Dialog, DialogBody, Icon, InputGroup } from "@blueprintjs/core";

import { fileQuery } from "../../api/queries";
import { ViewerError, ViewerLoading } from "../ViewerStates";
import { useMediaContext } from "./context";
import { cellText, is_media_cell, numericColumns, parseTable, tableRows } from "./table";

const ROW_HEIGHT = 30;
const IMAGE_ROW_HEIGHT = 52;
const MAX_HEIGHT = 420;

const format_number = value => Number.isInteger(value) ? String(value) : Math.abs(value) >= 1e5 || (value !== 0 && Math.abs(value) < 1e-3) ? value.toExponential(3) : String(+value.toPrecision(5));

const Cell = ({ cell, output, onOpen }) => {
  const { fileUrl } = useMediaContext();
  if (is_media_cell(cell)) {
    if (cell.kind === 'image') {
      const src = fileUrl(output, cell.path);
      return <img src={src} alt={cell.caption ?? cell.path} title={cell.caption ?? cell.path} loading="lazy"
        style={{ height: IMAGE_ROW_HEIGHT - 8, maxWidth: 120, objectFit: 'contain', cursor: 'zoom-in', imageRendering: 'pixelated' }}
        onClick={() => onOpen({ src, title: cell.caption ?? cell.path })}/>;
    }
    return <a href={fileUrl(output, cell.path)} target="_blank" rel="noopener noreferrer"><Icon icon="document" size={12}/> {cell.path.split('/').pop()}</a>;
  }
  if (typeof cell === 'number') return format_number(cell);
  if (cell === null || cell === undefined) return <span className={Classes.TEXT_DISABLED}>—</span>;
  return cellText(cell);
};

export const Table = ({ table, output, filter, sort, onSortChange }) => {
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
  const template = table.columns.map((_, c) => numeric[c] ? 'minmax(70px, max-content)' : 'minmax(90px, 1fr)').join(' ');
  const toggleSort = column => onSortChange(
    sort?.column !== column ? { column, order: numeric[column] ? -1 : 1 }
      : sort.order === (numeric[column] ? -1 : 1) ? { column, order: -sort.order } : null,
  );
  const cell_style = c => ({ padding: '0 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: numeric[c] ? 'right' : 'left', fontVariantNumeric: numeric[c] ? 'tabular-nums' : undefined, display: 'flex', alignItems: 'center', justifyContent: numeric[c] ? 'flex-end' : 'flex-start' });
  return <div role="table" aria-rowcount={rows.length} style={{ fontSize: 12, border: '1px solid rgba(128, 128, 128, 0.3)', borderRadius: 2, maxWidth: '100%', overflowX: 'auto' }}>
    <div role="row" style={{ display: 'grid', gridTemplateColumns: template, fontWeight: 600, borderBottom: '1px solid rgba(128, 128, 128, 0.3)', minWidth: 'min-content' }}>
      {table.columns.map((column, c) => <div role="columnheader" key={c} aria-sort={sort?.column === c ? (sort.order > 0 ? 'ascending' : 'descending') : 'none'} style={{ ...cell_style(c), height: ROW_HEIGHT, cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort(c)} title={`Sort by ${column}`}>
        {column}
        {sort?.column === c && <Icon icon={sort.order > 0 ? 'caret-up' : 'caret-down'} size={12} style={{ marginLeft: 2 }}/>}
      </div>)}
    </div>
    <div ref={scroll} style={{ height, overflowY: 'auto', minWidth: 'min-content' }}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map(virtual => {
          const row = table.rows[rows[virtual.index]];
          return <div role="row" key={virtual.key} data-index={virtual.index} style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${virtual.start}px)`, height: row_height, display: 'grid', gridTemplateColumns: template, borderBottom: '1px solid rgba(128, 128, 128, 0.12)' }}>
            {table.columns.map((_, c) => <div role="cell" key={c} style={cell_style(c)}><Cell cell={row[c]} output={output} onOpen={setOpened}/></div>)}
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

// item_new, item_ref: the tables logged at the step (media.js), the reference's can be missing
const TableView = ({ item_new, item_ref, output_new, output_ref, names }) => {
  const { fileUrl } = useMediaContext();
  const [side, setSide] = useState('new');
  const [filter, setFilter] = useState('');
  const deferred_filter = useDeferredValue(filter);
  const [sort, setSort] = useState(null);
  const shown_side = item_ref ? side : 'new';
  const query_new = useTable(fileUrl(output_new, item_new.path), output_new?.is_running);
  const query_ref = useTable(item_ref ? fileUrl(output_ref, item_ref.path) : undefined, output_ref?.is_running);
  const { table, error, pending } = shown_side === 'new' ? query_new : query_ref;
  const output = shown_side === 'new' ? output_new : output_ref;
  const path = shown_side === 'new' ? item_new.path : item_ref.path;
  const shown = table ? tableRows(table, { filter: deferred_filter }).length : 0;
  return <div data-testid="table-view">
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0', flexWrap: 'wrap' }}>
      {item_ref && <ButtonGroup size="small">
        <Button active={shown_side === 'new'} onClick={() => setSide('new')} text={names.new}/>
        <Button active={shown_side === 'reference'} onClick={() => setSide('reference')} text={names.ref}/>
      </ButtonGroup>}
      <InputGroup size="small" leftIcon="search" placeholder="Filter rows" aria-label="Filter rows" value={filter} onChange={e => setFilter(e.target.value)} style={{ width: 180 }}/>
      {table && <span className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>
        {shown === table.rows.length ? `${table.rows.length} rows` : `${shown} of ${table.rows.length} rows`}
      </span>}
    </div>
    {error ? <ViewerError path={path} error={error}/>
      : pending || !table ? <ViewerLoading height={120}/>
      : <Table table={table} output={output} filter={deferred_filter} sort={sort} onSortChange={setSort}/>}
  </div>;
};

export default TableView;
