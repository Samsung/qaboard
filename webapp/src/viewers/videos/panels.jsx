// The video viewer's panels: what's in the files, the values under the pointer, which values are written on the
// pixels, which frames show. They use the image viewer's styles (src/image-viewer/image-viewer.css).
import { memo, useEffect, useState, useSyncExternalStore } from 'react';

import { Chip } from '../../image-viewer/panels';
import { DIFF_METHODS, diffAt, formatDiffValue, normalizeDiff } from '../../image-viewer/metrics';
import { formatNumber, formatSigned } from '../../image-viewer/pixels';
import { Icon, Spinner } from '../../image-viewer/ui';
import { displayPixel } from './frames';
import { useFrameVersion } from './overlays';
import { formatFps, formatTime } from './utils';

// Users mix them up: we say which is which
export const DECODED_VALUES = "The decoded values: the frame's own, as the codec stores them (e.g. Y′, Cb, Cr in 10 bits), decoded by the server";
export const DISPLAY_VALUES = 'The displayed values: the 8-bit RGB on your screen, after your browser converted the decoded frame';


// --- What's in the files ---

const formatBytes = bytes => {
  if (!Number.isFinite(bytes)) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};
const formatBitRate = bits => Number.isFinite(bits) && bits > 0 ? `${bits >= 1e6 ? (bits / 1e6).toFixed(1) : Math.round(bits / 1e3)} ${bits >= 1e6 ? 'Mb/s' : 'kb/s'}` : null;

const gop = info => {
  const keys = info?.keyframes ?? [];
  if (keys.length < 2) return keys.length === 1 ? 'one, the first frame' : null;
  return `${keys.length}, every ${Math.round((keys[keys.length - 1] - keys[0]) / (keys.length - 1))} frames`;
};

// [label, value of an info, help]. info: the server's (backend/videos.py probe) and the browser's
const ROWS = [
  ['File', info => formatBytes(info.size)],
  ['Container', info => info.container],
  ['Codec', info => info.codec ? `${info.codec}${info.profile ? ` (${info.profile})` : ''}` : null, 'codec_long_name'],
  ['Compression', info => info.lossless ? 'lossless' : info.codec ? 'lossy, unless encoded losslessly' : null],
  ['Pixel format', info => info.pix_fmt],
  ['Bit depth', info => info.bit_depth ? `${info.bit_depth}-bit` : null],
  ['Chroma', info => info.chroma_subsampling ?? (info.pix_fmt ? 'none (gray)' : null)],
  ['Color range', info => info.color_range ?? (info.codec ? 'unspecified' : null)],
  ['Color matrix', info => info.color_matrix ?? (info.codec ? 'unspecified' : null)],
  ['Primaries', info => info.color_primaries],
  ['Transfer', info => info.color_transfer],
  ['Resolution', info => info.width ? `${info.width}×${info.height}${info.sample_aspect_ratio && info.sample_aspect_ratio !== '1/1' && info.sample_aspect_ratio !== '1' ? `, pixels ${info.sample_aspect_ratio}` : ''}` : null],
  ['Frame rate', info => info.fps ? `${formatFps(info.fps)}${info.variable_frame_rate ? ', variable' : ''}` : null],
  ['Frames', info => info.frame_count ?? null],
  ['Duration', info => Number.isFinite(info.duration) ? formatTime(info.duration) : null],
  ['Bit rate', info => formatBitRate(info.bit_rate)],
  ['Keyframes', info => gop(info)],
  ['Audio', info => info.audio ? (info.audio.length ? info.audio.map(a => `${a.codec} ${a.channels}ch ${a.sample_rate / 1000} kHz`).join(', ') : 'none') : null],
];

// What the browser does with the frames, from what's in the file
const notes = info => {
  if (!info?.codec) return [];
  const list = [];
  const yuv = info.channels?.[0] === 'Y' && info.channels.length > 1;
  if (yuv) list.push(`Your browser shows 8-bit RGB: it converts the decoded Y′CbCr with the ${info.color_matrix ?? 'BT.601 or BT.709 (it guesses: unspecified)'} matrix, ${info.color_range ?? 'limited (it guesses: unspecified)'} range. The decoded values (p) are the file's.`);
  if (info.bit_depth > 8) list.push(`${info.bit_depth}-bit: the displayed values are rounded to 8 bits, the decoded ones aren't.`);
  if (info.chroma_subsampling === '4:2:0' || info.chroma_subsampling === '4:2:2') list.push(`Chroma ${info.chroma_subsampling}: colors are stored at ${info.chroma_subsampling === '4:2:0' ? 'half the width and height' : 'half the width'}, colored edges bleed whatever the algorithm did.`);
  if (!info.lossless) list.push(`${info.codec} is lossy unless encoded losslessly: the frames differ from what the code wrote. To compare exact values, encode losslessly, e.g. ffmpeg -i in -c:v libvpx-vp9 -lossless 1 -pix_fmt yuv444p out.webm (plays in Chrome and Firefox).`);
  if (info.variable_frame_rate) list.push('Variable frame rate: frames are numbered from their timestamps in the file.');
  return list;
};

export const InfoPanel = ({ infos, names, comparing, loading, error, elements }) => {
  // the browser's counts change as the videos play
  const [, redraw] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => redraw(n => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const shown = comparing ? ['new', 'reference'] : ['new'];
  const quality = which => {
    const q = elements[which]?.getVideoPlaybackQuality?.();
    return q && q.totalVideoFrames ? `${q.totalVideoFrames - q.droppedVideoFrames} shown, ${q.droppedVideoFrames} dropped` : null;
  };
  const rows = [...ROWS, ['Browser', (_, which) => quality(which), null, 'Frames your browser presented and dropped while playing: dropped frames were never shown']];
  // what's true of both once, the rest for each
  const by_video = shown.map(which => notes(infos[which]));
  const common = by_video[0].filter(note => by_video.every(list => list.includes(note)));
  const all_notes = [...common, ...shown.flatMap((which, i) => by_video[i].filter(note => !common.includes(note)).map(note => `${names[which]}: ${note}`))];
  return <div className="qiv-panel video-info-panel">
    <div className="qiv-panel-title"><span>What's in the {comparing ? 'files' : 'file'}</span>{loading && <Spinner size={12} label="Reading the files" />}</div>
    {error && <div className="qiv-warning-text">{error}</div>}
    <table className="qiv-shortcuts video-info">
      {comparing && <thead><tr><th aria-label="Property" /><th>{names.new}</th><th>{names.reference}</th></tr></thead>}
      <tbody>
        {rows.map(([label, value, long, help]) => {
          const values = shown.map(which => infos[which] ? value(infos[which], which) : null);
          if (values.every(v => v === null || v === undefined)) return null;
          const differ = comparing && label !== 'Browser' && label !== 'File' && String(values[0]) !== String(values[1]);
          return <tr key={label} className={differ ? 'video-info-differs' : ''} title={differ ? 'They differ' : help}>
            <td>{label}</td>
            {values.map((v, i) => <td key={i} title={long ? infos[shown[i]]?.[long] : undefined}>{v ?? '–'}</td>)}
          </tr>;
        })}
      </tbody>
    </table>
    {all_notes.length > 0 && <ul className="qiv-hint video-info-notes">{all_notes.map(note => <li key={note}>{note}</li>)}</ul>}
  </div>;
};


// --- Values under the pointer ---

const Values = ({ values, base, signed = false }) => <span className="qiv-values">
  {values.map(v => v === null ? '–' : signed ? formatSigned(v) : formatNumber(v, base)).join(' ')}
</span>;

// The decoded value of the pixel, from the tiles: { value, mode, error }, null without them
const useDecodedValue = (tiles, frame, size, pixel) => {
  'use no memo';
  useSyncExternalStore(tiles.subscribe, tiles.getVersion);
  const x = pixel?.x;
  const y = pixel?.y;
  useEffect(() => {
    if (frame && x !== undefined) tiles.requestLatest(frame, size, x, y);
    // oxlint-disable-next-line react/exhaustive-deps
  }, [tiles, frame?.url, size?.width, size?.height, x, y]);
  if (!tiles.getPixels || !frame || x === undefined) return null;
  const value = tiles.get(frame, x, y);
  return { value, mode: tiles.mode(frame), error: value === null ? tiles.error(frame) : null };
};

const PixelOf = ({ label, intent, display, decoded, pixel, base, why, showMode = true }) => <span className="qiv-readout-image">
  <span className={`qiv-readout-label qiv-${intent}`}>{label}</span>{' '}
  {display && <span className="qiv-swatch" style={{ background: `rgb(${display[0]},${display[1]},${display[2]})` }} title="The displayed color" />}
  {decoded && <span title={`${DECODED_VALUES}${decoded.mode ? `. Here: ${decoded.mode}` : ''}`}>
    <Chip>decoded</Chip>{' '}
    {decoded.value ? <Values values={decoded.value} base={base} />
      : decoded.value === undefined ? <span className="qiv-muted">…</span>
      : <span className="qiv-warning-text" title={decoded.error ?? "Can't read the decoded values"}>unavailable</span>}
    {decoded.mode && showMode && <span className="qiv-muted"> {decoded.mode}</span>}{' '}
  </span>}
  {display && <span title={DISPLAY_VALUES}><Chip>display</Chip> <Values values={display.slice(0, 3)} base={base} />{' '}</span>}
  {!decoded && why && <span className="qiv-muted" title={DECODED_VALUES}>({why}) </span>}
  {!display && pixel === null && <span className="qiv-muted">outside</span>}
</span>;

// The pixel under the pointer (point: { u, v } in [0, 1] of the frames), for the videos in the order they show
export const Readout = ({ controller, point, videos, sizes, frames, why, unavailable, order, comparing, names, neutral, diff, base, onToggleBase, tiles }) => {
  'use no memo';
  const pixel = which => {
    const size = sizes[which];
    if (!point || !size?.width || point.u < 0 || point.u >= 1 || point.v < 0 || point.v >= 1) return null;
    return { x: Math.floor(point.u * size.width), y: Math.floor(point.v * size.height) };
  };
  const pixels = { new: pixel('new'), reference: comparing ? pixel('reference') : null };
  // read again when the frame changes
  useFrameVersion(controller);
  const display = {
    new: pixels.new && displayPixel(videos.new, pixels.new.x, pixels.new.y),
    reference: pixels.reference && displayPixel(videos.reference, pixels.reference.x, pixels.reference.y),
  };
  const decoded = {
    new: useDecodedValue(tiles, frames.new, sizes.new, pixels.new),
    reference: useDecodedValue(tiles, comparing ? frames.reference : null, sizes.reference, pixels.reference),
  };
  const shown = comparing ? order : ['new'];
  const [first, second] = order;
  const intent = which => neutral ? 'neutral' : which === 'new' ? 'primary' : 'warning';
  if (!point) {
    const size = s => s?.width ? `${s.width}×${s.height}` : '…';
    return <div className="qiv-readout qiv-muted">
      <span>{shown.map(which => comparing ? `${names[which]} ${size(sizes[which])}` : size(sizes[which])).join(' · ')}</span>
      <span className="qiv-readout-hint">Hover a pixel for its values · scroll to zoom · drag to pan · click to play{unavailable && <> · <span className="qiv-warning-text">{unavailable}</span></>}</span>
    </div>;
  }
  const { method } = normalizeDiff(diff);
  const delta = comparing && display[first] && display[second] ? diffAt(diff, display[first], display[second]) : null;
  const same_size = sizes.new?.width === sizes.reference?.width && sizes.new?.height === sizes.reference?.height;
  const a = decoded[first]?.value;
  const b = decoded[second]?.value;
  const decoded_delta = same_size && a && b && a.length === b.length ? a.map((v, i) => v - b[i]) : null;
  const coordinates = pixels[first] ?? pixels[second];
  const moved = comparing && pixels[first] && pixels[second] && (pixels[first].x !== pixels[second].x || pixels[first].y !== pixels[second].y);
  return <button
    type="button"
    className="qiv-readout"
    onClick={onToggleBase}
    title={`The pixel under the pointer. Click to show the values in ${base === 10 ? 'hexadecimal' : 'decimal'}`}
  >
    {coordinates && <span className="qiv-coordinates" aria-label="Pixel">x {coordinates.x} y {coordinates.y} </span>}
    {moved && <span className="qiv-coordinates qiv-muted">({names[second]} x {pixels[second].x} y {pixels[second].y}) </span>}
    {shown.map((which, i) => <PixelOf
      key={which}
      label={comparing ? names[which] : ''}
      intent={intent(which)}
      display={display[which]}
      decoded={decoded[which]}
      pixel={pixels[which]}
      base={base}
      why={i === 0 ? why : null}
      // said once, when they're the same
      showMode={i === 0 || decoded[which]?.mode !== decoded[shown[0]]?.mode}
    />)}
    {delta && <span className="qiv-readout-image" title={`${names[first]} − ${names[second]}`}>
      <span className="qiv-readout-label">Δ</span>{' '}
      {decoded_delta
        ? <span title={DECODED_VALUES}><Chip>decoded</Chip> <Values values={decoded_delta} signed /></span>
        : <span title={DISPLAY_VALUES}><Chip>display</Chip> <Values values={delta.delta} signed /></span>}
      {formatDiffValue(method, delta.value) && <span className="qiv-diff-value" title={`${DIFF_METHODS[method].title}, on the displayed colors`}>
        {' '}{method === 'perceptual' ? 'perceptual ' : ''}{formatDiffValue(method, delta.value)}
      </span>}
    </span>}
  </button>;
};


// --- Values written on the pixels ---

export const ValuesPanel = ({ source, available, unavailable, onChange }) => {
  const options = [
    { value: 'decoded', label: 'Decoded values', description: `${DECODED_VALUES}. Exact: the server decodes the very frame your browser shows.`, disabled: !available },
    { value: 'display', label: 'Displayed values', description: `${DISPLAY_VALUES}.` },
    { value: 'off', label: 'Off' },
  ];
  return <div className="qiv-panel qiv-values-panel" role="radiogroup" aria-label="Values written on the pixels">
    <div className="qiv-panel-title"><span>Values written on the pixels</span></div>
    {options.map(option => <label key={option.value} className={`qiv-option ${option.disabled ? 'qiv-disabled' : ''}`}>
      <input type="radio" name="video-values" value={option.value} checked={source === option.value} disabled={option.disabled} onChange={() => onChange(option.value)} />
      <span>
        <strong>{option.label}</strong>
        <span className="qiv-option-description">{option.description}</span>
        {option.disabled && <span className="qiv-option-description">{unavailable ?? "Not available: the server can't read these videos."}</span>}
      </span>
    </label>)}
    <div className="qiv-hint">They show once you zoom in enough, on paused videos. The line above the videos shows both for the pixel under the pointer. <kbd>p</kbd> shows or hides them.</div>
  </div>;
};

export const ValuesBadge = ({ drawn }) => drawn && <div className="qiv-values-badge" title={drawn.source === 'decoded' ? DECODED_VALUES : DISPLAY_VALUES}>
  {drawn.source === 'decoded' ? <>Values: decoded{drawn.mode ? ` (${drawn.mode})` : ''}</> : <>Values: displayed, 8-bit RGB</>}
  {drawn.loading && <Spinner size={10} label="Loading the values" />}
</div>;


// --- Which frames show ---

// Whether users look at the frames they think they do: while playing, browsers skip frames, and the reference may
// lag. Paused, each video presents one frame: we know which from its timestamp, exactly when the server read the
// timestamps of the file's frames.
export const frameStatus = (s, comparing, names) => {
  if (!s.ready) return null;
  if (s.playing) return { kind: 'playing', text: 'Playing', title: 'While playing, your browser can skip frames, and the videos can be a frame apart. Pause, or step with ← →, to look at exact frames.' };
  if (!s.settled) return { kind: 'seeking', text: 'Seeking…' };
  const a = s.presented;
  const b = s.presentedReference;
  if (!a) return { kind: 'unknown', text: s.frame !== null ? `Frame ${s.frame}?` : 'Frame ?', title: 'Your browser doesn\'t say which frame it shows (it needs requestVideoFrameCallback), or the frame rate is unknown.' };
  const how = a.exact ? 'from the timestamps of the file\'s frames' : 'estimated from the frame rate: the server didn\'t read the file';
  if (!comparing) return { kind: a.exact ? 'exact' : 'estimated', text: `Frame ${a.index}${a.exact ? '' : '?'}`, title: `Your browser shows frame ${a.index} (timestamp ${a.mediaTime.toFixed(3)} s), ${how}.` };
  if (!b) return { kind: 'estimated', text: `Frame ${a.index}${a.exact ? '' : '?'}`, title: `The ${names.new} video shows frame ${a.index}, ${how}. The ${names.reference} video is still seeking, or doesn't cover this time.` };
  const exact = a.exact && b.exact;
  if (a.index === b.index) return {
    kind: exact ? 'exact' : 'estimated',
    text: `Frame ${a.index}${exact ? ' · both' : '?'}`,
    title: `Both videos show their frame ${a.index}${exact ? ': the very frames decoded from the files, numbered from their timestamps' : `, ${how}`}. The displayed colors are your browser's 8-bit RGB.`,
  };
  return {
    kind: 'mismatch',
    text: `${names.new} ${a.index} · ${names.reference} ${b.index}`,
    title: `The videos show different frames: ${names.new} ${a.index} (${a.mediaTime.toFixed(3)} s), ${names.reference} ${b.index} (${b.mediaTime.toFixed(3)} s). Their frames have different timestamps (other frame rates, or a shifted start): they're compared at the same time.`,
  };
};

export const FrameBadge = memo(({ controller, comparing, names, frameType }) => {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const status = frameStatus(s, comparing, names);
  if (!status) return null;
  const type = status.kind === 'exact' || status.kind === 'estimated' ? frameType?.(s.presented?.index) : null;
  return <div className={`video-frame-badge video-frame-${status.kind}`} title={status.title} aria-label="Frames shown">
    {status.kind === 'exact' && <Icon icon="tick" size={11} />}
    {status.kind === 'mismatch' && <Icon icon="warning-sign" size={11} />}
    {status.text}
    {type && <span className="video-frame-type" title="The frame's type: I (intra, a keyframe), P (predicted), B (bi-directional)">{type}</span>}
  </div>;
});


// --- Keyboard shortcuts ---

export const SHORTCUTS = [
  ['Space, k', 'Play / pause (or click the video)'],
  ['← → , .', 'Previous / next frame'],
  ['Shift ← →', 'Back / forward 1 second'],
  ['Home End', 'First / last frame'],
  ['< >', 'Slower / faster'],
  ['1 2 3 4', 'Side by side / wipe / single / difference (4 again: between the videos, or alone)'],
  ['t', 'Toggle: swap the sides. Showing one video or the difference alone: the other video, the difference, and again'],
  ['+ − 0', 'Zoom in / out / fit'],
  ['Wheel, pinch', 'Zoom'],
  ['Drag', 'Pan (or move the wipe when not zoomed)'],
  ['p', 'Show / hide the pixel values when zoomed in'],
  ['[ ]', 'Previous / next region of interest'],
  ['n N', 'Next / previous frame where the videos differ most (once found)'],
  ['h', 'Blind test: the videos in a random order, called A and B. h again reveals them, then ends it'],
  ['f', 'Full screen'],
  ['m', 'Mute / unmute'],
];

export const Shortcuts = () => <table className="qiv-shortcuts">
  <tbody>
    {SHORTCUTS.map(([keys, action]) => <tr key={keys}><td><kbd>{keys}</kbd></td><td>{action}</td></tr>)}
  </tbody>
</table>;
