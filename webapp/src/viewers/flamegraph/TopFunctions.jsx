// The "top functions" table: a table is how people find what got slower. Each function's self and total values,
// over all the stacks it's in, and how its self value changed against the reference. Clicking a row searches for it.
import { useState } from "react";
import { Button, HTMLTable, Tag } from "@blueprintjs/core";

import { formatDelta, formatPoints, formatShare, formatValue } from './profile';

const ROWS = 100;

const COLUMNS = [
  { key: 'self', label: 'Self', title: "Time in the function itself, not in what it calls" },
  { key: 'total', label: 'Total', title: "Time in the function and what it calls (each stack counted once, also when it's recursive)" },
  { key: 'change', label: 'Change', title: 'How its self value changed against the reference' },
];

const sortValue = (row, key, mode) => {
  if (key === 'change') return row.change ?? 0;
  if (mode === 'share') return key === 'self' ? row.self_share : row.total_share;
  return row[key];
};

export const TopFunctions = ({ rows, unit, mode, has_reference, matches, selected, onSelect, labels }) => {
  const [sort, setSort] = useState({ key: has_reference ? 'change' : 'self', descending: true });
  const [all, setAll] = useState(false);
  const key = !has_reference && sort.key === 'change' ? 'self' : sort.key;
  const filtered = matches ? rows.filter(r => matches(r.name)) : rows;
  const sorted = [...filtered].sort((a, b) => {
    const diff = sortValue(b, key, mode) - sortValue(a, key, mode);
    return (sort.descending ? diff : -diff) || (a.name < b.name ? -1 : 1);
  });
  const shown = all ? sorted : sorted.slice(0, ROWS);
  const columns = has_reference ? COLUMNS : COLUMNS.slice(0, 2);
  const label_ref = labels?.reference ?? 'reference';

  const header = column => {
    const active = key === column.key;
    return <th
      key={column.key}
      className="qa-flame-number"
      aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : 'none'}
      title={column.title}
    >
      <button
        type="button"
        className="qa-flame-sort"
        onClick={() => setSort({ key: column.key, descending: active ? !sort.descending : true })}
      >
        {column.label}{active ? (sort.descending ? ' ↓' : ' ↑') : ''}
      </button>
    </th>;
  };

  return <div>
    <div className="qa-flame-toolbar" style={{ marginTop: 10 }}>
      <strong>Top functions</strong>
      <span className="qa-flame-muted">
        {filtered.length.toLocaleString('en-US')} {matches ? 'matching ' : ''}function{filtered.length === 1 ? '' : 's'}
        {has_reference && (mode === 'share' ? ` · Change: of the self share, in percentage points, vs ${label_ref}` : ` · Change: of the self value, vs ${label_ref}`)}
        {' · Click a function to find it in the flame graph'}
      </span>
    </div>
    <div className="qa-flame-table-scroll">
      <HTMLTable compact className="qa-flame-table">
        <thead>
          <tr>
            <th>Function</th>
            {columns.map(header)}
          </tr>
        </thead>
        <tbody>
          {shown.map(row => {
            const is_selected = row.name === selected;
            const change_class = row.change > 0 ? 'qa-flame-slower' : row.change < 0 ? 'qa-flame-faster' : undefined;
            return <tr
              key={row.name}
              tabIndex={0}
              className={is_selected ? 'qa-flame-selected' : undefined}
              aria-selected={is_selected}
              onClick={() => onSelect(is_selected ? null : row.name)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(is_selected ? null : row.name); } }}
            >
              <td className="qa-flame-function">
                {row.name}
                {row.is_new && <Tag minimal intent="warning" style={{ marginLeft: 6 }}>new</Tag>}
                {row.is_removed && <Tag minimal style={{ marginLeft: 6 }}>removed</Tag>}
              </td>
              <td className="qa-flame-number">{formatValue(row.self, unit)} <span className="qa-flame-muted">{formatShare(row.self_share)}</span></td>
              <td className="qa-flame-number">{formatValue(row.total, unit)} <span className="qa-flame-muted">{formatShare(row.total_share)}</span></td>
              {has_reference && <td className={`qa-flame-number ${change_class ?? ''}`}>
                {mode === 'share' ? formatPoints(row.change) : formatDelta(row.change, unit)}
              </td>}
            </tr>;
          })}
        </tbody>
      </HTMLTable>
    </div>
    {sorted.length > ROWS && <Button variant="minimal" size="small" onClick={() => setAll(!all)} style={{ marginTop: 4 }}>
      {all ? `Show the first ${ROWS}` : `Show all ${sorted.length.toLocaleString('en-US')}`}
    </Button>}
  </div>;
};
