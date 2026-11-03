// Where the image viewer's regions of interest come from.
//
// A provider gives a set of regions for an image of a run:
//   {
//     id: 'presets',
//     label: 'Presets',
//     description: 'shown on hover',
//     // Regions known right away, e.g. from the run's metadata: an array, or null when it has none for this image
//     regions: context => [{ x, y, w, h, label?, color?, imageWidth?, imageHeight? }] | null,
//     // ...or regions found on demand, when users pick the set, e.g. by a server. The signal aborts when users stop
//     // the search.
//     find: async (context, { signal }) => [...regions],
//     // Whether to offer it for this image (by default, always)
//     available: context => boolean,
//     // What the viewer says when there are none, e.g. "No difference found" (by default "No regions")
//     empty: 'No difference found',
//     // Optional: its section in the regions menu (by default "Regions of interest"). `auto`: `find` runs as soon as
//     // the viewer shows, not when users pick the set (for cheap ones: the regions button says how many there are).
//     // `overview`: picking the set shows the whole image with its regions outlined, not the first region.
//     // `key(context)`: what its regions depend on, if not the image pair, `staleTime`: when to find them again.
//     section: 'Annotations', auto: true, overview: true,
//   }
// context: { output_new, output_ref, path, path_ref, diff_size }, diff_size: the size of the differences users look for,
// { min, max } in pixels (either can be null), for the providers that compare the images. Regions are in the pixels of the image shown, or of an image of
// size imageWidth x imageHeight, e.g. the input's: the viewer scales them. A region's `value` (optional) says how
// interesting it is, e.g. how much the images differ there: searches over all the runs of a page rank runs with it.
// Results of `find` are kept by the page (regionSearch.js), for every viewer of the same files.
//
// Sites can add theirs, e.g. the regions of the test charts from an internal API, with registerRegionProvider()
// before the viewers show:
//   registerRegionProvider({
//     id: 'charts',
//     label: 'Test charts',
//     find: async ({ output_new }, { signal }) => (await http.get('/charts/api/rois', { params: { input: output_new.test_input_path }, signal })).data,
//   })
import { http } from '../../api/http';
import { colorAt } from '../../image-viewer/colormaps';


// The presets of the input (in its metadata), and of the configurations
export const presetRegions = output => {
  const from_configurations = (output.configurations ?? [])
    .filter(c => typeof c === 'object' && !!c?.roi)
    .flatMap(c => c.roi);
  const from_input = output.test_input_metadata?.roi ?? [];
  // they are given in the coordinates of the input, which may not have the size of the images shown
  const { width, height } = output.test_input_metadata ?? {};
  const seen = new Set();
  return [...from_input, ...from_configurations]
    .filter(roi => roi && typeof roi === 'object')
    .map(({ image_width, image_height, ...roi }) => ({
      ...roi,
      imageWidth: image_width ?? roi.imageWidth ?? width,
      imageHeight: image_height ?? roi.imageHeight ?? height,
    }))
    .filter(roi => {
      const key = [roi.x, roi.y, roi.w, roi.h, roi.label].join(' ');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

const presets = {
  id: 'presets',
  label: 'Presets',
  description: "The regions of the input's metadata (roi), and of the configurations",
  regions: ({ output_new }) => {
    const regions = presetRegions(output_new);
    return regions.length > 0 ? regions : null;
  },
};


// How the server measures each difference, for labels
const FORMATS = {
  yiq: value => `${(100 * value).toFixed(1)}%`,
  ssim: value => `1−SSIM ${value.toFixed(2)}`,
  ciede2000: value => `ΔE ${value.toFixed(1)}`,
};
export const formatDifference = (diff_type, value) => (FORMATS[diff_type] ?? (v => v.toFixed(2)))(value);

// A region where the server found the images differ: { x, y, w, h, value, diff, spot }, diff relative to the largest
// (1), spot: the difference itself, the region adds context around it
export const differenceToRegion = diff_type => ({ x, y, w, h, value, diff, spot }, index) => {
  const amount = Math.max(0, Math.min(1, diff));
  const [red, green, blue] = colorAt('inferno', 1 - amount);
  return {
    x, y, w, h,
    label: `#${index + 1} · ${formatDifference(diff_type, value)}${spot ? ` · ${spot.w}×${spot.h} px` : ''}`,
    color: `rgb(${red}, ${green}, ${blue})`,
    value,
  };
};

// The server compares the full images, and finds where they differ most
const autoRegions = (diff_type, label, description) => ({
  id: `auto-${diff_type}`,
  diff_type,
  label,
  description,
  empty: 'No difference found',
  available: ({ output_ref }) => !!output_ref && !output_ref.deleted && !!output_ref.output_dir_url,
  // it finds the differences of the size users look for (context.diff_size)
  sized: true,
  find: async ({ output_new, output_ref, path, path_ref, diff_size }, { signal }) => {
    const { data } = await http.post('/api/v1/output/image/diff', {
      output_dir_url_new: output_new.output_dir_url,
      output_dir_url_ref: output_ref.output_dir_url,
      path,
      path_ref: path_ref ?? path,
      diff_type,
      count: 20,
      min_size: diff_size?.min ?? null,
      max_size: diff_size?.max ?? null,
    }, { signal });
    return (data ?? []).map(differenceToRegion(diff_type));
  },
});

const providers = [
  presets,
  autoRegions('yiq', 'Where they differ: perceptual', 'The server compares the full images by perceived color difference (YIQ, like the viewer\'s), pixel by pixel, and finds where they differ most'),
  autoRegions('ssim', 'Where they differ: structure (SSIM)', 'The server compares the full images by structural similarity (SSIM), about 1000 pixels wide, and finds where they differ most'),
  autoRegions('ciede2000', 'Where they differ: ΔE 2000', 'The server compares the full images by CIEDE2000 color difference, about 1000 pixels wide, and finds where they differ most'),
];


// The annotations of the image in another app, from the site's sources (backend/backend/annotations.py): read-only, in
// groups, e.g. who annotated, a task or a workspace. Fetched as soon as the viewer shows (they're cheap, the server
// keeps them a few minutes): the regions button says how many there are.
// source: { id, label, description, group_noun } (site config's annotation_sources)
export const annotationProvider = ({ id, label, description, group_noun }) => ({
  id: `annotations-${id}`,
  label,
  // what its groups are, e.g. "workspace"
  group_noun: group_noun ?? 'group',
  description: description ?? `The annotations of the image in ${label}`,
  section: 'Annotations',
  noun: 'annotations',
  auto: true,
  overview: true,
  staleTime: 5 * 60 * 1000,
  empty: `No annotations of this image in ${label}`,
  available: ({ output_new }) => !output_new.deleted && !!output_new.output_dir_url,
  key: ({ output_new, path }) => [output_new.output_dir_url, path],
  find: async ({ output_new, path, md5 }, { signal }) => {
    const { data } = await http.get(`/api/v1/output/image/annotations/${encodeURIComponent(id)}`, {
      params: { output_dir_url: output_new.output_dir_url, path, md5 },
      signal,
    });
    return annotationsToRegions(data, label);
  },
});

// { groups, annotations } (from the server) as { groups, regions } (for the viewer)
export const annotationsToRegions = ({ groups = [], annotations = [] }, source_label) => {
  const group_of = Object.fromEntries(groups.map(group => [group.id, group]));
  return {
    groups: groups.map(group => ({ ...group, count: annotations.filter(a => a.group === group.id).length })),
    regions: annotations.map(({ id, group, x, y, w, h, label, color, tags, fields, url }) => ({
      id, group, x, y, w, h, label, color, tags, fields,
      detail: group_of[group]?.label,
      href: url,
      hrefLabel: `Open in ${source_label}`,
    })),
  };
};

export const registerRegionProvider = provider => {
  const index = providers.findIndex(p => p.id === provider.id);
  if (index === -1) providers.push(provider);
  else providers[index] = provider;
};

export const regionProviders = () => providers;
