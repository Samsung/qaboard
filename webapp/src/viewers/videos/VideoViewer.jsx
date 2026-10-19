// The video viewer in QA-Board: compares a video of a run with the same video of its reference run.
// It maps runs and their files to VideoCompare's props, with what the server reads from the files
// (backend/backend/api/video.py): what's in them, the decoded values of the pixels, and where the videos differ.
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorMessage, http, isAbort } from '../../api/http';
import { colorAt } from '../../image-viewer/colormaps';
import { useUser } from '../../hooks';
import { at_most, is_same_data } from '../../utils';
import { presetRegions } from '../images/regionProviders';
import '../images/image-viewer-theme.css';
import { VideoCompare } from './VideoCompare';
import { fileUrl } from './utils';

const is_animated_image = path => /\.(webp|gif)$/i.test(path);

// The server reads and compares the videos for signed-in users only
const SIGN_IN = {
  info: "Sign in (in the sidebar) to see what's in the files, and to number the frames like the files do",
  values: 'Sign in (in the sidebar) to read the decoded values of the frames',
  compare: 'Sign in (in the sidebar) to compare the decoded frames of the videos',
};

// The server reads the files from their path: the URL of the run's directory, then the file's
const filePath = (output, path) => `${output.output_dir_url}/${path}`;

const infoQuery = file => ({
  queryKey: ['video-info', file],
  queryFn: async ({ signal }) => (await http.get('/api/v1/output/video/info', { params: { video_url: file }, signal })).data,
  // until the file changes, and it's in the key with the run's directory
  staleTime: Infinity,
  retry: false,
});

// The decoded values of a frame, by tiles of 64x64
const TYPED_ARRAYS = { uint8: Uint8Array, uint16: Uint16Array, int16: Int16Array, uint32: Uint32Array, float32: Float32Array, float64: Float64Array };
const getPixels = async (frame, { x, y, w, h }, { signal }) => {
  const { data, headers } = await http.get('/api/v1/output/video/pixels', {
    params: { video_url: frame.file, frame: frame.frame, x, y, w, h, format: 'binary' },
    responseType: 'arraybuffer',
    signal,
  });
  const [height, width, channels = 1] = headers.get('X-Pixels-Shape').split(',').map(Number);
  const TypedArray = TYPED_ARRAYS[headers.get('X-Pixels-Dtype')] ?? Float64Array;
  return { data: new TypedArray(data), width, height, channels, mode: headers.get('X-Pixels-Mode') ?? undefined };
};

// Where the videos differ, as the image viewer's regions: colored from small (yellow) to large (black)
const percent = value => `${(100 * value).toFixed(value < 0.1 ? 1 : 0)}%`;
const toRegion = (region, i, label) => {
  const [red, green, blue] = colorAt('inferno', 1 - Math.max(0, Math.min(1, region.diff ?? 1)));
  return { ...region, label: label(region, i), color: `rgb(${red}, ${green}, ${blue})` };
};
const frameRange = ({ start, end }) => start === end ? `frame ${start}` : `frames ${start}–${end}`;

const summarize = data => {
  const frames = data.frames ?? [];
  const differing = frames.filter(f => f.max > 0).length;
  const worst = frames.reduce((best, f, i) => f.value > (frames[best]?.value ?? -1) ? i : best, 0);
  const summary = differing === 0
    ? `Identical decoded frames${data.complete ? '' : ' (so far)'}`
    : `Differ in ${differing} of ${frames.length} frames · most at frame ${worst} (Δ ${frames[worst].max}${frames[worst].psnr ? `, PSNR ${frames[worst].psnr.toFixed(1)} dB` : ''})`;
  return {
    summary: data.complete ? summary : `${summary} · ${data.reason}`,
    summaryTitle: 'The decoded frames, compared by the server, each with the frame of the reference shown at the same time. Δ: the largest difference of a value (Y′, Cb, Cr…). Hover the timeline for each frame, n / N go from one difference to the next.',
  };
};

const VideoViewer = ({
  output_new,
  output_ref,
  path,
  path_ref,
  manifests,
  poster = 'poster.jpg',
  fps,
  style,
  fullscreen,
}) => {
  const queryClient = useQueryClient();
  const signed_in = useUser().is_logged;
  const path_reference = path_ref ?? path;
  const animation = is_animated_image(path);
  const same = !!output_ref && is_same_data(path, manifests?.new?.[path], manifests?.reference?.[path_reference]);
  const comparing = !!output_ref && !same;
  const file_new = filePath(output_new, path);
  const file_ref = comparing ? filePath(output_ref, path_reference) : null;

  const query_new = useQuery({ ...infoQuery(file_new), enabled: signed_in && !animation });
  const query_ref = useQuery({ ...infoQuery(file_ref), enabled: signed_in && !animation && comparing });
  const info_error = !signed_in ? SIGN_IN.info
    : [query_new, query_ref].map(q => q.error && !isAbort(q.error) ? errorMessage(q.error) : null).find(Boolean);
  // the server can decode them
  const decodable = signed_in && !!query_new.data?.times;

  const video = {
    url: fileUrl(output_new, path),
    label: 'new',
    file: file_new,
    info: query_new.data,
    size: manifests?.new?.[path]?.st_size,
  };
  const reference = comparing ? {
    url: fileUrl(output_ref, path_reference),
    label: 'reference',
    file: file_ref,
    info: query_ref.data,
    size: manifests?.reference?.[path_reference]?.st_size,
  } : null;

  // Where they differ: the server compares the decoded frames, on demand
  const diff_query = {
    queryKey: ['video-diff', file_new, file_ref],
    queryFn: async ({ signal }) => (await http.post('/api/v1/output/video/diff', {
      output_dir_url_new: output_new.output_dir_url,
      output_dir_url_ref: output_ref.output_dir_url,
      path,
      path_ref: path_reference,
      count: 20,
    }, { signal })).data,
    staleTime: Infinity,
    gcTime: 60 * 60 * 1000,
    retry: false,
  };
  const diff = useQuery({ ...diff_query, enabled: false });
  const load = signed_in ? () => queryClient.fetchQuery(diff_query).catch(() => {}) : undefined;
  const diff_error = !signed_in ? SIGN_IN.compare : diff.error && !isAbort(diff.error) ? errorMessage(diff.error) : undefined;
  const data = diff.data;
  const differences = comparing && !animation ? {
    frames: data?.frames,
    loading: diff.fetchStatus === 'fetching',
    error: diff_error,
    load,
    ...(data ? summarize(data) : {}),
  } : null;
  const search = {
    loading: diff.fetchStatus === 'fetching',
    error: diff_error,
    load,
    empty: 'No difference found',
  };
  const region_sets = [];
  const presets = presetRegions(output_new);
  if (presets.length) region_sets.push({ id: 'presets', label: 'Presets', description: "The regions of the input's metadata (roi), and of the configurations", regions: presets });
  if (comparing && !animation) {
    region_sets.push({
      ...search,
      id: 'auto-video',
      label: 'Differences, whole video',
      description: 'Where and when the videos differ most: the server compares every decoded frame (Y′, Cb, Cr…). Picking a region shows its frame.',
      regions: data?.regions?.map((region, i) => toRegion(region, i, (r, j) => `#${j + 1} · Δ ${percent(r.value)} · ${frameRange(r)}`)),
    });
    region_sets.push({
      ...search,
      id: 'auto-frame',
      label: 'Differences, this frame',
      description: 'Where the decoded frame shown differs most from the reference\'s: it follows the frame',
      perFrame: true,
      regions: data?.frames ? [] : undefined,
      regionsAt: frame => data?.frames?.[frame]?.regions?.map((region, i) => toRegion(region, i, (r, j) => `#${j + 1} · Δ ${percent(r.value)}`)) ?? (data ? [] : null),
    });
  }

  return <VideoCompare
    className="qaboard-image-viewer qaboard-video-viewer"
    style={{ width: fullscreen ? '100%' : at_most(style?.width), maxWidth: '100%' }}
    video={video}
    reference={reference}
    same={same && output_ref?.id !== output_new.id}
    fps={fps}
    poster={manifests?.new?.[poster] ? fileUrl(output_new, poster) : undefined}
    posterReference={comparing && manifests?.reference?.[poster] ? fileUrl(output_ref, poster) : undefined}
    getPixels={decodable ? getPixels : undefined}
    decodedUnavailable={signed_in ? undefined : SIGN_IN.values}
    differences={differences}
    regionSets={region_sets}
    infoLoading={query_new.isLoading || (comparing && query_ref.isLoading)}
    infoError={info_error}
    maxHeight={height => height - (fullscreen ? 130 : 300)}
    animation={animation}
  />;
};

export default VideoViewer;
