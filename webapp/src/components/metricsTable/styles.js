// How the metrics tables look. `&&`: over Blueprint's table styles.
import styled from "styled-components";
import { Colors, HTMLTable } from "@blueprintjs/core";


// The table's view: the toolbar, notes, and the table. --qa-table-surface is under the header and the first column,
// that stay in view over the other cells.
export const TableArea = styled.div`
  --qa-table-surface: var(--qa-surface);
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

// The metrics picker, with the table's actions on its right
export const Toolbar = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 8px 12px;
  flex-wrap: wrap;
  & > .input {
    flex: 1 1 320px;
    min-width: 0;
  }
  & > .actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-left: auto;
    min-height: 30px;
  }
  .bp6-control {
    margin: 0;
  }
`;

const row_line = 'color-mix(in srgb, var(--qa-border) 50%, transparent)';
const edge_shadow = '6px 0 6px -4px rgba(0, 0, 0, 0.2)';

export const Table = styled(HTMLTable)`
  && {
    font-variant-numeric: tabular-nums;
  }
  && td {
    text-align: right;
    white-space: nowrap;
  }
  && td ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  && .same {
    color: var(--qa-text-muted);
  }
  && .empty {
    color: var(--qa-text-muted);
    opacity: 0.7;
  }

  /* the header: stays under the page's headers (TableScroller moves its .stick rows by --qa-stick) */
  && thead th {
    background: var(--qa-table-surface);
    vertical-align: bottom;
    text-align: right;
    white-space: nowrap;
  }
  && thead th[scope="colgroup"] {
    text-align: center;
  }
  && thead th:first-child {
    text-align: left;
  }
  && thead tr.stick > th {
    position: relative;
    z-index: 3;
    transform: translateY(var(--qa-stick, 0px));
  }
  && thead tr.stick-last > th {
    box-shadow: inset 0 -1px 0 ${row_line};
  }
  && thead[data-stuck] tr.stick-last > th {
    box-shadow: inset 0 -1px 0 var(--qa-border), 0 4px 4px -3px rgba(0, 0, 0, 0.2);
  }
  && thead th.sorted {
    background: color-mix(in srgb, var(--qa-intent-primary) 9%, var(--qa-table-surface));
  }
  && col.sorted {
    background: color-mix(in srgb, var(--qa-intent-primary) 4%, transparent);
  }

  /* metric headers: the label, then which way is better and the target or unit */
  && .metric-label {
    display: block;
  }
  && .metric-details {
    display: block;
    font-size: 11px;
    line-height: 14px;
    font-weight: 400;
    color: var(--qa-text-muted);
  }
  && .sort-button {
    all: unset;
    display: inline-block;
    cursor: pointer;
    border-radius: 2px;
  }
  && .sort-button:focus-visible {
    outline: 2px solid var(--qa-intent-primary);
    outline-offset: 2px;
  }
  && .sort-button:hover .metric-label,
  && .sort-button:hover .run-label {
    color: var(--qa-intent-primary);
  }
  && .sort-button .metric-label::after,
  && .sort-button .run-label::after {
    display: inline-block;
    width: 12px;
    font-size: 9px;
    text-align: right;
    vertical-align: 1px;
    content: "";
  }
  && .sort-button[data-sort="ascending"] .metric-label::after,
  && .sort-button[data-sort="ascending"] .run-label::after {
    content: "▲";
    color: var(--qa-intent-primary);
  }
  && .sort-button[data-sort="descending"] .metric-label::after,
  && .sort-button[data-sort="descending"] .run-label::after {
    content: "▼";
    color: var(--qa-intent-primary);
  }
  && th.sorted .metric-label {
    color: var(--qa-intent-primary);
  }

  /* the columns' summaries */
  && tr.summary-row > * {
    vertical-align: top;
    font-size: 11px;
    line-height: 15px;
    font-weight: 400;
    color: var(--qa-text-muted);
    padding-top: 6px;
    padding-bottom: 6px;
    box-shadow: inset 0 -1px 0 var(--qa-border);
  }
  && tr.summary-row > th {
    position: relative;
    z-index: 2;
    background: var(--qa-table-surface);
  }
  && tr.summary-row .number {
    color: var(--qa-text);
  }
  && .histogram {
    display: block;
    margin: 0 0 2px auto;
  }
  && .met.all {
    color: var(--qa-text-success);
  }
  && .met-bar {
    display: inline-block;
    width: 24px;
    height: 4px;
    margin-right: 4px;
    vertical-align: middle;
    border-radius: 2px;
    overflow: hidden;
    background: ${Colors.RED4};
  }
  && .met-bar > span {
    display: block;
    height: 100%;
    background: ${Colors.GREEN4};
  }
  && .changes-bar {
    display: flex;
    gap: 1px;
    width: 64px;
    height: 5px;
    margin: 3px 0 4px auto;
    border-radius: 2px;
    overflow: hidden;
  }
  && .segment-better { background: ${Colors.GREEN4}; }
  && .segment-worse { background: ${Colors.RED4}; }
  && .segment-changed { background: ${Colors.BLUE4}; }
  && .segment-same { background: var(--qa-border); }
  && .summary .better { color: var(--qa-text-success); }
  && .summary .worse { color: var(--qa-text-danger); }

  /* the runs: their names stay on the left when the table scrolls sideways */
  && tbody th {
    position: sticky;
    left: 0;
    z-index: 1;
    max-width: min(420px, 40vw);
    background: var(--qa-table-surface);
    text-align: left;
    /* one line per run, as dense as before: long names and tags end with "…", hovering the name tells everything */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  && thead tr > th:first-child {
    position: sticky;
    left: 0;
    z-index: 4;
  }
  && tr.summary-row > th:first-child {
    z-index: 2;
  }
  && tbody tr > * {
    box-shadow: inset 0 -1px 0 ${row_line};
  }
  && tbody tr:hover > * {
    background-image: linear-gradient(var(--qa-hover), var(--qa-hover));
  }
  /* failed runs: muted, with a red mark */
  && tbody tr[data-failed] > td {
    opacity: 0.55;
  }
  && tbody tr[data-failed] > th {
    box-shadow: inset 3px 0 0 var(--qa-text-danger), inset 0 -1px 0 ${row_line};
  }
  /* a shadow on the right of the first column, when columns scroll under it */
  [data-scrolled] && tr > th:first-child {
    box-shadow: inset 0 -1px 0 ${row_line}, ${edge_shadow};
  }
  [data-scrolled] && tbody tr[data-failed] > th {
    box-shadow: inset 3px 0 0 var(--qa-text-danger), inset 0 -1px 0 ${row_line}, ${edge_shadow};
  }
  && .run-label {
    display: inline-block;
  }
`;
