// A page with the JUnit viewer alone, with generated reports: npm start, then open /junit-viewer.html
// ?tests=50000 for a bigger report, ?dark for the dark theme, ?new=<url>&ref=<url> for your own reports
// (e.g. files in webapp/public/)
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Classes } from '@blueprintjs/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import "normalize.css";
import "@blueprintjs/core/lib/css/blueprint.css";
import "@blueprintjs/icons/lib/css/blueprint-icons.css";
import "../../App.css";

import { JunitReport } from './JunitViewer';

const params = new URLSearchParams(window.location.search);
const count = parseInt(params.get('tests') || '3000', 10);
if (params.has('dark')) document.documentElement.classList.add(Classes.DARK);

const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const PACKAGES = ['codec', 'planning', 'battery', 'missions', 'client', 'telemetry', 'maps', 'auth'];

// A report of `count` tests in packages, modules and classes. The reference differs: some tests fail, flake, are
// added, removed or slower.
function report(reference) {
  const cases = [];
  for (let i = 0; i < count; i++) {
    const pkg = PACKAGES[i % PACKAGES.length];
    const module = `test_${pkg}_${Math.floor(i / 97) % 12}`;
    const klass = i % 5 === 0 ? `.Test${pkg[0].toUpperCase()}${pkg.slice(1)}` : '';
    const name = `test_case_${i}${i % 3 === 0 ? `[seed-${i % 17}]` : ''}`;
    if (!reference && i % 211 === 7) continue;         // removed
    if (reference && i % 173 === 11) continue;         // added
    // the same time in both reports, but for a few slower tests
    let time = (((i * 2654435761) % 1000) / 1000) ** 6 * 2;
    if (!reference && i % 389 === 5) time *= 6;        // slower
    let body = '';
    const failing = reference ? i % 131 === 3 : (i % 131 === 3 && i % 2) || i % 157 === 9;
    if (failing)
      body = `<failure message="${escape(`AssertionError: assert decode(encode(${i})) == ${i}`)}" type="AssertionError">${escape(
        `def test_case_${i}():\n    value = ${i} << 32\n>   assert decode(encode(value)) == value\nE   AssertionError: assert ${i} == ${i << 3}\nE    +  where ${i} = decode(b'\\x80\\x80\\x80\\x80\\x10')\n\ntests/${pkg}/${module}.py:${10 + i % 90}: AssertionError`)}</failure>`;
    else if (!reference && i % 293 === 13)
      body = `<flakyFailure message="TimeoutError: no ack after 2.0 s" type="TimeoutError"><stackTrace>Traceback: client.send() timed out</stackTrace></flakyFailure>`;
    else if (i % 97 === 50)
      body = `<skipped message="needs a GPU"/>`;
    if (i % 401 === 0) body += `<system-out>${escape(`connecting to sim-${i}\nsent 12 frames\nreceived 11 acks`)}</system-out>`;
    cases.push(`<testcase classname="tests.${pkg}.${module}${klass}" name="${name}" file="tests/${pkg}/${module}.py" line="${10 + i % 90}" time="${time.toFixed(4)}">${body}</testcase>`);
  }
  return `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest">${cases.join('\n')}</testsuite></testsuites>`;
}

const get = url => fetch(url).then(r => r.ok ? r.text() : Promise.reject(new Error(`${url}: ${r.status}`)));
let xml, ref_xml;
if (params.has('new')) {
  [xml, ref_xml] = await Promise.all([get(params.get('new')), params.has('ref') ? get(params.get('ref')) : null]);
} else {
  const t0 = performance.now();
  xml = report(false);
  ref_xml = report(true);
  console.log(`generated ${count} tests in ${Math.round(performance.now() - t0)} ms, ${(xml.length / 1e6).toFixed(1)} MB`);
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <div style={{ padding: 16, maxWidth: 1180, margin: '0 auto', background: 'var(--qa-background)', minHeight: '100vh' }}>
        <h3 style={{ marginTop: 0 }}>junit.xml</h3>
        <JunitReport xml={xml} ref_xml={ref_xml} path="junit.xml" labels={{ new: 'agent/fix-ci', reference: 'main' }}/>
      </div>
    </QueryClientProvider>
  </StrictMode>,
);
