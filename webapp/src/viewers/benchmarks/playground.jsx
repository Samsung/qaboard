// A page with the benchmark viewer alone, with generated files: npm start, then open /benchmark-viewer.html
// ?benchmarks=5000 for a bigger suite, ?dark for the dark theme, ?single without a reference, ?other-machine for
// a reference from another CPU, ?new=<url>&ref=<url> for your own files (e.g. files in webapp/public/), with
// ?name=, ?new_label= and ?ref_label= for the title and the runs' names
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Classes } from '@blueprintjs/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import "normalize.css";
import "@blueprintjs/core/lib/css/blueprint.css";
import "@blueprintjs/icons/lib/css/blueprint-icons.css";
import "../../App.css";

import { BenchmarksReport } from './BenchmarksReport';
import { side_color } from '../../sideColors';

const params = new URLSearchParams(window.location.search);
const count = parseInt(params.get('benchmarks') || '400', 10);
if (params.has('dark')) document.documentElement.classList.add(Classes.DARK);

const MODULES = ['codec', 'planning', 'telemetry', 'maps', 'auth', 'battery'];
const SIZES = [64, 512, 4096, 65536];
// deterministic noise in [0, 1)
const random = (i, salt) => ((((i + 1) * 2654435761) ^ (salt * 2246822519)) >>> 0) / 4294967296;

// A pytest-benchmark file of `count` benchmarks in modules, with sizes as parameters. The reference differs: a few
// benchmarks are slower or faster beyond noise, most within it, some are new or gone.
function pytestBenchmark(reference) {
  const benchmarks = [];
  for (let i = 0; i < count; i++) {
    const module = MODULES[i % MODULES.length];
    const size = SIZES[Math.floor(i / MODULES.length) % SIZES.length];
    const name = `test_${['encode', 'decode', 'lookup', 'merge', 'parse'][Math.floor(i / 24) % 5]}_${Math.floor(i / 120)}[${size}]`;
    if (!reference && i % 157 === 11) continue;        // gone
    if (reference && i % 131 === 7) continue;          // new
    let mean = (2e-7 + random(i, 1) ** 3 * 4e-4) * (size / 64) ** 0.6;
    const stddev = mean * (0.01 + random(i, 2) * 0.05);
    let jitter = (random(i, reference ? 3 : 4) - 0.5) * stddev * 1.2;
    if (!reference && i % 37 === 5) jitter = mean * (0.08 + random(i, 5) * 0.6);   // slower
    if (!reference && i % 53 === 9) jitter = -mean * (0.06 + random(i, 6) * 0.3);  // faster
    mean += jitter;
    const rounds = Math.round(5 + random(i, 7) * 50000);
    benchmarks.push({
      group: module, name, fullname: `tests/test_${module}.py::${name}`, params: { size }, param: String(size),
      stats: {
        min: mean * 0.92, max: mean * 2.4, mean, stddev, median: mean * 0.98, iqr: stddev * 0.9, rounds,
        iterations: mean < 1e-5 ? 100 : 1, ops: 1 / mean,
      },
    });
  }
  const same_machine = !reference || !params.has('other-machine');
  return JSON.stringify({
    machine_info: {
      node: same_machine ? 'ci-runner-07' : 'ci-runner-12', machine: 'x86_64', system: 'Linux', release: '6.8.0-45-generic',
      cpu: { brand_raw: same_machine ? 'AMD EPYC 7763 64-Core Processor' : 'Intel(R) Xeon(R) Platinum 8375C CPU @ 2.90GHz', count: same_machine ? 8 : 4 },
    },
    benchmarks,
    datetime: reference ? '2026-11-01T22:10:41.120934+00:00' : '2026-11-02T09:15:02.418935+00:00',
    version: '5.1.0',
  });
}

const get = url => fetch(url).then(r => r.ok ? r.text() : Promise.reject(new Error(`${url}: ${r.status}`)));
let text, ref_text;
if (params.has('new')) {
  [text, ref_text] = await Promise.all([get(params.get('new')), params.has('ref') ? get(params.get('ref')) : null]);
} else {
  const t0 = performance.now();
  text = pytestBenchmark(false);
  ref_text = params.has('single') ? null : pytestBenchmark(true);
  console.log(`generated ${count} benchmarks in ${Math.round(performance.now() - t0)} ms, ${(text.length / 1e6).toFixed(1)} MB`);
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <div style={{ padding: 16, maxWidth: 1180, margin: '0 auto', background: 'var(--qa-background)', minHeight: '100vh' }}>
        <h3 style={{ marginTop: 0 }}>{params.get('name') || 'pytest.benchmarks.json'}</h3>
        <BenchmarksReport text={text} ref_text={ref_text} path="pytest.benchmarks.json" labels={{ new: params.get('new_label') || 'agent/faster-codec', reference: params.get('ref_label') || 'main', colors: { new: side_color(0), reference: side_color(1) } }}/>
      </div>
    </QueryClientProvider>
  </StrictMode>,
);
