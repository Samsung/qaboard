// The image viewer in QA-Board: compares an image of a run with the same image of its reference run.
// It maps runs, their files and the site's image servers to the viewer's props (src/image-viewer/README.md).
import { useEffect, useState } from 'react';
import { Tag } from '@blueprintjs/core';
import { create } from 'zustand';

import { ImageViewer } from '../../image-viewer';
import { http } from '../../api/http';
import { useSiteConfig } from '../../hooks';
import { usePrefsStore } from '../../stores/prefs';
import { is_same_data } from '../../utils';
import { build_image_name, iiif_url } from './utils';
import { regionProviders } from './regionProviders';
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

// The regions of interest of the providers, found on demand
const useRegionSets = context => {
  const { output_new, output_ref, path, path_ref } = context;
  const key = `${output_new?.id} ${output_ref?.id} ${path} ${path_ref}`;
  const [found, setFound] = useState({ key, sets: {} });
  // the searches for another image, or after the viewer is gone, are cancelled
  const [searches] = useState(() => new Set());
  useEffect(() => () => {
    searches.forEach(search => search.abort());
    searches.clear();
  }, [searches, key]);
  const current = found.key === key ? found.sets : {};
  const start = id => setFound(f => ({ key, sets: { ...(f.key === key ? f.sets : {}), [id]: { loading: true } } }));
  // results for another image are dropped
  const update = (id, state) => setFound(f => f.key === key ? { key, sets: { ...f.sets, [id]: state } } : f);
  const sets = [];
  for (const provider of regionProviders()) {
    if (provider.available && !provider.available(context)) continue;
    const base = { id: provider.id, label: provider.label, description: provider.description };
    if (provider.regions) {
      const regions = provider.regions(context);
      if (regions?.length) sets.push({ ...base, regions });
      continue;
    }
    if (!provider.find) continue;
    const state = current[provider.id] ?? {};
    sets.push({
      ...base,
      ...state,
      load: () => {
        if (state.loading) return;
        start(provider.id);
        const search = new AbortController();
        searches.add(search);
        provider.find(context, { signal: search.signal }).then(
          regions => update(provider.id, { regions }),
          error => search.signal.aborted || update(provider.id, { error: error?.response?.data?.error ?? error?.message ?? String(error) }),
        ).finally(() => searches.delete(search));
      },
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
  const region_sets = useRegionSets({ output_new, output_ref: reference ? output_ref : null, path, path_ref });

  return <ImageViewer
    className="qaboard-image-viewer"
    style={{ width: fullscreen ? '100%' : style?.width, maxWidth: '100%' }}
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
    defaultRegionSet={region_sets.some(set => set.id === 'presets') ? 'presets' : null}
    getPixels={getPixels}
    maxHeight={height => height - (fullscreen ? 120 : 260)}
    notice={<>
      {label && <span className="qaboard-image-viewer-label">{label}</span>}
      {/* no tooltips: they wouldn't show in full screen */}
      {same_data && <Tag minimal icon="duplicate" title="The new and reference files have the same hash">same as the reference</Tag>}
    </>}
  />;
};

export default ImageViewerForRuns;
