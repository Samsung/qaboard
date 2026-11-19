// Trends over a branch's commits, for the app: what src/trends/ draws (standalone, loaded on demand) from the commits
// the pages already list. Shown without configuration when the runs' metrics say how they group and add up
// (`group`, `part_of`... in their definitions), which `qa upload` does for test reports and benchmark files.
// - <HistoryTrends>: History's sections, from the commits with their runs,
// - <BranchTiles>: the headline numbers above a branch's commits.
import { lazy, Suspense, useCallback, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Classes } from '@blueprintjs/core';

import { commitsQuery, fileQuery } from './api/queries';
import { commit_page } from './components/CommitRow';
import { make_output_filter } from './CommitsEvolution';
import { manifestQuery } from './viewers/OutputCard';
import { hasGroups } from './metricGroups';
import { history } from './router';
import { path_segment } from './selection';
import { is_junit } from './viewers/fileTypes';
import { parseJunit } from './viewers/junit/parse';
import { trendsOf, hasTrends } from './trends/model';
import { SectionErrorBoundary } from './components/ErrorFallback';

const TrendsReport = lazy(() => import('./trends/Trends').then(m => ({ default: m.TrendsReport })));
const TrendsTiles = lazy(() => import('./trends/Trends').then(m => ({ default: m.TrendsTiles })));

// The commits that have the batch as points, oldest first.
// - with_runs: the commits came with their outputs (History): points have their runs, those that match `filter`,
//   like History's chart (make_output_filter), and count like the server's aggregates (not pending, failed or deleted). Otherwise points have what the server
//   aggregated: lists of commits always have `outputs`, empty (api/normalize.js), so we can't tell by looking.
export function pointsOf(commits, { project, batch_label = 'default', with_runs = false, filter }) {
  const matches = make_output_filter(filter ?? '');
  return commits
    .filter(commit => !!commit.batches?.[batch_label])
    .map(commit => {
      const batch = commit.batches[batch_label];
      return {
        id: commit.id,
        label: commit.id.slice(0, 8),
        message: (commit.message ?? '').split('\n')[0],
        date: commit.authored_datetime,
        href: commit_page(project, commit, batch_label),
        ...(with_runs
          ? { runs: Object.values(batch.outputs ?? {})
              .filter(o => !o.is_pending && !o.is_failed && !o.deleted && matches(o))
              .map(output => ({ name: output.test_input_path, metrics: output.metrics ?? {}, output })) }
          : { aggregated: batch.aggregated_metrics ?? {} }),
      };
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

// The test reports of a commit: the JUnit files among its runs' files, [{name, tests}], or null without any.
// A commit's runs can be thousands: we read those of the first MAX_RUNS_READ, enough for runs that upload reports.
const MAX_RUNS_READ = 20;
function useLoadTests() {
  const queryClient = useQueryClient();
  return useCallback(async point => {
    const reports = [];
    for (const run of (point.runs ?? []).slice(0, MAX_RUNS_READ)) {
      const dir = run.output?.output_dir_url;
      if (!dir) continue;
      const manifest = await queryClient.fetchQuery(manifestQuery(run.output)).catch(() => null);
      if (!manifest || typeof manifest !== 'object') continue;
      for (const path of Object.keys(manifest).filter(is_junit).sort()) {
        // the reports of a hundred commits can be big: we don't keep their text once it is read
        const xml = await queryClient.fetchQuery({ ...fileQuery(`${dir}/${path}`, { responseType: 'text' }), gcTime: 0 }).catch(() => null);
        const { tests, error } = parseJunit(xml);
        // only what the history needs
        if (!error) reports.push({ name: [run.name, path].filter(Boolean).join('/'), tests: tests.map(({ id, name, path, status, time }) => ({ id, name, path, status, time })) });
      }
    }
    return reports.length > 0 ? reports : null;
  }, [queryClient]);
}

const select = point => history.push(point.href);
const Loading = () => <div className={Classes.SKELETON} style={{ height: 120 }}/>;

// History's sections. `children(sections)` wraps them (the page's title and card) when there is something to show.
export function HistoryTrends({ project, commits, batch_label, available_metrics, filter, children }) {
  const points = useMemo(() => pointsOf(commits, { project, batch_label, with_runs: true, filter }), [commits, project, batch_label, filter]);
  const trends = useMemo(() => trendsOf(points, available_metrics), [points, available_metrics]);
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
// - complete: the list has every commit of the dates, so its runs are those the request would bring
export function BranchTiles({ project, branch, commits, date_range, available_metrics, complete = true }) {
  const wants_runs = useMemo(() => hasGroups(available_metrics), [available_metrics]);
  const runs_count = commits.reduce((sum, commit) => sum + (commit.batches?.default?.valid_outputs ?? 0), 0);
  const { data: with_runs } = useQuery({
    ...commitsQuery({ project, branch, from: date_range[0].toISOString(), to: date_range[1].toISOString(), metrics: {}, with_outputs: true, only_ci_batches: true }),
    enabled: wants_runs && complete && commits.length > 1 && runs_count <= MAX_RUNS,
  });
  const points = useMemo(() => pointsOf(with_runs ?? commits, { project, with_runs: !!with_runs }), [with_runs, commits, project]);
  const trends = useMemo(() => trendsOf(points, available_metrics), [points, available_metrics]);
  if (points.length < 2 || !hasTrends(trends)) return null;
  const open = anchor => history.push(`/${path_segment(project)}/history/${path_segment(branch)}#${anchor}`);
  return <SectionErrorBoundary>
    <Suspense fallback={null}>
      <TrendsTiles points={points} trends={trends} onOpen={open}/>
    </Suspense>
  </SectionErrorBoundary>;
}
