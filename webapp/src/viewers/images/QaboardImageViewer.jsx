// The image viewer in QA-Board: compares an image of a run with the same image of its reference run.
// It maps runs, their files and the site's image servers to the viewer's props (src/image-viewer/README.md).
import { useState } from 'react';
import { Tag } from '@blueprintjs/core';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router';
import { create } from 'zustand';

import { ImageViewer } from '../../image-viewer';
import { errorMessage, http, isAbort } from '../../api/http';
import { useComparison, useSiteConfig, useUser } from '../../hooks';
import { usePrefsStore } from '../../stores/prefs';
import { at_most, is_same_data } from '../../utils';
import { build_image_name, iiif_url } from './utils';
import { regionProviders } from './regionProviders';
import { regionsQuery } from './regionSearch';
import { differenceProviders, RegionsTriage, usePagePairs } from './RegionsTriage';
import './image-viewer-theme.css';


// An image of a run, served by the site's IIIF image server
const runImage = (output, path, manifest, image_servers, label) => {
  const name = build_image_name(path, manifest);
  const file = `${output.output_dir_url}/${name}`;
  return {
    iiif: iiif_url(output.output_dir_url, path, manifest, true, image_servers),
    label,
    href: `${output.output_dir_url}/${name.split('/').map(encodeURIComponent).join('/')}`,
    // for the server's pixel values
    file,
  };
};

// What the image is compared with: the same image in the reference run.
// To compare with another file of the same run instead (e.g. the input, or a previous stage), this is where to
// return { ...runImage(output_new, other_path, manifests.new, image_servers, other_path) }: the viewer compares
// any two images, and the labels say which.
const referenceImage = ({ output_ref, path_ref, manifests, image_servers }) => {
  const available = !!output_ref && !output_ref.deleted && !!output_ref.output_dir_url && manifests?.reference?.[path_ref] !== undefined;
  return available ? runImage(output_ref, path_ref, manifests.reference, image_servers, 'reference') : null;
};

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
  return { data: new TypedArray(data), width, height, channels, mode: headers.get('X-Pixels-Mode') ?? undefined };
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

// The region set shown is the same for the viewers of a visualization, e.g. where the images differ. Searches (sets
// found on demand) are opt-in on each page: on the next, they'd compare the images of all its runs again.
const useRegionSetStore = create(set => ({
  // { [path]: { id, page } }
  by_path: {},
  set: (path, id, page) => set(state => ({ by_path: { ...state.by_path, [path]: { id, page } } })),
}));

// The page, for the region sets: the commits, batches... it compares
const usePageKey = () => {
  const comparison = useComparison();
  return [useLocation().pathname, comparison?.new_batch?.id, comparison?.ref_batch?.id].join(' ');
};

// The server reads the images' values and compares them for signed-in users only
const SIGN_IN_VALUES = "Sign in (in the sidebar) to read the images' own values: raw, 16-bit…";
const SIGN_IN_SEARCH = 'Sign in (in the sidebar) to find where the images differ';

// The regions of interest of the providers. Those found on demand are shared by the page (regionSearch.js): a search
// for all the runs fills each viewer.
const useRegionSets = (context, signed_in) => {
  const queryClient = useQueryClient();
  const providers = regionProviders().filter(provider => !provider.available || provider.available(context));
  const finders = providers.filter(provider => !provider.regions && provider.find);
  // what's found, without searching: only when users pick the set
  const found = useQueries({ queries: finders.map(provider => ({ ...regionsQuery(provider, context), enabled: false })) });
  const sets = [];
  for (const provider of providers) {
    const base = { id: provider.id, label: provider.label, description: provider.description };
    if (provider.regions) {
      const regions = provider.regions(context);
      if (regions?.length) sets.push({ ...base, regions });
      continue;
    }
    const i = finders.indexOf(provider);
    if (i === -1) continue;
    const { data, error, fetchStatus } = found[i];
    sets.push({
      ...base,
      empty: provider.empty,
      regions: data,
      loading: fetchStatus === 'fetching',
      error: !signed_in ? SIGN_IN_SEARCH : error && !isAbort(error) ? errorMessage(error) : undefined,
      load: signed_in ? () => queryClient.fetchQuery(regionsQuery(provider, context, 'high')).catch(() => {}) : undefined,
    });
  }
  return sets;
};

const ImageViewerForRuns = ({
  output_new,
  output_ref,
  path,
  path_ref = path,
  manifests,
  label,
  style,
  fullscreen,
  // the visual controls, see ../controls.js
  image_mode,
  image_diff,
  diff,
  onControlsChange,
}) => {
  const { image_servers } = useSiteConfig();
  const pixel_values = usePrefsStore(state => state.imagePixelValues);
  const setPixelValues = usePrefsStore(state => state.setImagePixelValues);
  const adjustments = useAdjustmentsStore(state => state.by_path[path]);
  const setAdjustments = useAdjustmentsStore(state => state.set);

  // Without onControlsChange (e.g. in History's previews), each viewer has its own mode
  const [local_mode, setLocalMode] = useState(undefined);
  const [local_diff, setLocalDiff] = useState(undefined);
  // `diff` is how the URL said "difference mode" before there were modes
  const mode = (onControlsChange ? image_mode : local_mode) ?? (diff ? 'difference' : 'side-by-side');
  const diff_settings = onControlsChange ? image_diff : local_diff;

  const image = runImage(output_new, path, manifests?.new, image_servers, 'new');
  // Identical files: we show one. When a run is compared with itself it's obvious, else we say it.
  const identical = is_same_data(path, manifests?.new?.[path], manifests?.reference?.[path_ref]);
  const same_data = identical && output_ref?.id !== output_new.id;
  const reference = identical ? null : referenceImage({ output_ref, path_ref, manifests, image_servers });
  const signed_in = useUser().is_logged;
  const region_sets = useRegionSets({ output_new, output_ref: reference ? output_ref : null, path, path_ref }, signed_in);
  const page = usePageKey();
  const chosen = useRegionSetStore(state => state.by_path[path]);
  const setChosen = useRegionSetStore(state => state.set);
  const setRegionSet = id => setChosen(path, id, page);
  const is_search = id => !!region_sets.find(set => set.id === id)?.load;
  const region_set = chosen && (chosen.page === page || !is_search(chosen.id))
    ? chosen.id
    : region_sets.some(set => set.id === 'presets') ? 'presets' : null;
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
  const in_page = !!reference && pairs.some(pair => pair.output_new.id === output_new.id);
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

  return <ImageViewer
    className="qaboard-image-viewer"
    style={{ width: fullscreen ? '100%' : at_most(style?.width), maxWidth: '100%' }}
    image={image}
    reference={reference}
    mode={mode}
    onModeChange={value => onControlsChange ? onControlsChange({ image_mode: value, diff: undefined }) : setLocalMode(value)}
    diff={diff_settings}
    onDiffChange={value => onControlsChange ? onControlsChange({ image_diff: value }) : setLocalDiff(value)}
    adjustments={adjustments}
    onAdjustmentsChange={value => setAdjustments(path, value)}
    pixelValues={pixel_values}
    onPixelValuesChange={setPixelValues}
    // the same input's images are synced, e.g. the other runs', or the other visualizations of a run
    syncKey={output_new.test_input_path ?? null}
    regionSets={region_sets}
    regionSet={region_set}
    onRegionSetChange={setRegionSet}
    regionActions={region_actions}
    swapped={page_swapped !== shuffled}
    onSwappedChange={swapPage}
    blindTest={blind_test}
    onBlindTestChange={blindTestPage}
    getPixels={signed_in ? getPixels : undefined}
    imageValuesUnavailable={signed_in ? undefined : SIGN_IN_VALUES}
    maxHeight={height => height - (fullscreen ? 120 : 260)}
    notice={<>
      {label && <span className="qaboard-image-viewer-label">{label}</span>}
      {/* no tooltips: they wouldn't show in full screen */}
      {same_data && <Tag minimal icon="duplicate" title="The new and reference files have the same hash">same as the reference</Tag>}
      {triage && <RegionsTriage path={path} path_ref={path_ref} provider={triage} onProviderChange={setTriage} onShow={showRun} onClose={() => setTriage(null)} />}
    </>}
  />;
};

export default ImageViewerForRuns;
