// The image viewer in QA-Board: compares an image of a run with the same image of its reference run, or with another
// image of the run (e.g. its ground truth).
// It maps runs, their files and the site's image servers to the viewer's props (src/image-viewer/README.md).
import { useEffect, useRef, useState } from 'react';
import { Tag } from '@blueprintjs/core';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router';
import { create } from 'zustand';

import { ImageViewer } from '../../image-viewer';
import { ANALYSES } from '../../image-viewer/analysis';
import { MODES } from '../../image-viewer/modes';
import { run_view } from '../runView';
import { errorMessage, http, isAbort } from '../../api/http';
import { track } from '../../analytics';
import { updateSelected, useComparison, useLabels, useSelected, useSiteConfig, useUser } from '../../hooks';
import { set_anchor, show_reference } from '../../selection';
import { usePrefsStore } from '../../stores/prefs';
import { at_most, is_same_data, same_pixels_only } from '../../utils';
import { doneAgainInPlace, STALE_WARNING } from '../../utils/attempts';
import { build_image_name, iiif_url } from './utils';
import { COMPARE_SCOPES, comparedFor, compareCandidates, pickCompared } from './compareWith';
import { annotationProvider, isGroupShown, regionProviders } from './regionProviders';
import { AnnotationGroups } from './AnnotationGroups';
import { regionsQuery, sizeKey } from './regionSearch';
import { useRegionSetStore } from './regionSetStore';
import { DiffSizeFilter, describeDiffSize, useDiffSize } from './DiffSize';
import { differenceProviders, RegionsTriage, usePagePairs } from './RegionsTriage';
import './image-viewer-theme.css';


// An image of a run, served by the site's IIIF image server
// Without an image server (or one that can't read the file), what browsers decode is shown as it is
const BROWSER_IMAGES = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
const runImage = (output, path, manifest, image_servers, label, color) => {
  const name = build_image_name(path, manifest);
  const file = `${output.output_dir_url}/${name}`;
  const href = `${output.output_dir_url}/${name.split('/').map(encodeURIComponent).join('/')}`;
  return {
    iiif: iiif_url(output.output_dir_url, path, manifest, true, image_servers),
    url: BROWSER_IMAGES.test(name) ? href : undefined,
    label,
    color: color?.hex,
    textColor: color?.text,
    href,
    // for the server's pixel values
    file,
  };
};

// What the image is compared with: the same image in the reference run...
const referenceImage = ({ output_ref, path_ref, manifests, image_servers, label = 'reference', color }) => {
  const available = !!output_ref && !output_ref.deleted && !!output_ref.output_dir_url && manifests?.reference?.[path_ref] !== undefined;
  return available ? { ...runImage(output_ref, path_ref, manifests.reference, image_servers, label, color), detail: 'The same file in the reference run' } : null;
};

// ...and the same image in the other references shown together (`others`, from the run's card): they keep their tile
// while their runs load, or when they don't have the file, so that the tiles don't move when the data comes.
// `shown`: the sides before it, with their file's metadata: an identical file says so in its name, e.g. "release = ref"
export const otherReferenceImage = ({ other, path, image_servers, shown }) => {
  const { label, color, output, manifest } = other;
  const placeholder = fields => ({ label, color: color?.hex, textColor: color?.text, ...fields });
  if (other.error) return { image: placeholder({ missing: `Can't load ${label}: ${other.error}` }) };
  if (other.loading) return { image: placeholder({ loading: true }) };
  if (!output) return { image: placeholder({ missing: `No run of ${label} matches this one` }) };
  if (output.deleted || !output.output_dir_url) return { image: placeholder({ missing: `The run of ${label} was deleted` }) };
  if (manifest === undefined) return { image: placeholder({ loading: true }) };
  const path_other = reference_path(path, manifest);
  if (path_other === null) return { image: placeholder({ missing: `No ${path.split('/').pop()} in ${label}` }) };
  const meta = manifest[path_other];
  const same = shown.find(side => is_same_data(path, side.meta, meta));
  return {
    image: runImage(output, path_other, manifest, image_servers, same ? `${label} = ${same.label}` : label, color),
    meta,
  };
};

// The file of a reference to compare with: the same path, or for PNGs their TIFF or BMP version, so that projects that
// changed formats still compare with older references (like the run's card does for the reference)
const reference_path = (path, manifest) => {
  if (manifest?.[path] !== undefined) return path;
  if (!path.endsWith('.png')) return null;
  return [path.replace(/\.png$/i, '.tiff'), path.replace(/\.png$/, '.bmp')].find(candidate => manifest?.[candidate] !== undefined) ?? null;
};

// ...or another image of the run, e.g. its ground truth, picked in the viewer's "vs" menu.
const otherImages = ({ output_new, path, manifests, image_servers }) => {
  if (output_new.deleted || !output_new.output_dir_url) return [];
  return compareCandidates(path, manifests?.new, image_servers).map(({ path: other, suggested, reason }) => ({
    id: other,
    image: runImage(output_new, other, manifests.new, image_servers, other),
    group: suggested ? 'Suggested' : 'This run',
    detail: reason,
  }));
};

// The image picked to compare with is the same for the viewers of a visualization: each run's viewer compares with its
// own file of that name, e.g. every run with its ground truth. Or users pick for one run, to spot-check it. Like the
// adjustments, it's not saved, and it's for the page: another commit or batch compares with the reference again.
const useComparedStore = create(set => ({
  // { [path]: { page, all, runs } } (compareWith.js)
  by_path: {},
  scope: 'all',
  setScope: scope => set({ scope }),
  set: (path, output_id, other, page) => set(state => ({
    by_path: { ...state.by_path, [path]: pickCompared(state.by_path[path], output_id, other, state.scope, page) },
  })),
}));

// The image's own values (e.g. 16-bit, raw...), read by the server, as binary: the viewer asks for tiles of 64x64
const TYPED_ARRAYS = {
  uint8: Uint8Array, int8: Int8Array, uint16: Uint16Array, int16: Int16Array,
  uint32: Uint32Array, int32: Int32Array, float32: Float32Array, float64: Float64Array,
};
const getPixels = async (image, { x, y, w, h }, { signal }) => {
  const { data, headers } = await http.get('/api/v1/output/image/pixels', {
    params: { image_url: image.file, x, y, w, h, format: 'binary' },
    responseType: 'arraybuffer',
    signal,
  });
  const [height, width, channels = 1] = headers.get('X-Pixels-Shape').split(',').map(Number);
  const TypedArray = TYPED_ARRAYS[headers.get('X-Pixels-Dtype')] ?? Float64Array;
  return { data: new TypedArray(data), width, height, channels, mode: headers.get('X-Pixels-Mode') ?? undefined, sensor: sensorOf(headers.get('X-Pixels-Sensor')) };
};

// What the image's reader on the server says about its sensor (backend/backend/sensor.py), for the viewer's analysis
export const sensorOf = header => {
  if (!header) return undefined;
  let info;
  try {
    info = JSON.parse(header);
  } catch {
    return undefined;
  }
  const crop = info.crop && { x: info.crop.x, y: info.crop.y, fullWidth: info.crop.full_width, fullHeight: info.crop.full_height };
  return {
    cfa: info.cfa ?? undefined,
    bitDepth: info.bit_depth ?? undefined,
    blackLevel: info.black_level ?? undefined,
    whiteLevel: info.white_level ?? undefined,
    mono: info.mono ?? undefined,
    crop: crop ?? undefined,
    source: "the file's metadata, from the server's image reader",
    fields: info.fields,
  };
};

// Display adjustments are shared by the viewers of the same visualization, so that the runs stay comparable.
// They're not saved: they're only a way to look.
const useAdjustmentsStore = create(set => ({
  by_path: {},
  set: (path, adjustments) => set(state => ({ by_path: { ...state.by_path, [path]: adjustments } })),
}));

// Which image shows first, and the blind test, are the same for every viewer of the page: swapping or flipping one
// swaps them all, so that it's clear what we're looking at. During a blind test, each viewer shows its images in a
// random order (from the test's seed and the viewer), called A and B, until users reveal them.
const usePageComparisonStore = create(set => ({
  swapped: false,
  // with several references shown together: the one shown alone in single mode, 'new' or the reference's id: the same
  // in every viewer of the page, wherever its tab is
  shown: null,
  setShown: shown => set({ shown }),
  // { seed, swapped: when it started, revealed }
  blind: null,
  swap: () => set(state => ({ swapped: !state.swapped })),
  blindTest: action => set(state => {
    if (action === 'start') return { blind: { seed: Math.floor(Math.random() * 2 ** 31), swapped: state.swapped, revealed: false } };
    if (action === 'reveal') return state.blind ? { blind: { ...state.blind, revealed: true } } : {};
    // the end: new first again
    return { blind: null, swapped: false };
  }),
}));

// Heads or tails, the same for a seed and a key (FNV-1a, then mixed)
export const coin = (seed, key) => {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return (h & 1) === 1;
};

// The page, for the region sets: the commits, batches... it compares
const usePageKey = () => {
  const comparison = useComparison();
  return [useLocation().pathname, comparison?.new_batch?.id, comparison?.ref_batch?.id].join(' ');
};
// ...for the other images of the runs: their commit and batch. Switching references keeps them.
const useNewPageKey = () => {
  const comparison = useComparison();
  return [useLocation().pathname, comparison?.new_batch?.id].join(' ');
};

// The server reads the images' values and compares them for signed-in users only
const SIGN_IN_VALUES = "Sign in (in the sidebar) to read the images' own values: raw, 16-bit…";
const SIGN_IN_SEARCH = 'Sign in (in the sidebar) to find where the images differ';

// The regions of interest of the providers. Those found on demand are shared by the page (regionSearch.js): a search
// for all the runs fills each viewer.
const useRegionSets = (context, signed_in, onDiffSizeChange) => {
  const queryClient = useQueryClient();
  // the site's annotations, e.g. from the app where people mark defects
  const { annotation_sources } = useSiteConfig();
  // the groups of annotations users see, e.g. workspaces
  const group_choices = usePrefsStore(state => state.annotationGroups);
  const providers = [...regionProviders(), ...(annotation_sources ?? []).map(annotationProvider)]
    .filter(provider => !provider.available || provider.available(context));
  const finders = providers.filter(provider => !provider.regions && provider.find);
  // what's found, without searching: only when users pick the set. Annotations are fetched right away (auto).
  const found = useQueries({ queries: finders.map(provider => ({ ...regionsQuery(provider, context), enabled: !!provider.auto })) });
  const sets = [];
  for (const provider of providers) {
    const base = { id: provider.id, label: typeof provider.label === 'function' ? provider.label(context) : provider.label, description: provider.description, section: provider.section, overview: provider.overview };
    if (provider.auto) {
      const { data, error, fetchStatus } = found[finders.indexOf(provider)];
      const shown = new Set(data?.groups.filter(group => isGroupShown(group, group_choices?.[provider.source])).map(group => group.id));
      const failed = error && !isAbort(error) ? errorMessage(error) : undefined;
      sets.push({
        ...base,
        announce: true,
        noun: provider.noun,
        // all of them, the regions button says how many there are
        total: data?.regions.length,
        regions: data?.regions.filter(region => shown.has(region.group)),
        loading: fetchStatus === 'fetching' && !data,
        error: failed,
        empty: !data?.regions.length ? provider.empty
          : shown.size === 0 ? `Pick the ${provider.group_noun}s to show`
          : `No annotations in these ${provider.group_noun}s`,
        settings: data?.groups.length ? <AnnotationGroups source={provider.source} groups={data.groups} noun={provider.group_noun} label={provider.label} /> : undefined,
        // only to retry: else it's not a search, and stays picked on other pages
        load: failed ? () => queryClient.fetchQuery(regionsQuery(provider, context, 'high')).catch(() => {}) : undefined,
      });
      continue;
    }
    if (provider.regions) {
      const regions = provider.regions(context);
      if (regions?.length) sets.push({ ...base, regions });
      continue;
    }
    const i = finders.indexOf(provider);
    if (i === -1) continue;
    const { data, error, fetchStatus } = found[i];
    const sized = provider.sized && onDiffSizeChange;
    sets.push({
      ...base,
      empty: sized && context.diff_size ? `No difference of that size (${describeDiffSize(context.diff_size)})` : provider.empty,
      settings: sized ? <DiffSizeFilter size={context.diff_size} onChange={onDiffSizeChange} /> : undefined,
      regions: data,
      loading: fetchStatus === 'fetching',
      error: !signed_in ? SIGN_IN_SEARCH : error && !isAbort(error) ? errorMessage(error) : undefined,
      load: signed_in ? () => queryClient.fetchQuery(regionsQuery(provider, context, 'high')).catch(() => {}) : undefined,
    });
  }
  return sets;
};

const no_others = [];

const ImageViewerForRuns = ({
  output_new,
  output_ref,
  // the other references shown together with the reference: [{ key, label, color, output, manifest, loading }]
  others = no_others,
  path,
  path_ref = path,
  manifests,
  label,
  // what to call the new and reference images, e.g. their milestones' names (useLabels)
  labels: labels_,
  style,
  fullscreen,
  // the visual controls, see ../controls.js
  image_mode,
  image_diff,
  diff,
  // false: users turned off what runs ask to show
  run_views,
  onControlsChange,
  // the regions the run logged with the image, e.g. a detector's boxes (../media/): shown outlined. boxes_ref: the
  // reference's, with its image
  boxes,
  boxes_ref,
}) => {
  const labels = useLabels(labels_);
  // What the run asks for its images (its `view.images`): the comparison mode, the analysis panel
  const asked = run_views !== false ? run_view(output_new).images : null;
  const asked_mode = MODES.some(m => m.value === asked?.mode) ? asked.mode : undefined;
  const asked_analysis = ANALYSES.some(a => a.value === asked?.analysis) ? asked.analysis : undefined;
  // the panel's view is a preference shared by the viewers: this viewer keeps its own when the run asked for one
  const [own_analysis, setOwnAnalysis] = useState(asked_analysis);
  const { image_servers } = useSiteConfig();
  const pixel_values = usePrefsStore(state => state.imagePixelValues);
  const setPixelValues = usePrefsStore(state => state.setImagePixelValues);
  const analysis = usePrefsStore(state => state.imageAnalysis);
  const setAnalysis = usePrefsStore(state => state.setImageAnalysis);
  const analysis_values = usePrefsStore(state => state.imageAnalysisValues);
  const setAnalysisValues = usePrefsStore(state => state.setImageAnalysisValues);
  // what users said of the sensor of the project's raw images
  const { project } = useSelected();
  // Usage analytics: each feature once per viewer, so that holding a key doesn't send hundreds of events
  const used_features = useRef(new Set());
  const use = feature => {
    if (used_features.current.has(feature)) return;
    used_features.current.add(feature);
    track('image_viewer_use', { feature }, { project_id: project });
  };
  const sensor = usePrefsStore(state => state.imageSensor[project]);
  const setSensor = usePrefsStore(state => state.setImageSensor);
  const adjustments = useAdjustmentsStore(state => state.by_path[path]);
  const setAdjustments = useAdjustmentsStore(state => state.set);

  // Without onControlsChange (e.g. in History's previews), each viewer has its own mode
  const [local_mode, setLocalMode] = useState(undefined);
  const [local_diff, setLocalDiff] = useState(undefined);
  // `diff` is how the URL said "difference mode" before there were modes
  const mode = (onControlsChange ? image_mode : local_mode) ?? (diff ? 'difference' : asked_mode ?? 'side-by-side');
  const diff_settings = onControlsChange ? image_diff : local_diff;

  const image = runImage(output_new, path, manifests?.new, image_servers, labels.new, labels.colors.new);
  // Identical files: we show one. When a run is compared with itself it's obvious, else we say it.
  const identical = is_same_data(path, manifests?.new?.[path], manifests?.reference?.[path_ref]);
  const same_data = identical && output_ref?.id !== output_new.id;
  const pixels_only = same_data && same_pixels_only(path, manifests?.new?.[path], manifests?.reference?.[path_ref]);
  const together = others.length > 0;
  const reference_image = referenceImage({ output_ref, path_ref, manifests, image_servers, label: labels.reference, color: labels.colors.reference });
  const reference = identical ? null : reference_image;
  const has_reference = together ? !!reference_image : !!reference;
  // With other references shown together: the references in the order of their tabs, each in its tile after the new
  // image. They keep their tile whatever happens (identical, missing, loading), so that the images keep their place.
  // The anchor is the new image, or the reference selected when users pick it: the image viewer compares the others with it.
  const selected = useSelected();
  const comparison = useComparison();
  const primary = comparison?.references?.find(r => r.is_shown);
  const sides = [];
  if (together) {
    const tabs = [
      { number: primary?.number ?? 0, id: primary?.id ?? 'reference', label: labels.reference, primary: true },
      ...others.map(other => ({ number: other.number, id: other.id ?? other.key, label: other.label, other })),
    ].sort((a, b) => a.number - b.number);
    const shown_sides = [{ label: labels.new, meta: manifests?.new?.[path] }];
    for (const tab of tabs) {
      let side_image, meta;
      if (!tab.primary) {
        ({ image: side_image, meta } = otherReferenceImage({ other: tab.other, path, image_servers, shown: shown_sides }));
      } else if (reference_image) {
        meta = manifests?.reference?.[path_ref];
        const same = shown_sides.find(side => is_same_data(path, side.meta, meta));
        side_image = same ? { ...reference_image, label: `${labels.reference} = ${same.label}` } : reference_image;
      } else {
        side_image = {
          label: labels.reference, color: labels.colors.reference?.hex, textColor: labels.colors.reference?.text,
          missing: output_ref ? `No ${path.split('/').pop()} in ${labels.reference}` : `No run of ${labels.reference} matches this one`,
        };
      }
      sides.push({ ...tab, image: side_image });
      if (meta) shown_sides.push({ label: tab.label, meta });
    }
  }
  // the images' places in the viewer: new, then the references
  // the anchor: the new image, unless users picked the reference selected
  const anchor = comparison?.anchor === 'reference' ? 1 + sides.findIndex(side => side.primary) : 0;
  const side_ids = ['new', ...sides.map(side => side.id)];
  // clicking an image's name makes it the anchor, like its tab does: a reference is selected too
  const selectSide = index => {
    if (index === 0) return updateSelected(set_anchor(selected, 'new'));
    const side = sides[index - 1];
    if (side) updateSelected({ ...(side.primary ? {} : show_reference(selected, side.number - 1)), ...set_anchor(selected, 'reference') });
  };
  const show_details = usePrefsStore(state => state.imageDetails);
  const setShowDetails = usePrefsStore(state => state.setImageDetails);
  const contact_sheet = usePrefsStore(state => state.imageContactSheet);
  const page_shown = usePageComparisonStore(state => state.shown);
  const setPageShown = usePageComparisonStore(state => state.setShown);
  const compare_with = otherImages({ output_new, path, manifests, image_servers });
  const compared_entry = useComparedStore(state => state.by_path[path]);
  const compared_page = useNewPageKey();
  const { compared, alone } = comparedFor(compared_entry, output_new.id, compared_page);
  const setCompared = useComparedStore(state => state.set);
  const compare_scope = useComparedStore(state => state.scope);
  const setCompareScope = useComparedStore(state => state.setScope);
  // when the run has it: else the viewer says so, and shows the reference
  const other = compare_with.some(candidate => candidate.id === compared) ? compared : null;
  const same_as_other = !!other && is_same_data(path, manifests?.new?.[path], manifests?.new?.[other]);
  const signed_in = useUser().is_logged;
  // the regions where the images differ: of the image and the other image of the run, or its reference
  const [diff_size, setDiffSize] = useDiffSize();
  const names = { new: labels?.new ?? 'new', reference: labels?.reference ?? 'reference' };
  const region_context = other
    ? { output_new, output_ref: output_new, path, path_ref: other, diff_size, boxes, names }
    : { output_new, output_ref: has_reference ? output_ref : null, path, path_ref, diff_size, boxes, boxes_ref: has_reference ? boxes_ref : undefined, names };
  const region_sets = useRegionSets(region_context, signed_in, setDiffSize);
  const page = usePageKey();
  const chosen = useRegionSetStore(state => state.by_path[path]);
  const setChosen = useRegionSetStore(state => state.set);
  const setRegionSet = id => setChosen(path, id, page);
  const is_search = id => !!region_sets.find(set => set.id === id)?.load;
  const region_set = chosen && (chosen.page === page || !is_search(chosen.id))
    ? chosen.id
    : region_sets.find(set => set.id === 'logged' || set.id === 'presets')?.id ?? null;
  // another size of differences: the set shown searches again
  const size_key = JSON.stringify(sizeKey(diff_size));
  const shown_set = region_sets.find(set => set.id === region_set);
  const searchAgain = shown_set?.settings && !shown_set.regions && !shown_set.loading ? shown_set.load : null;
  useEffect(() => {
    searchAgain?.();
    // oxlint-disable-next-line react/exhaustive-deps -- when the size changes, not when the set is reloaded
  }, [size_key]);
  const page_swapped = usePageComparisonStore(state => state.swapped);
  const page_blind = usePageComparisonStore(state => state.blind);
  const swapPage = usePageComparisonStore(state => state.swap);
  const blindTestPage = usePageComparisonStore(state => state.blindTest);
  // during a blind test, this viewer's images in a random order
  const shuffled = !!page_blind && coin(page_blind.seed, `${output_new.id} ${path}`);
  // what shows first when the test started is A
  const blind_test = page_blind ? { a: page_blind.swapped !== shuffled ? 'B' : 'A', revealed: page_blind.revealed } : null;

  // Where the images differ, for all the runs of the page: from the viewers of the page's runs
  const pairs = usePagePairs();
  const [triage, setTriage] = useState(null);
  const in_page = has_reference && !other && pairs.some(pair => pair.output_new.id === output_new.id);
  const comparing = differenceProviders()[0];
  const region_actions = signed_in && in_page && comparing && pairs.length > 1 ? [{
    id: 'all-runs',
    icon: 'search',
    label: `Where they differ, in all ${pairs.length} runs…`,
    title: 'Compare the images of every run of the page with their reference, and rank the runs by how much they differ',
    onClick: () => {
      // the dialog shows over the page
      if (document.fullscreenElement) document.exitFullscreen?.();
      setTriage(region_set?.startsWith?.('auto-') ? region_set : comparing.id);
    },
  }] : [];
  const showRun = id => {
    setRegionSet(triage);
    setTriage(null);
    document.querySelector(`.output-card[data-output-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const stale_ref = !other && has_reference && doneAgainInPlace(output_ref);
  const maybe_stale = doneAgainInPlace(output_new) ? 'This run' : (stale_ref ? 'The reference run' : null);

  return <ImageViewer
    className="qaboard-image-viewer"
    style={{ width: fullscreen ? '100%' : at_most(style?.width), maxWidth: '100%' }}
    image={image}
    reference={together ? sides[0].image : reference}
    more={sides.slice(1).map(side => side.image)}
    anchor={anchor}
    onAnchorChange={value => { use('anchor'); selectSide(value); }}
    shown={side_ids.includes(page_shown) ? side_ids.indexOf(page_shown) : anchor}
    onShownChange={value => setPageShown(side_ids[value])}
    details={show_details}
    onDetailsChange={setShowDetails}
    compact={contact_sheet && !fullscreen}
    compareWith={compare_with}
    compared={compared}
    onComparedChange={value => { use('compare'); setCompared(path, output_new.id, value, compared_page); }}
    compareScopes={COMPARE_SCOPES}
    compareScope={compare_scope}
    onCompareScopeChange={setCompareScope}
    comparedNote={alone ? 'this run' : undefined}
    mode={mode}
    onModeChange={value => onControlsChange ? onControlsChange({ image_mode: value, diff: undefined }) : setLocalMode(value)}
    diff={diff_settings}
    onDiffChange={value => onControlsChange ? onControlsChange({ image_diff: value }) : setLocalDiff(value)}
    adjustments={adjustments}
    onAdjustmentsChange={value => { use(value?.falseColor !== adjustments?.falseColor ? 'colormap' : 'adjustments'); setAdjustments(path, value); }}
    pixelValues={pixel_values}
    onPixelValuesChange={setPixelValues}
    analysis={own_analysis ?? analysis}
    onAnalysisChange={value => { if (own_analysis) setOwnAnalysis(value); setAnalysis(value); }}
    defaultShowAnalysis={!!asked_analysis}
    analysisValues={analysis_values}
    onAnalysisValuesChange={setAnalysisValues}
    sensor={sensor}
    onSensorChange={value => setSensor(project, value)}
    sensorRemembered="for the project, in this browser"
    // the same input's images are synced, e.g. the other runs', or the other visualizations of a run
    syncKey={output_new.test_input_path ?? null}
    regionSets={region_sets}
    regionSet={region_set}
    onRegionSetChange={value => { if (value) use(String(value).startsWith('annotations-') ? 'annotations' : 'region'); setRegionSet(value); }}
    regionActions={region_actions}
    swapped={page_swapped !== shuffled}
    onSwappedChange={swapPage}
    blindTest={blind_test}
    onBlindTestChange={blindTestPage}
    getPixels={signed_in ? getPixels : undefined}
    imageValuesUnavailable={signed_in ? undefined : SIGN_IN_VALUES}
    onUse={use}
    maxHeight={height => height - (fullscreen ? 120 : 260)}
    notice={<>
      {label && <span className="qaboard-image-viewer-label">{label}</span>}
      {/* no tooltips: they wouldn't show in full screen */}
      {same_data && !other && !together && (pixels_only
        ? <Tag minimal icon="duplicate" title="The new and reference images have the same pixels, but their files differ (e.g. their metadata): qa check-bit-accuracy sees a difference">same pixels as the reference</Tag>
        : <Tag minimal icon="duplicate" title="The new and reference files have the same hash">same as the reference</Tag>)}
      {same_as_other && <Tag minimal icon="duplicate" title={`${path} and ${other} have the same hash`}>same data as {other.split('/').pop()}</Tag>}
      {/* runs done again in place keep their paths: the browser, the viewer and the image server cache images by path */}
      {maybe_stale && <Tag minimal icon="warning-sign" intent="warning" title={`${maybe_stale} ${STALE_WARNING}`}>may be stale</Tag>}
      {triage && <RegionsTriage path={path} path_ref={path_ref} provider={triage} onProviderChange={setTriage} onShow={showRun} onClose={() => setTriage(null)} />}
    </>}
  />;
};

export default ImageViewerForRuns;
