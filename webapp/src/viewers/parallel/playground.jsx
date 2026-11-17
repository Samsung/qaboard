// A page with the parallel coordinates plot alone, with generated tuning experiments: npm start, then open
// /parallel-coordinates.html. ?kind=grid (3 parameters x 3 values), ?kind=optuna (300 iterations, the default),
// ?kind=mixed (every type, missing values, a constant column, long names), ?rows=5000&columns=40 for more,
// ?dark for the dark theme, ?height=600, ?empty for the empty state. See generate.js for the data.
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Classes, Switch } from '@blueprintjs/core';
import "normalize.css";
import "@blueprintjs/core/lib/css/blueprint.css";
import "@blueprintjs/icons/lib/css/blueprint-icons.css";
import "../../App.css";

import { ParallelCoordinates } from './ParallelCoordinates';
import { generate } from './generate';

const params = new URLSearchParams(window.location.search);
const kind = params.get('kind') || 'optuna';
const number = name => params.has(name) ? parseInt(params.get(name), 10) : undefined;

const t0 = performance.now();
const data = params.has('empty')
  ? { columns: [], rows: [], marks: {} }
  : generate({ kind, rows: number('rows'), columns: number('columns') });
console.log(`generated ${data.rows.length} rows x ${data.columns.length} columns in ${Math.round(performance.now() - t0)} ms`);

// how long the plot takes: window.__parallel_timings.hover is what a move of the mouse costs (hit test, overlay, tooltip)
const timings = window.__parallel_timings = {};
const onTiming = ({ what, ms }) => { (timings[what] ??= []).push(ms); };

const PRESETS = [
  ['Grid search', '?kind=grid'],
  ['Optimization, 300 iterations', '?kind=optuna'],
  ['Every type, missing values', '?kind=mixed'],
  ['2,000 x 30', '?kind=optuna&rows=2000&columns=30'],
  ['5,000 x 45', '?kind=mixed&rows=5000&columns=45'],
  ['Empty', '?empty'],
];

function Playground() {
  const [dark, setDark] = useState(params.has('dark'));
  const [selection, setSelection] = useState(null);
  const [hovered, setHovered] = useState(null);
  const [clicked, setClicked] = useState(null);
  useEffect(() => { document.documentElement.classList.toggle(Classes.DARK, dark); }, [dark]);
  return <div style={{ padding: 16, maxWidth: number('width') ?? 1212, margin: '0 auto', background: 'var(--qa-background)', minHeight: '100vh', color: 'var(--qa-text)' }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 12 }}>
      <h3 style={{ margin: 0 }}>Tuning analysis</h3>
      {PRESETS.map(([name, search]) => <a key={search} href={`${search}${dark ? '&dark' : ''}`}>{name}</a>)}
      <span style={{ flex: 1 }}/>
      <Switch checked={dark} onChange={e => setDark(e.target.checked)} label="Dark" style={{ margin: 0 }}/>
    </div>
    <div style={{ padding: 12, background: 'var(--qa-surface)', border: '1px solid var(--qa-border)', borderRadius: 4 }}>
      <ParallelCoordinates
        columns={data.columns}
        rows={data.rows}
        colorBy={data.colorBy}
        marks={data.marks}
        height={number('height') ?? 440}
        onSelectionChange={setSelection}
        onHover={setHovered}
        onRowClick={setClicked}
        onTiming={onTiming}
        tooltipExtra={row => row.id === 'run-0' ? <em>The settings before tuning</em> : null}
      />
    </div>
    <p id="status" style={{ marginTop: 12, color: 'var(--qa-text-muted)' }}>
      {selection ? `${selection.length} rows pass the filters (${selection.slice(0, 6).join(', ')}${selection.length > 6 ? '…' : ''})` : 'No filter'}
      {' · '}hovered: {hovered?.label ?? 'none'}{' · '}clicked: {clicked?.label ?? 'none'}
    </p>
  </div>;
}

createRoot(document.getElementById('root')).render(<StrictMode><Playground/></StrictMode>);
