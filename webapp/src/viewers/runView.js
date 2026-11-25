// What a run asks the web app to show: its "view" hint. Tests say what matters for them, so that each card of a
// batch opens on it, instead of the same visualizations for every run.
//
// The hint is a `view` mapping, given where regions of interest (`roi`) always were: in the input's metadata, or in
// a mapping of the run's configurations.
//   view:
//     show: [Histogram]        # the visualizations shown by default, by their name in qaboard.yaml
//     images:                  # options of the viewers, per kind of file: they also apply to files opened from
//       analysis: profiles     # the output files, which have no visualization
//       roi: [{x, y, w, h, label}]
// A top-level `roi` is the same as `view.images.roi`.
// When several hints apply: the input's metadata first, then the configurations in order. The last wins, key by
// key, and lists of regions add up. Docs: /docs/visualizations#per-test-views

import { is_flame_graph, is_junit, is_benchmarks } from "./fileTypes";

const is_object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// `view` is also a plausible name for a project's own parameter (view: left): only mappings are hints
export const is_view_hint = value => is_object(value);

const empty = Object.freeze({ images: Object.freeze({ roi: Object.freeze([]) }) });
const cache = new WeakMap();

// { show?: [names], images: { roi: [...], ...options }, videos?: {...}, ... }
export const run_view = output => {
  if (!output || typeof output !== 'object') return empty;
  const cached = cache.get(output);
  if (cached) return cached;

  const sources = [output.test_input_metadata, ...(Array.isArray(output.configurations) ? output.configurations : [])].filter(is_object);
  const view = { images: { roi: [] } };
  const add_regions = regions => {
    if (Array.isArray(regions)) view.images.roi.push(...regions.filter(is_object));
  };
  for (const source of sources) {
    add_regions(source.roi);
    if (!is_view_hint(source.view)) continue;
    for (const [key, value] of Object.entries(source.view)) {
      if (key === 'show') {
        if (Array.isArray(value)) view.show = value.filter(name => typeof name === 'string');
      } else if (is_object(value)) {
        const { roi, ...options } = value;
        view[key] = { ...view[key], ...options };
        if (key === 'images') add_regions(roi);
      }
    }
  }
  cache.set(output, view);
  return view;
};

// The names of the visualizations the run asks to show by default, among those of qaboard.yaml: a Set, or null when
// it doesn't say (or names none of them: we don't hide everything because of a typo).
export const run_shown = (output, visualizations) => {
  const { show } = run_view(output);
  if (!show) return null;
  const known = new Set(visualizations.map(view => view.name));
  const names = show.filter(name => known.has(name));
  return names.length > 0 ? new Set(names) : null;
};

// Whether the run asks for more than regions: what the "Each test's own view" switch of the view options turns off
export const has_run_view = output => {
  const { show, images, ...others } = run_view(output);
  return !!show || Object.keys(images).length > 1 || Object.keys(others).length > 0;
};

// Is a visualization shown on a run's card? What users chose in the view options wins, then what the run asks for,
// then the project's default. controls.show also holds the project's defaults (see controls_defaults): users chose
// when it differs from them.
export const is_visualization_shown = (view, controls, shown_by_run) => {
  const by_default = !view.default_hidden;
  const choice = controls?.show?.[view.name];
  if (choice !== undefined && choice !== by_default) return choice;
  if (shown_by_run && controls?.run_views !== false) return shown_by_run.has(view.name);
  return by_default;
};

// What runs created from code (`qaboard.start_run()`, `qa upload`) show without anything in qaboard.yaml, before the
// project's visualizations: there is often no project configuration to speak of when a CI job uploads a test report.
// - the series they logged (run.log() in Python, qaboard/series.py): the file made for plots, else the full history
// - the media they logged at their steps (images, audio, tables, histograms...: qaboard/media.py), with a step slider
// - what they used of their machine: memory, CPU, GPUs (qaboard/system_metrics.py). `qa run` writes it too: projects
//   list it in their visualizations to see it, e.g. hidden by default
// - the files viewers recognize by their name: test reports, benchmark files, profiles
// Projects that list such files themselves, by path or by type, choose where they go and whether they start hidden.
const SERIES_FILES = ['series.json', 'series.jsonl'];
export const SERIES_VIEW_NAME = 'Logged series';
const MEDIA_FILE = 'media.jsonl';
export const MEDIA_VIEW_NAME = 'Logged media';
export const SYSTEM_METRICS_FILE = 'system.series.json';
export const SYSTEM_METRICS_VIEW_NAME = 'System metrics';
const RECOGNIZED_FILES = [
  { name: 'Tests', is: is_junit, types: ['junit'] },
  { name: 'Benchmarks', is: is_benchmarks, types: ['benchmarks'] },
  { name: 'Flame graph', is: is_flame_graph, types: ['flame'] },
];
// a run with a report per test class has hundreds: the rest is in the output files
const MAX_RECOGNIZED_FILES = 4;
export const with_run_files = (views, manifest, output) => {
  // other projects' runs can have a series.json of their own, that isn't ours
  if (!manifest || !started_from_code(output))
    return views;
  const added = [];
  const series = SERIES_FILES.find(file => manifest[file]);
  // the projects' own series: what they plot of system.series.json (below) isn't the series the run logged
  if (series && !views.some(view => (view.type === 'series' && view.path !== SYSTEM_METRICS_FILE) || SERIES_FILES.includes(view.path)))
    added.push({ name: SERIES_VIEW_NAME, path: series, type: 'series', automatic: true });
  if (manifest[MEDIA_FILE] && !views.some(view => view.type === 'media' || view.path === MEDIA_FILE))
    added.push({ name: MEDIA_VIEW_NAME, path: MEDIA_FILE, type: 'media', automatic: true });
  if (manifest[SYSTEM_METRICS_FILE] && !views.some(view => view.path === SYSTEM_METRICS_FILE))
    added.push({ name: SYSTEM_METRICS_VIEW_NAME, path: SYSTEM_METRICS_FILE, type: 'series', automatic: true });
  const paths = Object.keys(manifest).sort();
  for (const { name, is, types } of RECOGNIZED_FILES) {
    if (views.some(view => is(view.path) || types.some(type => view.type === type || view.type?.startsWith(`${type}/`))))
      continue;
    const files = paths.filter(is).slice(0, MAX_RECOGNIZED_FILES);
    files.forEach(path => added.push({ name: files.length > 1 ? `${name}: ${path}` : name, path, automatic: true }));
  }
  return added.length > 0 ? [...added, ...views] : views;
};

// Runs created from code with qaboard.start_run() (qaboard/active_run.py), not by `qa run`: the SDK says so
export const started_from_code = output => !!output?.data?.sdk;
