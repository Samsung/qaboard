// Trends over a branch's commits, for the app: what src/trends/ draws (standalone, loaded on demand) from the commits
// the pages already list. Shown without configuration when the runs' metrics say how they group and add up
// (`group`, `part_of`... in their definitions), which `qa upload` does for test reports and benchmark files.
// - <HistoryTrends>: History's sections, from the commits with their runs,
// - <BranchTiles>: the headline numbers above a branch's commits.
import { lazy, Suspense, useCallback, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, Classes } from '@blueprintjs/core';

import { commitsQuery, fileQuery } from './api/queries';
import { history } from './router';
import { match_query } from './utils';
import { is_junit } from './viewers/fileTypes';
import { parseJunit } from './viewers/junit/parse';
import { trendsOf, hasTrends, hasGroups, compositionKeys } from './trends/model';
import { SectionErrorBoundary } from './components/ErrorFallback';

const TrendsReport = lazy(() => import('./trends/Trends').then(m => ({ default: m.TrendsReport })));
const TrendsTiles = lazy(() => import('./trends/Trends').then(m => ({ default: m.TrendsTiles })));

const commit_page = (project, commit, label) => {
  const search = label && label !== 'default' ? `?${new URLSearchParams({ batch: label, batch_ref: label })}` : '';
  return `/${project}/commit/${commit.id}${search}`;
};

// The commits that have the batch as points, oldest first: with their runs when the commits come with outputs,
// else with what the server aggregated.
export function pointsOf(commits, { project, batch_label = 'default' }) {
  return commits
    .filter(commit => !!commit.batches?.[batch_label])
    .map(commit => {
      const batch = commit.batches[batch_label];
      const outputs = batch.outputs ? Object.values(batch.outputs).filter(o => !o.is_pending && !o.deleted) : null;
      return {
        id: commit.id,
        label: commit.id.slice(0, 8),
        message: (commit.message ?? '').split('\n')[0],
        date: commit.authored_datetime,
        href: commit_page(project, commit, batch_label),
        ...(outputs
          ? { runs: outputs.map(output => ({ name: output.test_input_path, metrics: output.metrics ?? {}, output })) }
          : { aggregated: batch.aggregated_metrics ?? {} }),
      };
    })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// like the filter of the runs on the commit pages: words that must all match the input, platform or configurations
const run_filter_of = filter => {
  if (!filter) return undefined;
  const matches = match_query(filter);
  return run => matches(`${run.output.test_input_path} ${run.output.platform} ${JSON.stringify(run.output.configurations)}`.replace(/"/g, ''));
};

// The tests of a commit, from the JUnit reports among its runs' files. With several reports, tests are told apart by
// their run and file. null without reports.
function useLoadTests() {
  const queryClient = useQueryClient();
  return useCallback(async point => {
    const reports = [];
    for (const run of point.runs ?? []) {
      const dir = run.output?.output_dir_url;
      if (!dir) continue;
      const manifest = await queryClient.fetchQuery(fileQuery(`${dir}/manifest.outputs.json`)).catch(() => null);
      if (!manifest || typeof manifest !== 'object') continue;
      for (const path of Object.keys(manifest).filter(is_junit).sort()) {
        const xml = await queryClient.fetchQuery(fileQuery(`${dir}/${path}`, { responseType: 'text' })).catch(() => null);
        const { tests, error } = parseJunit(xml);
        // only what the history needs: the reports of a hundred commits are kept in memory
        if (!error) reports.push({ name: [run.name, path].filter(Boolean).join('/'), tests: tests.map(({ id, name, path, status, time }) => ({ id, name, path, status, time })) });
      }
    }
    if (reports.length === 0) return null;
    if (reports.length === 1) return reports[0].tests;
    return reports.flatMap(report => report.tests.map(test => ({ ...test, id: `${report.name}::${test.id}`, path: [report.name, ...test.path] })));
  }, [queryClient]);
}

const select = point => history.push(point.href);
const Loading = () => <div className={Classes.SKELETON} style={{ height: 120 }}/>;

// History's sections. `children(sections)` wraps them (the page's title and card) when there is something to show.
export function HistoryTrends({ project, commits, batch_label, available_metrics, filter, children }) {
  const points = useMemo(() => pointsOf(commits, { project, batch_label }), [commits, project, batch_label]);
  const trends = useMemo(() => trendsOf(points, available_metrics, { run_filter: run_filter_of(filter) }), [points, available_metrics, filter]);
  const loadTests = useLoadTests();
  const shown = hasTrends(trends);
  // links from the tiles: /history/main#trends-tests
  useEffect(() => {
    const anchor = window.location.hash.slice(1);
    if (!shown || !anchor.startsWith('trends-')) return undefined;
    const timer = setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ block: 'start' }), 300);
    return () => clearTimeout(timer);
  }, [shown]);
  if (!shown) return null;
  return children(<SectionErrorBoundary>
    <Suspense fallback={<Loading/>}>
      <TrendsReport points={points} trends={trends} loadTests={loadTests} onSelect={select}/>
    </Suspense>
  </SectionErrorBoundary>);
}

// Above a branch's commits. The list has what the server aggregated: enough for totals and their parts (tests).
// Groups of metrics (benchmarks) need the runs: we ask for them when the commits have few runs, as with uploads.
const MAX_RUNS = 2000;
export function BranchTiles({ project, branch, commits, date_range, available_metrics }) {
  const wants_runs = useMemo(() => hasGroups(available_metrics), [available_metrics]);
  const runs_count = commits.reduce((sum, commit) => sum + (commit.batches?.default?.valid_outputs ?? 0), 0);
  const { data: with_runs } = useQuery({
    ...commitsQuery({ project, branch, from: date_range[0].toISOString(), to: date_range[1].toISOString(), metrics: {}, with_outputs: true, only_ci_batches: true }),
    enabled: wants_runs && commits.length > 1 && runs_count <= MAX_RUNS,
  });
  const points = useMemo(() => pointsOf(with_runs ?? commits, { project }), [with_runs, commits, project]);
  const trends = useMemo(() => trendsOf(points, available_metrics), [points, available_metrics]);
  if (points.length < 2 || !hasTrends(trends)) return null;
  const open = anchor => history.push(`/${project}/history/${branch}#${anchor}`);
  return <SectionErrorBoundary>
    <Suspense fallback={null}>
      <TrendsTiles points={points} trends={trends} onOpen={open}/>
    </Suspense>
  </SectionErrorBoundary>;
}

// The first metric a chart over commits can show for projects that didn't choose one: a total (the tests)
export const default_trend_metric = available_metrics => compositionKeys(available_metrics).find(key => !available_metrics[key]?.part_of);

export const TrendsCard = ({ children }) => <Card>{children}</Card>;
