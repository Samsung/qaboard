// Sizes and the bars that compare them
import { Classes, Colors } from "@blueprintjs/core";
import styled from "styled-components";


// Decimal units, like IT's quota reports and `df -H`: 1 GB = 1000³ bytes
export const formatBytes = bytes => {
  if (bytes === null || bytes === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = Number(bytes);
  let unit = 0;
  while (size >= 1000 && unit < units.length - 1) {
    size /= 1000;
    unit += 1;
  }
  return unit === 0 ? `${size} B` : `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
};

export const formatNumber = value => (value ?? 0).toLocaleString('en-US');
export const plural = (count, word, words = `${word}s`) => `${formatNumber(count)} ${count === 1 ? word : words}`;

const Bar = styled.div`
  height: 6px;
  border-radius: 3px;
  background: var(--qa-border, ${Colors.LIGHT_GRAY3});
  overflow: hidden;
  min-width: 60px;
  > div {
    height: 100%;
    background: ${Colors.BLUE3};
  }
`;

// A size, with a bar showing its share of the largest
export const SizeBar = ({ bytes, max }) => <div style={{ minWidth: 110 }}>
  <div style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{formatBytes(bytes)}</div>
  <Bar aria-hidden="true"><div style={{ width: `${max ? Math.max(2, Math.round(100 * bytes / max)) : 0}%` }}/></Bar>
</div>;

// Long paths: the end matters most
export const Path = ({ path, style }) => path
  ? <code className={Classes.MONOSPACE_TEXT} title={path} style={{ display: 'block', direction: 'rtl', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 360, fontSize: 12, ...style }}>
    &lrm;{path}&lrm;
  </code>
  : <span className={Classes.TEXT_MUTED}>—</span>;

// One line, cut with "…" when too long: the whole text on hover
export const Ellipsis = ({ title, children, style, ...props }) => <div
  title={title}
  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, ...style }}
  {...props}
>{children}</div>;
