// Table bodies with thousands of rows: only the rows near the screen are rendered, as the page scrolls.
// https://tanstack.com/virtual/latest
// Small tables are rendered as usual, so that the browser's Ctrl+F finds everything.
import { useLayoutEffect, useRef, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";

// Batches usually have up to a few hundred runs
const VIRTUALIZE_ABOVE = 500;

// renderRow(item, index, measure): rows must set data-index={index} and ref={measure} on their <tr>, to measure their height.
// Both are undefined for small tables, and stable otherwise, so that rows can be memoized.
export const VirtualTbody = ({ items, renderRow, estimateSize = 31 }) => {
  if (items.length <= VIRTUALIZE_ABOVE)
    return <tbody>{items.map(item => renderRow(item))}</tbody>;
  return <VirtualizedTbody items={items} renderRow={renderRow} estimateSize={estimateSize}/>;
};

const VirtualizedTbody = ({ items, renderRow, estimateSize }) => {
  // TanStack Virtual's API isn't compatible with the React Compiler's memoization
  "use no memo";
  const tbody = useRef(null);
  // where the table starts in the page
  const [scroll_margin, setScrollMargin] = useState(0);
  // on every render: what's above the table can change size
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const top = tbody.current.getBoundingClientRect().top + window.scrollY;
    if (Math.abs(top - scroll_margin) > 1) setScrollMargin(top);
  });
  const virtualizer = useWindowVirtualizer({
    count: items.length,
    estimateSize: () => estimateSize,
    overscan: 15,
    scrollMargin: scroll_margin,
  });
  const rows = virtualizer.getVirtualItems();
  const before = rows.length > 0 ? rows[0].start - scroll_margin : 0;
  const after = rows.length > 0 ? virtualizer.getTotalSize() - (rows.at(-1).end - scroll_margin) : 0;
  return <tbody ref={tbody}>
    {before > 0 && <tr aria-hidden style={{ height: before }}/>}
    {rows.map(row => renderRow(items[row.index], row.index, virtualizer.measureElement))}
    {after > 0 && <tr aria-hidden style={{ height: after }}/>}
  </tbody>;
};
