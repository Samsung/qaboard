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
