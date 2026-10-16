// Where the image viewer's regions of interest come from.
//
// A provider gives a set of regions for an image of a run:
//   {
//     id: 'presets',
//     label: 'Presets',
//     description: 'shown on hover',
//     // Regions known right away, e.g. from the run's metadata: an array, or null when it has none for this image
//     regions: context => [{ x, y, w, h, label?, color?, imageWidth?, imageHeight? }] | null,
//     // ...or regions found on demand, when users pick the set, e.g. by a server. The signal aborts when the viewer
//     // shows another image, or goes away.
//     find: async (context, { signal }) => [...regions],
//     // Whether to offer it for this image (by default, always)
//     available: context => boolean,
//   }
// context: { output_new, output_ref, path, path_ref }. Regions are in the pixels of the image shown, or of an image of
// size imageWidth x imageHeight, e.g. the input's: the viewer scales them.
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


// A peak of difference found by the server, with how large it is relative to the largest (1)
export const blobToRegion = ({ x, y, r, diff }, index) => {
  const amount = Math.max(0, Math.min(1, diff));
  const [red, green, blue] = colorAt('inferno', 1 - amount);
  const radius = Math.max(1, r);
  return {
    // the peak is at the center
    x: x - radius,
    y: y - radius,
    w: 2 * radius,
    h: 2 * radius,
    label: `#${index + 1} · ${Math.round(100 * amount)}%`,
    color: `rgb(${red}, ${green}, ${blue})`,
  };
};

// The server compares the full images, and finds where they differ most
const autoRegions = (diff_type, label, description) => ({
  id: `auto-${diff_type}`,
  label,
  description,
  available: ({ output_ref }) => !!output_ref && !output_ref.deleted && !!output_ref.output_dir_url,
  find: async ({ output_new, output_ref, path }, { signal }) => {
    const { data } = await http.post('/api/v1/output/image/diff', {
      output_dir_url_new: output_new.output_dir_url,
      output_dir_url_ref: output_ref.output_dir_url,
      path,
      diff_type,
      threshold: 0.01,
      diameter: 0,
      count: 20,
    }, { signal });
    return (data ?? []).map(blobToRegion);
  },
});

const providers = [
  presets,
  autoRegions('yiq', 'Where they differ: perceptual', 'The server compares the full images by perceived color difference (YIQ) and finds where they differ most'),
  autoRegions('ssim', 'Where they differ: structure (SSIM)', 'The server compares the full images by structural similarity (SSIM) and finds where they differ most'),
  autoRegions('ciede2000', 'Where they differ: ΔE 2000', 'The server compares the full images by CIEDE2000 color difference and finds where they differ most'),
];

export const registerRegionProvider = provider => {
  const index = providers.findIndex(p => p.id === provider.id);
  if (index === -1) providers.push(provider);
  else providers[index] = provider;
};

export const regionProviders = () => providers;
