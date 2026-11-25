// Trends over a branch's commits, for the app: what src/trends/ draws (standalone, loaded on demand) from the commits
// the pages already list. Shown without configuration when the runs' metrics say how they group and add up
// (`group`, `part_of`... in their definitions), which `qa upload` does for test reports and benchmark files.
// - <HistoryTrends>: the Trends page's sections, from the commits with their runs,
// - <BranchTiles>: the headline numbers above a branch's commits.
import { lazy, Suspense, useCallback, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Classes, Collapse, H6, Icon } from '@blueprintjs/core';
import { DateTime } from 'luxon';

import { commitsQuery, fileQuery, manifestQuery } from './api/queries';
import { commit_page } from './components/CommitRow';
import { make_output_filter } from './utils';
import { hasGroups, describesTrends } from './metricGroups';
import { history, Link } from './router';
import { usePrefsStore } from './stores/prefs';
import { path_segment } from './selection';
import { is_junit } from './viewers/fileTypes';
import { parseJunit, mergeJunitReports } from './viewers/junit/parse';
import { trendsOf, hasTrends } from './trends/model';
import { SectionErrorBoundary } from './components/ErrorFallback';

const TrendsReport = lazy(() => import('./trends/Trends').then(m => ({ default: m.TrendsReport })));
const TrendsTiles = lazy(() => import('./trends/Trends').then(m => ({ default: m.TrendsTiles })));

// The commits that have the batch as points, oldest first.
// - with_runs: the commits came with their outputs (the Trends page): points have their runs, those that match `filter`,
//   like the Trends page's chart (make_output_filter), and count like the server's aggregates (not pending, failed or deleted). Otherwise points have what the server
//   aggregated: lists of commits always have `outputs`, empty (api/normalize.js), so we can't tell by looking.
// A run's configuration, as its name: "strict", "release {"opt":2}". Runs of the same input in several configurations
// test the same things several ways: the trends say so (model.js configurationsOf), and keep their tests apart.
export const configurationOf = output => {
  const parts = (output?.configurations ?? []).map(c => typeof c === 'string' ? c : JSON.stringify(c));
  if (output?.extra_parameters && Object.keys(output.extra_parameters).length > 0) parts.push(JSON.stringify(output.extra_parameters));
  return parts.join(' ');
};

export function pointsOf(commits, { project, batch_label = 'default', with_runs = false, filter }) {
  const matches = make_output_filter(filter ?? '');
  // a batch still running has only some of its reports: its commit would look like tests were removed
  const running = batch => batch.pending_outputs > 0 || Object.values(batch.outputs ?? {}).some(o => o.is_pending);
  return commits
    .filter(commit => !!commit.batches?.[batch_label] && !running(commit.batches[batch_label]))
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
              .map(output => ({ name: output.test_input_path, configuration: configurationOf(output), metrics: output.metrics ?? {}, output })) }
          : { aggregated: batch.aggregated_metrics ?? {} }),
      };
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

// The test reports of a commit, one per run: [{name, tests}], or null without any. A run's JUnit files are one set
// of tests (mergeJunitReports): a test in junit.xml and in the re-run of its failures (rerun.junit.xml) is one test,
// flaky if it passed when run again. Runs stay apart, by input and configuration.
// A commit's runs can be thousands: we read those of the first MAX_RUNS_READ, enough for runs that upload reports.
const MAX_RUNS_READ = 20;
// a run's report, from the tests of its JUnit files: named after its input and configuration, "codec (strict)"
export function reportOfRun(run, run_reports) {
  if (run_reports.length === 0) return null;
  const name = [run.name, run.configuration && `(${run.configuration})`].filter(Boolean).join(' ');
  return { name, tests: mergeJunitReports(run_reports) };
}
function useLoadTests() {
  const queryClient = useQueryClient();
  return useCallback(async point => {
    const reports = [];
    for (const run of (point.runs ?? []).slice(0, MAX_RUNS_READ)) {
      const dir = run.output?.output_dir_url;
      if (!dir) continue;
      const manifest = await queryClient.fetchQuery(manifestQuery(run.output)).catch(() => null);
      if (!manifest || typeof manifest !== 'object') continue;
      const run_reports = [];
      for (const path of Object.keys(manifest).filter(is_junit).sort()) {
        // the reports of a hundred commits can be big: we don't keep their text once it is read
        const xml = await queryClient.fetchQuery({ ...fileQuery(`${dir}/${path}`, { responseType: 'text' }), gcTime: 0 }).catch(() => null);
        const { tests, error } = parseJunit(xml);
        // only what the history needs
        if (!error) run_reports.push(tests.map(({ id, name, path, status, time }) => ({ id, name, path, status, time })));
      }
      const report = reportOfRun(run, run_reports);
      if (report) reports.push(report);
    }
    return reports.length > 0 ? reports : null;
  }, [queryClient]);
}

const select = point => history.push(point.href);
const Loading = () => <div className={Classes.SKELETON} style={{ height: 120 }}/>;

// the Trends page's sections. `children(sections)` wraps them (the page's title and card) when there is something to show.
export function HistoryTrends({ project, commits, batch_label, available_metrics, filter, children }) {
  // most projects' metrics say nothing of groups: nothing to look at in their runs
  const describes = describesTrends(available_metrics);
  const points = useMemo(() => describes ? pointsOf(commits, { project, batch_label, with_runs: true, filter }) : [], [describes, commits, project, batch_label, filter]);
  const trends = useMemo(() => trendsOf(points, available_metrics), [points, available_metrics]);
  const loadTests = useLoadTests();
  const shown = hasTrends(trends);
  // links from the tiles: /trends/main#trends-total-tests
  useEffect(() => {
    const anchor = window.location.hash.slice(1);
    if (!shown || !anchor.startsWith('trends-')) return undefined;
    const timer = setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ block: 'start' }), 300);
    return () => clearTimeout(timer);
  }, [shown]);
  if (!shown) return null;
  return children(<SectionErrorBoundary>
    <Suspense fallback={<Loading/>}>
      {/* another batch or filter: other runs, whose test reports are read again when asked */}
      <TrendsReport key={`${batch_label}|${filter ?? ''}`} points={points} trends={trends} loadTests={loadTests} onSelect={select}/>
    </Suspense>
  </SectionErrorBoundary>);
}

// Above a branch's commits. The list has what the server aggregated: enough for totals and their parts (tests).
// Groups of metrics (benchmarks) need the runs, and so does telling the same tests run in several configurations
// from more tests: we ask for them when the commits have few runs, as with uploads.
const MAX_RUNS = 2000;
// - complete: the list has every commit of the dates, so its runs are those the request would bring
// - fallback: what to show when the runs' metrics say nothing of how they group
export function BranchTiles({ project, branch, commits, date_range, available_metrics, complete = true, fallback = null }) {
  const runs_count = commits.reduce((sum, commit) => sum + (commit.batches?.default?.valid_outputs ?? 0), 0);
  const several_runs = commits.some(commit => (commit.batches?.default?.valid_outputs ?? 0) > 1);
  const wants_runs = useMemo(() => hasGroups(available_metrics) || (several_runs && describesTrends(available_metrics)), [available_metrics, several_runs]);
  const { data: with_runs, isLoading } = useQuery({
    ...commitsQuery({ project, branch, from: date_range[0].toISOString(), to: date_range[1].toISOString(), metrics: {}, with_outputs: true, only_ci_batches: true }),
    enabled: wants_runs && complete && commits.length > 1 && runs_count <= MAX_RUNS,
  });
  const points = useMemo(() => pointsOf(with_runs ?? commits, { project, with_runs: !!with_runs }), [with_runs, commits, project]);
  const trends = useMemo(() => trendsOf(points, available_metrics), [points, available_metrics]);
  if (points.length < 2 || !hasTrends(trends)) return isLoading ? <Loading/> : fallback;
  const open = anchor => history.push(trends_location(project, branch, date_range, anchor));
  return <SectionErrorBoundary>
    <Suspense fallback={null}>
      <TrendsTiles points={points} trends={trends} onOpen={open}/>
    </Suspense>
  </SectionErrorBoundary>;
}

// The branch's Trends page, on the same dates as the list: its numbers are those of the same commits
const trends_location = (project, branch, date_range, anchor) => {
  const day = date => DateTime.fromJSDate(date).toISODate();
  const search = new URLSearchParams({ from: day(date_range[0]), to: day(date_range[1]) });
  return `/${path_segment(project)}/trends/${path_segment(branch)}?${search}${anchor ? `#${anchor}` : ''}`;
};

// Above a branch's commits: its trends, closed until people open them, then as they left them (a preference).
// Open, the headline numbers when the runs' metrics say how they group (tests, benchmarks), else `chart`.
export function BranchTrends({ project, branch, commits, date_range, complete, available_metrics, chart }) {
  const open = usePrefsStore(state => state.branchTrendsOpen);
  const setOpen = usePrefsStore(state => state.setBranchTrendsOpen);
  const toggle = () => setOpen(!open);
  // what opening shows: say tests and benchmarks only when there are some
  const what = describesTrends(available_metrics) ? 'Tests, benchmarks and metrics over these commits' : 'Metrics over these commits';
  return <Card elevation={0} className="qa-branch-trends" style={{ marginBottom: 15, padding: 0 }}>
    {/* the whole header opens and closes the card; its button says so to keyboards and screen readers */}
    {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the button inside is the keyboard's way */}
    <div onClick={toggle} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px 6px 15px', cursor: 'pointer', flexWrap: 'wrap' }}>
      <Icon icon="timeline-line-chart" className={Classes.TEXT_MUTED}/>
      <H6 style={{ margin: 0 }}>Trends</H6>
      {!open && <span className={Classes.TEXT_MUTED}>{what}</span>}
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
        {/* a link: it goes to the Trends page, and doesn't open or close the card */}
        <Link to={trends_location(project, branch, date_range)} onClick={event => event.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
          Trends page <Icon icon="arrow-right" size={12}/>
        </Link>
        <Button
          variant="minimal"
          icon={open ? 'chevron-up' : 'chevron-down'}
          aria-expanded={open}
          aria-controls="branch-trends"
          aria-label={open ? 'Hide the trends' : 'Show the trends'}
          onClick={event => { event.stopPropagation(); toggle(); }}
        />
      </span>
    </div>
    <Collapse isOpen={open}>
      <div id="branch-trends" style={{ padding: '12px 15px 0', overflowX: 'auto', borderTop: '1px solid var(--qa-border)' }}>
        {open && <BranchTiles project={project} branch={branch} commits={commits} date_range={date_range} complete={complete} available_metrics={available_metrics} fallback={chart}/>}
      </div>
    </Collapse>
  </Card>;
}
