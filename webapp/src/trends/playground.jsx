// The trends over commits alone, with generated commits: npm start, then open /trends.html
// ?commits=100&tests=20000&benchmarks=600 for more, ?dark for the dark theme, ?only=tiles|report for one of them.
import { StrictMode, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { Card, Classes, FocusStyleManager } from '@blueprintjs/core';
import "normalize.css";
import "@blueprintjs/core/lib/css/blueprint.css";
import "@blueprintjs/icons/lib/css/blueprint-icons.css";
import "../App.css";

import { TrendsReport, TrendsTiles, useTrends } from './Trends';
import { generate } from './generate';

FocusStyleManager.onlyShowFocusOnTabs();
const params = new URLSearchParams(window.location.search);
const number = (name, fallback) => parseInt(params.get(name) || String(fallback), 10);
if (params.has('dark')) document.documentElement.classList.add(Classes.DARK);
const only = params.get('only');

const t0 = performance.now();
const { points, definitions, reports } = generate({ commits: number('commits', 60), tests: number('tests', 1200), benchmarks: number('benchmarks', 120) });
console.log(`generated ${points.length} commits in ${Math.round(performance.now() - t0)} ms`);
const report_of = new Map(points.map((point, i) => [point.id, reports[i]]));
// like reading a file from the server: not right away
const loadTests = point => new Promise(resolve => setTimeout(() => resolve([{ name: 'junit.xml', tests: report_of.get(point.id) }]), 15));

const Page = () => {
  const trends = useTrends(points, definitions);
  const open = useMemo(() => anchor => document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), []);
  return <div style={{ padding: 16, maxWidth: 1180, margin: '0 auto', background: 'var(--qa-background)', minHeight: '100vh' }}>
    {only !== 'report' && <>
      <h4 className={Classes.HEADING}>Above a branch's commits</h4>
      <TrendsTiles points={points} trends={trends} onOpen={open}/>
    </>}
    {only !== 'tiles' && <>
      <h4 className={Classes.HEADING} style={{ marginTop: 24 }}>On the Trends page</h4>
      <Card><TrendsReport points={points} trends={trends} loadTests={loadTests} onSelect={point => console.log('select', point.label)}/></Card>
    </>}
  </div>;
};

createRoot(document.getElementById('root')).render(<StrictMode><Page/></StrictMode>);
