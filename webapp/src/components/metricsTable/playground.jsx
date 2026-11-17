// The Metrics Table and Metrics Diff alone, with generated runs: npm start, then open /metrics-table.html
// ?runs=2000&metrics=30 for bigger tables, ?view=kpi|diff for one of them, ?dark for the dark theme, ?sticky=0 without sticky headers.
// Like the commit page, a fixed header covers the top of the window, and the views' sections hide their overflow.
import { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Card, Classes, FocusStyleManager } from '@blueprintjs/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import "normalize.css";
import "@blueprintjs/core/lib/css/blueprint.css";
import "@blueprintjs/icons/lib/css/blueprint-icons.css";
import "../../App.css";

import { TableKpi, TableCompare } from '../tables';
import { ComparisonContext } from '../../hooks';
import { side_color } from '../../sideColors';
import { metrics_fill_defaults } from '../../utils';
import { sorted_ids } from '../../selectors/sorting';

FocusStyleManager.onlyShowFocusOnTabs();
const params = new URLSearchParams(window.location.search);
const run_count = parseInt(params.get('runs') || '300', 10);
const metric_count = parseInt(params.get('metrics') || '12', 10);
const view = params.get('view');
if (params.has('dark')) document.documentElement.classList.add(Classes.DARK);

// a deterministic random, so that screenshots don't change
let seed = 7;
const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gauss = () => Math.sqrt(-2 * Math.log(random() + 1e-9)) * Math.cos(2 * Math.PI * random());

// declared metrics with targets, some without, and others that weren't declared (direction unknown)
const declared = {
  psnr: { label: 'PSNR', short_label: 'PSNR', suffix: ' dB', target: 30, smaller_is_better: false, description: 'Peak signal-to-noise ratio vs the ground truth.' },
  ssim: { label: 'SSIM', target: 0.9, smaller_is_better: false, precision: 3 },
  runtime: { label: 'Runtime', suffix: ' ms', scale: 1000, target: 0.05, description: 'Wall-clock time of the pipeline.' },
  overshoot: { label: 'Edge overshoot', short_label: 'Overshoot', suffix: '%', scale: 100, target: 0.05 },
  memory: { label: 'Peak memory', short_label: 'Memory', suffix: ' MB' },
  frames: { label: 'Frames', smaller_is_better: false },
};
const available_metrics = metrics_fill_defaults(declared);
const keys = [...Object.keys(declared), 'status', ...Array.from({ length: Math.max(0, metric_count - 7) }, (_, i) => `undeclared_${i}`)].slice(0, metric_count);
const base = { psnr: 31, ssim: 0.92, runtime: 0.042, overshoot: 0.04, memory: 812, frames: 120 };
const value = (key, i, ref) => {
  if (key === 'status') return i % 37 === 0 && !ref ? { text: 'drift', intent: 'warning', minimal: true } : 'ok';
  if (key === 'frames') return 100 + (i % 7) * 10;
  // the new runs are slightly better on PSNR, slower, and some change nothing
  const shift = ref ? 0 : key === 'psnr' ? 0.4 : key === 'runtime' ? 0.003 : 0;
  if (!ref && i % 3 === 0) return undefined;
  const b = base[key] ?? 10 ** ((i * 7 + key.length) % 5 - 2);
  return b + shift + b * 0.06 * gauss();
};

const DATABASES = ['kitti', 'cityscapes', 'night'];
const ref_outputs = {};
const new_outputs = {};
for (let i = 0; i < run_count; i++) {
  const input = `${DATABASES[i % 3]}/scene_${String(Math.floor(i / 3)).padStart(4, '0')}.png`;
  const ref_metrics = Object.fromEntries(keys.map(k => [k, value(k, i, true)]));
  const new_metrics = Object.fromEntries(keys.map(k => {
    const v = value(k, i, false);
    return [k, v === undefined ? ref_metrics[k] : v];
  }));
  if (i % 11 === 4) delete new_metrics.memory;
  ref_outputs[`r${i}`] = { id: `r${i}`, test_input_path: input, configurations: ['base'], extra_parameters: {}, metrics: ref_metrics };
  new_outputs[`n${i}`] = {
    id: `n${i}`, test_input_path: input, configurations: ['base'], extra_parameters: {}, platform: 'linux',
    metrics: new_metrics, reference_id: `r${i}`, is_failed: i % 29 === 5,
  };
}
const used_metrics = new Set(keys);
const labels = { new: 'feature/denoise', reference: 'main', colors: { new: side_color(0), reference: side_color(1) } };
const ref_batch = { outputs: ref_outputs, filtered: { outputs: Object.keys(ref_outputs) } };

const Page = () => {
  const [sort, setSort] = useState({ by: 'psnr', order: -1 });
  const new_batch = useMemo(() => ({
    outputs: new_outputs,
    filtered: { outputs: sorted_ids(Object.keys(new_outputs), new_outputs, sort.by, sort.order, ref_outputs) },
    used_metrics,
    metrics_with_refs: used_metrics,
  }), [sort]);
  const sorting = { ...sort, default_by: 'test_input_path' };
  const props = {
    new_batch, ref_batch, available_metrics, metrics: keys, labels: [labels.new, labels.reference],
    sorting, onSort: setSort, stickyTop: params.get('sticky') === '0' ? undefined : 64,
    input: <div className={Classes.INPUT} style={{ height: 30, lineHeight: '30px', color: 'var(--qa-text-muted)' }}>Choose metrics…</div>,
  };
  return <>
    <header style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 64, zIndex: 20, background: 'var(--qa-sider-background)', color: '#fff', display: 'flex', alignItems: 'center', padding: '0 24px' }}>
      Fixed page header (64px): the tables' headers stay under it
    </header>
    <div style={{ padding: '88px 24px 600px', maxWidth: 1180, margin: '0 auto' }}>
      {view !== 'kpi' && <>
        <h2 className={Classes.HEADING}>Metrics Diff</h2>
        <section style={{ overflow: 'hidden', marginBottom: 32 }}><Card><TableCompare {...props}/></Card></section>
      </>}
      {view !== 'diff' && <>
        <h2 className={Classes.HEADING}>Metrics Table</h2>
        <section style={{ overflow: 'hidden' }}><Card><TableKpi {...props}/></Card></section>
      </>}
    </div>
  </>;
};

document.body.style.background = 'var(--qa-background)';
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ComparisonContext.Provider value={{ labels }}>
        <Page/>
      </ComparisonContext.Provider>
    </QueryClientProvider>
  </StrictMode>,
);
