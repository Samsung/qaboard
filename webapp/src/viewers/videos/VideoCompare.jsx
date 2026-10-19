// Compares a video with a reference: they play in sync, frame by frame, side by side, with a wipe, one at a time
// (single), or as their difference, between them or alone. Zoom (wheel, pinch) and pan (drag) apply to all.
// It looks and works like the image viewer (src/image-viewer/), with its styles, difference methods and display
// adjustments, and doesn't depend on QA-Board: VideoViewer.jsx gives it the runs' files and the server's data.
//
// What users look at is said: which frame each video shows (exactly, when the server read the file's timestamps),
// the values of the pixels as displayed (the browser's 8-bit RGB), and as decoded (the file's, from `getPixels`).
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { DEFAULT_DIFF, normalizeDiff } from '../../image-viewer/metrics';
import { ALL_CHANNELS } from '../../image-viewer/histogram';
import { MODES } from '../../image-viewer/modes';
import { changedAdjustments, filterPrimitives, normalizeAdjustments } from '../../image-viewer/adjustments';
import { AdjustmentsPanel, DiffLegend, DiffSettings, Histogram, RegionsMenu, RegionsStrip } from '../../image-viewer/panels';
import { PixelTiles } from '../../image-viewer/pixelTiles';
import { regionAsYaml, scaleRegion } from '../../image-viewer/regions';
import { Button, FilterPrimitive, Icon, MenuDivider, MenuItem, Popover, Segmented, Spinner } from '../../image-viewer/ui';
import '../../image-viewer/image-viewer.css';

import { SyncedPlayback } from './syncedPlayback';
import { FIT, clampView, fitRegion, panBy, transformOf, videoPointAt, zoomAt, zoomLimits, zoomTo } from './viewTransform';
import { Transport, RATES } from './Transport';
import { DiffLayer, HighlightLayer, Minimap, PixelValues, RegionOutline } from './overlays';
import { FrameBadge, InfoPanel, Readout, Shortcuts, ValuesBadge, ValuesPanel } from './panels';
import { frameCanvas } from './frames';
import { copyFrame, mediaErrorMessage, saveFrame, usePreference } from './utils';
import './videos.css';

const GAP = 4;
const ZOOM_STEP = 1.5;
// a press that moves less is a click
const CLICK_SLOP = 4;
// grab the wipe's divider that close
const WIPE_GRAB = 14;

const basename = url => decodeURIComponent((url ?? 'video').split(/[?#]/)[0].split('/').pop()).replace(/\.[^.]+$/, '');
const clamp = (x, min, max) => Math.min(max, Math.max(min, x));
const other_letter = letter => letter === 'A' ? 'B' : 'A';

// The size, duration and error of a <video> or <img>. We read them from the element:
// it can load before React commits it, and React drops the events of elements it hasn't committed.
const MEDIA_EVENTS = ['loadedmetadata', 'loadeddata', 'resize', 'durationchange', 'error', 'emptied', 'load'];
const useMediaInfo = element => {
  const subscribe = useCallback(onChange => {
    if (!element) return () => {};
    MEDIA_EVENTS.forEach(type => element.addEventListener(type, onChange));
    return () => MEDIA_EVENTS.forEach(type => element.removeEventListener(type, onChange));
  }, [element]);
  const state = useSyncExternalStore(subscribe, () => {
    if (!element) return '';
    if (element instanceof HTMLImageElement) {
      const failed = element.complete && !element.naturalWidth && !!element.getAttribute('src');
      return JSON.stringify([element.naturalWidth, element.naturalHeight, null, failed ? 4 : null, null]);
    }
    const loaded = element.readyState >= 1;
    return JSON.stringify([loaded ? element.videoWidth : 0, loaded ? element.videoHeight : 0, loaded ? element.duration : null, element.error?.code ?? null, element.error?.message ?? null]);
  });
  return useMemo(() => {
    if (!state) return undefined;
    const [width, height, duration, code, message] = JSON.parse(state);
    return { width, height, duration, error: code ? { code, message } : null };
  }, [state]);
};

const VideoError = ({ error, src, name }) => <div className="qiv-message qiv-pane-message video-message">
  <strong>Can't play {name ? `the ${name} video` : 'this video'}</strong>
  <span>{mediaErrorMessage(error)}</span>
  {(error.code === 3 || error.code === 4) && <span className="video-message-hint">
    Browsers play H.264, VP9 or AV1 videos (.mp4, .webm). To convert:{' '}
    <code>ffmpeg -i input -c:v libx264 -pix_fmt yuv420p -movflags +faststart output.mp4</code>
  </span>}
  {src && <a href={src} target="_blank" rel="noopener noreferrer">Open the file</a>}
</div>;

// Keyboard shortcuts work for the viewer in full screen, else under the mouse, else with the focus
let hovered_viewer = null;


export const VideoCompare = ({
  // { url, label?, href?, info?, size? }: info is what's in the file (backend/videos.py), size its bytes
  video,
  reference = null,
  // when the reference is the same file: shown once, and said
  same = false,
  fps,
  poster,
  posterReference,
  // the decoded values of a frame: (frame, { x, y, w, h }, { signal }) => Promise, frame: { ...video, frame }
  getPixels,
  // without getPixels: why the decoded values aren't available
  decodedUnavailable,
  // how much the videos differ, frame by frame: { frames: [{ time, value, regions, ... }], loading, error, load() }
  differences,
  // regions of interest, like the image viewer's: [{ id, label, regions, loading, error, load, perFrame }]
  regionSets = [],
  infoLoading = false,
  infoError = null,
  maxHeight = window_height => window_height - 300,
  notice,
  className = '',
  style,
  // animated images (.webp, .gif): the browser plays them on its own
  animation = false,
}) => {
  const comparing = !!reference;
  const labels = { new: video.label ?? 'new', reference: reference?.label ?? 'reference' };
  const [controller] = useState(() => new SyncedPlayback({ fps: Number(fps) }));
  useEffect(() => controller.setFps(Number(fps)), [controller, fps]);

  // the <video> (or <img>) elements. The videos are attached to the controller
  const [element_new, setElementNew] = useState(null);
  const [element_ref, setElementRef] = useState(null);
  const video_new = animation ? null : element_new;
  const video_ref = animation || !comparing ? null : element_ref;
  useEffect(() => {
    if (!video_new) return;
    controller.attach(video_new, video_ref);
    return () => controller.detach();
  }, [controller, video_new, video_ref]);
  // the frames' timestamps: exact frame numbers
  const times_new = video.info?.times;
  const times_ref = reference?.info?.times;
  useEffect(() => controller.setFrameTimes(video_new, times_new), [controller, video_new, times_new]);
  useEffect(() => controller.setFrameTimes(video_ref, times_ref), [controller, video_ref, times_ref]);
  const info_new = useMediaInfo(element_new);
  const info_ref = useMediaInfo(comparing ? element_ref : null);
  const sizes = { new: info_new?.width ? info_new : null, reference: info_ref?.width ? info_ref : null };

  const [stored_mode, setMode] = usePreference('mode', 'side-by-side');
  const modes = animation ? MODES.filter(m => m.value !== 'difference') : MODES;
  const mode = comparing ? (modes.some(m => m.value === stored_mode) ? stored_mode : 'side-by-side') : 'no-reference';
  const [diff_setting, setDiff] = usePreference('diff', DEFAULT_DIFF);
  const diff = normalizeDiff(diff_setting);
  const diff_layout = diff_setting?.layout === 'alone' ? 'alone' : 'between';
  const toggleDiffLayout = () => setDiff({ ...diff, layout: diff_layout === 'alone' ? 'between' : 'alone' });
  const [adjustments_setting, setAdjustments] = useState(undefined);
  const adjustments = normalizeAdjustments(adjustments_setting);
  const [values_setting, setValuesSetting] = usePreference('values', 'decoded');
  const values_source = values_setting === 'off' ? 'off' : (values_setting === 'display' || !getPixels) ? 'display' : 'decoded';
  const last_values = useRef('decoded');
  const [values_drawn, setValuesDrawn] = useState(null);
  const [tiles] = useState(() => new PixelTiles());
  useLayoutEffect(() => tiles.setGetPixels(getPixels));
  useEffect(() => () => tiles.dispose(), [tiles]);
  const [swapped, setSwapped] = useState(false);
  const [blind, setBlind] = useState(null);
  const hidden = !!blind && !blind.revealed;
  const names = !blind ? labels
    : blind.revealed ? { new: `${labels.new} · ${blind.a}`, reference: `${labels.reference} · ${other_letter(blind.a)}` }
    : { new: blind.a, reference: other_letter(blind.a) };
  const nextBlindStep = () => {
    if (!blind) {
      const coin = Math.random() < 0.5;
      setSwapped(coin);
      setBlind({ a: coin ? 'B' : 'A', revealed: false });
    } else if (!blind.revealed) setBlind({ ...blind, revealed: true });
    else {
      setBlind(null);
      setSwapped(false);
    }
  };
  const [wipe, setWipe] = useState(0.5);
  const [view, setView] = useState(FIT);
  const [base, setBase] = useState(10);
  const [show_histogram, setShowHistogram] = useState(false);
  // The channels the histogram shows, and the range of values it highlights on the videos (with the channels shown)
  const [histogram_channels, setHistogramChannels] = useState(ALL_CHANNELS);
  const [highlight_range, setHighlightRange] = useState(null);
  const highlight = show_histogram && !animation && highlight_range ? { ...highlight_range, channels: histogram_channels } : null;
  const [diff_error, setDiffError] = useState(null);
  const [message, setMessage] = useState(null);
  // where the pointer is: { x, y, pane } in pane coordinates
  const [pointer, setPointer] = useState(null);
  const [gesture_kind, setGestureKind] = useState(null);
  const diff_canvas = useRef(null);

  // Layout: as wide as we can, as high as the window allows
  const root = useRef(null);
  const header = useRef(null);
  const [available, setAvailable] = useState(0);
  const [header_height, setHeaderHeight] = useState(0);
  const [window_height, setWindowHeight] = useState(() => window.innerHeight);
  useLayoutEffect(() => {
    const element = header.current;
    const measure = () => {
      setAvailable(element.clientWidth);
      setHeaderHeight(element.offsetHeight);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const onResize = () => setWindowHeight(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setFullscreen(!!root.current && document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const can_fullscreen = typeof document !== 'undefined' && !!document.fullscreenEnabled;

  // the zoom, pan and layout follow the new video, or the reference's if the new one can't play
  const main = sizes.new ?? sizes.reference;
  const aspect = main ? main.width / main.height : 16 / 9;
  const side_by_side = mode === 'side-by-side';
  const diff_between = mode === 'difference' && diff_layout === 'between';
  const columns = side_by_side ? 2 : diff_between ? 3 : 1;
  // the transport fits in the window too
  const max_height = Math.max(160, fullscreen
    ? window_height - header_height - 90
    : typeof maxHeight === 'function' ? maxHeight(window_height) : maxHeight);
  const pane_width = Math.floor(Math.max(0, Math.min((available - (columns - 1) * GAP) / columns, max_height * aspect)));
  const pane = { width: pane_width, height: Math.floor(pane_width / aspect) };
  const stage_width = columns * pane.width + (columns - 1) * GAP;
  const current_view = clampView(view, pane, main);
  const limits = zoomLimits(pane, main);
  const zoom_percent = Math.round(100 * current_view.zoom / limits.native);

  const first = swapped ? 'reference' : 'new';
  const second = swapped ? 'new' : 'reference';
  const order = [first, second];
  const swap = () => setSwapped(s => !s);
  // The toggle, like the image viewer's: both videos show, they swap sides; one shows, or their difference alone:
  // the first, the other, their difference, and again
  const single = mode === 'single' || (mode === 'difference' && diff_layout === 'alone');
  const lead = blind?.a === 'B' ? 'reference' : 'new';
  const flip = () => {
    if (!single || (mode === 'single' && first === lead)) return swap();
    if (mode === 'single') {
      swap();
      setDiff({ ...diff, layout: 'alone' });
      setMode('difference');
      return;
    }
    if (first !== lead) swap();
    setMode('single');
  };
  const flip_title = !single ? `Swap the sides: ${names[second]} | ${names[first]}`
    : mode === 'single' && first === lead ? `Show the ${names[lead === 'new' ? 'reference' : 'new']} video`
    : mode === 'single' ? `Show the difference: ${names[lead]} − ${names[lead === 'new' ? 'reference' : 'new']}`
    : `Show the ${names[lead]} video`;
  const pickMode = value => {
    if (value === mode && value === 'single') swap();
    else if (value === mode && value === 'difference') toggleDiffLayout();
    else setMode(value);
    // the keys go to the videos, not to the buttons (arrows would change the mode)
    stage.current?.focus({ preventScroll: true });
  };

  // What each pane shows: 'new', 'reference' or 'diff', from the left
  const contents = side_by_side ? order
    : diff_between ? [first, 'diff', second]
    : mode === 'difference' ? ['diff']
    : mode === 'wipe' ? [first, second]
    : [first];

  // what event handlers need
  const layout = useRef({});
  useLayoutEffect(() => {
    layout.current = { pane, main, view: current_view, mode, wipe, columns, comparing, limits, modes };
  });

  // where a mouse event is, in pane coordinates
  const stage = useRef(null);
  const local = event => {
    const rect = stage.current.getBoundingClientRect();
    const { pane, columns } = layout.current;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const index = clamp(Math.floor(x / (pane.width + GAP)), 0, columns - 1);
    return { x: x - index * (pane.width + GAP), y, pane: index };
  };

  // Only viewers near the screen compute their difference
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '200px 0px' });
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);

  // Gestures: click to play/pause, drag to pan (or move the wipe), pinch to zoom
  const gesture = useRef(null);
  const pointers = useRef(new Map());
  const startGesture = next => {
    gesture.current = next;
    setGestureKind(next?.kind ?? null);
  };
  const onPointerDown = event => {
    // links in error messages, the minimap...
    if (event.button !== 0 || event.target.closest('a, button, .video-message, .qiv-minimap')) return;
    stage.current.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const { view, mode, wipe, pane } = layout.current;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      startGesture({ kind: 'pinch', distance: Math.hypot(a.x - b.x, a.y - b.y), view });
      return;
    }
    const point = local(event);
    if (mode === 'wipe' && Math.abs(point.x - wipe * pane.width) < WIPE_GRAB) {
      startGesture({ kind: 'wipe' });
      return;
    }
    startGesture({ kind: 'press', x: event.clientX, y: event.clientY, view });
  };
  const onPointerMove = event => {
    const point = local(event);
    setPointer(point);
    const g = gesture.current;
    if (!g) return;
    const { pane, main, mode, limits } = layout.current;
    if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (g.kind === 'pinch') {
      const [a, b] = [...pointers.current.values()];
      if (!b) return;
      const center = local({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
      setView(zoomAt(g.view, Math.hypot(a.x - b.x, a.y - b.y) / g.distance, center, pane, main));
      return;
    }
    if (g.kind === 'press') {
      if (Math.hypot(event.clientX - g.x, event.clientY - g.y) < CLICK_SLOP) return;
      const zoomed = g.view.zoom > Math.max(1, limits.min) + 1e-3;
      startGesture({ ...g, kind: zoomed ? 'pan' : mode === 'wipe' ? 'wipe' : 'none' });
    }
    if (gesture.current.kind === 'pan') setView(panBy(g.view, event.clientX - g.x, event.clientY - g.y, pane, main));
    if (gesture.current.kind === 'wipe') setWipe(clamp(point.x / pane.width, 0, 1));
  };
  const onPointerUp = event => {
    pointers.current.delete(event.pointerId);
    if (gesture.current?.kind === 'press' && !animation) controller.toggle();
    startGesture(pointers.current.size > 0 && gesture.current?.kind === 'pinch' ? { kind: 'none' } : null);
  };
  const onPointerCancel = event => {
    pointers.current.delete(event.pointerId);
    startGesture(null);
  };

  // The wheel zooms. React's onWheel is passive: it can't stop the page from scrolling
  useEffect(() => {
    const element = stage.current;
    const onWheel = event => {
      if (event.target.closest('.qiv-minimap')) return;
      event.preventDefault();
      const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      // trackpad pinches are wheel events with ctrlKey, and small deltas
      const factor = Math.exp(-event.deltaY * lines * (event.ctrlKey ? 0.01 : 0.002));
      const { pane, main } = layout.current;
      const point = local(event);
      // many wheel events can come before we render again
      setView(view => zoomAt(view, factor, point, pane, main));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);
  const zoomBy = factor => {
    const { pane, main } = layout.current;
    setView(view => zoomTo(view, view.zoom * factor, pane, main));
  };
  const actualSize = () => {
    const { pane, main, limits } = layout.current;
    setView(view => zoomTo(view, limits.native, pane, main));
  };

  // Regions of interest: the set shown, and its region. Picking a region shows it: zoomed on, at its frame.
  const [selected_set, setSelectedSet] = useState(() => regionSets.some(set => set.id === 'presets') ? 'presets' : null);
  const [region_index, setRegionIndex] = useState(0);
  const snapshot_frame = useFrameIndex(controller);
  const active_set = selected_set ? regionSets.find(set => set.id === selected_set) ?? null : null;
  const set_regions = active_set?.perFrame ? active_set.regionsAt?.(snapshot_frame) ?? null : active_set?.regions ?? null;
  const index = Math.min(region_index, Math.max(0, (set_regions?.length ?? 1) - 1));
  const active_region = set_regions?.[index] ?? null;
  const showRegion = region => {
    if (!region || !main) return;
    const { pane } = layout.current;
    setView(fitRegion(scaleRegion(region, main), pane, main));
    if (Number.isInteger(region.frame)) controller.seekFrame(region.frame);
  };
  useEffect(() => {
    if (active_set && !active_set.regions && !active_set.loading && !active_set.error) active_set.load?.();
  }, [active_set]);
  const selectSet = id => {
    setSelectedSet(id);
    setRegionIndex(0);
    if (!id) setView(FIT);
    const set = regionSets.find(s => s.id === id);
    const regions = set?.perFrame ? set.regionsAt?.(snapshot_frame) : set?.regions;
    if (regions?.[0]) showRegion(regions[0]);
  };
  const selectRegion = next => {
    setRegionIndex(next);
    showRegion(set_regions?.[next]);
  };
  const stepRegion = step => {
    const count = set_regions?.length ?? 0;
    if (count > 0) selectRegion((index + step + count) % count);
  };

  // The frames where the videos differ most: n and N go from one to the next
  const peaks = differencePeaks(differences?.frames);
  const stepDifference = step => {
    if (!peaks.length) return false;
    const current = controller.frameAt(controller.time) ?? 0;
    const next = step > 0 ? peaks.find(i => i > current) ?? peaks[0] : [...peaks].reverse().find(i => i < current) ?? peaks[peaks.length - 1];
    controller.seekFrame(next);
    return true;
  };

  const notify = text => {
    setMessage(text);
    setTimeout(() => setMessage(m => m === text ? null : m), 2500);
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement === root.current) document.exitFullscreen?.();
    else root.current?.requestFullscreen?.().catch(error => notify(`Can't go full screen: ${error.message}`));
  };
  const setValues = value => {
    if (value !== 'off') last_values.current = value;
    setValuesSetting(value);
  };
  const toggleValues = () => setValues(values_setting === 'off' ? last_values.current : 'off');

  // Keyboard shortcuts
  const onKey = useRef(null);
  useLayoutEffect(() => {
    onKey.current = event => {
      const { key, shiftKey } = event;
      switch (key) {
        case ' ':
        case 'k':
          controller.toggle();
          return true;
        case 'ArrowLeft':
        case ',':
          if (shiftKey) controller.seek(controller.time - 1);
          else controller.stepFrames(-1);
          return true;
        case 'ArrowRight':
        case '.':
          if (shiftKey) controller.seek(controller.time + 1);
          else controller.stepFrames(1);
          return true;
        case 'Home':
          controller.seek(0);
          return true;
        case 'End':
          controller.seek(Infinity);
          return true;
        case '<':
        case '>': {
          const i = RATES.indexOf(controller.rate);
          const next = i === -1 ? RATES.indexOf(1) : clamp(i + (key === '<' ? -1 : 1), 0, RATES.length - 1);
          controller.setRate(RATES[next]);
          return true;
        }
        case '+':
        case '=':
          zoomBy(ZOOM_STEP);
          return true;
        case '-':
          zoomBy(1 / ZOOM_STEP);
          return true;
        case '0':
          setView(FIT);
          return true;
        case 'm':
          controller.setMuted(!controller.muted);
          return true;
        case 'p':
          toggleValues();
          return true;
        case 'f':
          if (!can_fullscreen) return false;
          toggleFullscreen();
          return true;
        case 'h':
          if (!comparing) return false;
          nextBlindStep();
          return true;
        case 't':
          if (!comparing) return false;
          flip();
          return true;
        case '[':
        case ']':
          if (!set_regions?.length) return false;
          stepRegion(key === '[' ? -1 : 1);
          return true;
        case 'n':
        case 'N':
          return stepDifference(key === 'n' ? 1 : -1);
        case '1':
        case '2':
        case '3':
        case '4': {
          if (!comparing || !modes[Number(key) - 1]) return false;
          pickMode(modes[Number(key) - 1].value);
          return true;
        }
        default:
          return false;
      }
    };
  });
  useEffect(() => {
    let handled_space = false;
    const onKeyDown = event => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const element = root.current;
      const target = event.target;
      if (target instanceof Element && target.closest('input:not([type="range"]):not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"]')) return;
      const focus = document.activeElement;
      const active = document.fullscreenElement === element
        || (!document.fullscreenElement && (element.contains(focus) || (hovered_viewer === element && (!focus || focus === document.body))));
      if (!active || !onKey.current(event)) return;
      // it also stops the image viewers from handling the key (they listen on window, after document)
      event.preventDefault();
      handled_space = event.key === ' ';
    };
    // else a focused button would be clicked too
    const onKeyUp = event => {
      if (event.key !== ' ' || !handled_space) return;
      event.preventDefault();
      handled_space = false;
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    const element = root.current;
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      if (hovered_viewer === element) hovered_viewer = null;
    };
  }, []);

  // Display adjustments: an SVG filter on the videos. The values, the difference and the histograms aren't adjusted.
  const filter_id = `video-filter-${useId().replace(/:/g, '')}`;
  const primitives = filterPrimitives(adjustments);
  const filter = primitives.length > 0 ? `url(#${filter_id})` : undefined;
  const adjusted = changedAdjustments(adjustments).length > 0;

  // Copy and save
  const elements = { new: video_new, reference: video_ref };
  const copy = (source, what) => copyFrame(source).then(() => notify(`Copied the ${what}`), error => notify(`Can't copy the ${what}: ${error.message}`));
  const save = (source, label) => {
    const frame = controller.getSnapshot().frame;
    saveFrame(source, `${basename(video.href ?? video.url)}.${label}${frame !== null ? `.frame${frame}` : ''}.png`)
      .catch(error => notify(`Can't save the frame: ${error.message}`));
  };
  const export_menu = ({ close }) => <div className="qiv-menu" role="menu">
    <MenuItem icon="duplicate" text={`Copy the ${names.new} frame`} disabled={!video_new} onClick={() => { copy(video_new, `${names.new} frame`); close(); }} />
    {comparing && <MenuItem icon="duplicate" text={`Copy the ${names.reference} frame`} disabled={!video_ref} onClick={() => { copy(video_ref, `${names.reference} frame`); close(); }} />}
    {mode === 'difference' && <MenuItem icon="duplicate" text="Copy the difference" onClick={() => { copy(diff_canvas.current, 'difference'); close(); }} />}
    <MenuDivider />
    <MenuItem icon="download" text={`Save the ${names.new} frame (PNG)`} disabled={!video_new} onClick={() => { save(video_new, hidden ? names.new : 'new'); close(); }} />
    {comparing && <MenuItem icon="download" text={`Save the ${names.reference} frame (PNG)`} disabled={!video_ref} onClick={() => { save(video_ref, hidden ? names.reference : 'reference'); close(); }} />}
    {mode === 'difference' && <MenuItem icon="download" text="Save the difference (PNG)" onClick={() => { save(diff_canvas.current, 'difference'); close(); }} />}
    {/* their URLs would tell which is which during a blind test */}
    {!hidden && <MenuDivider />}
    {!hidden && <MenuItem icon="video" text={`Open the ${names.new} video`} href={video.href ?? video.url} onClick={close} />}
    {!hidden && comparing && <MenuItem icon="video" text={`Open the ${names.reference} video`} href={reference.href ?? reference.url} onClick={close} />}
    <div className="qiv-hint">Frames are copied as decoded by your browser: 8-bit RGB, without the adjustments.</div>
  </div>;
  const copyRegion = () => {
    if (!main) return;
    const t = transformOf(current_view, pane, main);
    const sx = main.width / (t.width * t.scale);
    const sy = main.height / (t.height * t.scale);
    const x = Math.max(0, -t.x * sx);
    const y = Math.max(0, -t.y * sy);
    const region = { x, y, w: Math.min(main.width - x, pane.width * sx), h: Math.min(main.height - y, pane.height * sy) };
    navigator.clipboard?.writeText(regionAsYaml(region, main)).then(() => notify('Copied the region in view'), error => notify(`Can't copy: ${error.message}`));
  };

  // The histograms of the frames shown, by the image viewer's: a, the first, b, the second
  const shown_elements = useRef({});
  useLayoutEffect(() => {
    shown_elements.current = { a: elements[first], b: elements[second] };
  });
  const [histogram_source] = useState(() => {
    const canvases = { a: document.createElement('canvas'), b: document.createElement('canvas') };
    return {
      onDraw: listener => controller.onFrames(listener),
      canvas: name => frameCanvas(shown_elements.current[name], 480, canvases[name]) ?? { width: 0, height: 0 },
    };
  });

  // The pixel under the pointer, in [0, 1] of the frames
  const point = pointer && main && !gesture_kind ? (() => {
    const { u, v } = videoPointAt(pointer, current_view, pane, main);
    return u >= 0 && u < 1 && v >= 0 && v < 1 ? { u, v } : null;
  })() : null;
  const playback = usePlayback(controller);
  // The frames whose decoded values we read: the very frames shown, once paused
  const decodedFrame = (which, presented) => {
    const source = which === 'new' ? video : reference;
    if (!getPixels || !source || !presented?.exact) return null;
    return { ...source, url: `${source.url}#frame=${presented.index}`, frame: presented.index };
  };
  const frames = {
    new: decodedFrame('new', playback.presented),
    reference: comparing ? decodedFrame('reference', playback.presentedReference) : null,
  };
  const why_not_decoded = !getPixels ? null
    : playback.playing ? 'pause for decoded values'
    : !video.info?.times ? (infoLoading ? 'reading the file…' : 'decoded values unavailable')
    : null;
  const frameType = index => {
    const type = differences?.frames?.[index]?.type;
    if (type) return type;
    return video.info?.keyframes?.includes(index) ? 'I' : null;
  };

  // Where each video shows: its pane, or hidden under the others (it still plays: the difference reads it)
  const slotStyle = which => {
    const base_style = { width: pane.width, height: pane.height, left: 0 };
    const position = contents.indexOf(which);
    if (mode === 'wipe' && which === second) return { ...base_style, clipPath: `inset(0 0 0 ${wipe * pane.width}px)`, zIndex: 1 };
    if (mode === 'wipe') return base_style;
    if (position === -1) return { ...base_style, opacity: 0 };
    return { ...base_style, left: position * (pane.width + GAP) };
  };
  const contentStyle = media => {
    const t = transformOf(current_view, pane, media);
    // CSS pixels per video pixel: zoomed in, we want to see the actual pixels
    const magnification = media?.width ? t.width * t.scale / media.width : 1;
    return {
      width: t.width,
      height: t.height,
      transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`,
      imageRendering: magnification >= 2 ? 'pixelated' : undefined,
    };
  };
  const label = (which, position) => {
    if (!comparing) return null;
    const size = sizes[which];
    return <button
      key={`label-${which}-${position}`}
      type="button"
      className={`qiv-label qiv-label-${position} ${hidden ? 'qiv-neutral' : which === 'new' ? 'qiv-primary' : 'qiv-warning'}`}
      title={`${flip_title} (t). ${hidden ? 'Blind test: which is new? Reveal with h' : 'Blind test: h'}`}
      onClick={flip}
      onPointerDown={event => event.stopPropagation()}
    >
      {names[which]}{size && <span className="qiv-label-detail">{size.width}×{size.height}</span>}
      {which === 'reference' && sizes.new?.duration && size?.duration && Math.abs(sizes.new.duration - size.duration) >= 0.05 && <span className="qiv-label-detail">
        {size.duration < sizes.new.duration ? 'shorter' : 'longer'}: {size.duration.toFixed(2)}s
      </span>}
    </button>;
  };

  const region_for = which => {
    if (!active_region || !sizes[which]) return null;
    return { ...scaleRegion(active_region, sizes[which]), label: active_region.label, color: active_region.color };
  };
  const pixelValues = (content, position) => <PixelValues
    key={`values-${content}`}
    controller={controller}
    tiles={tiles}
    content={content}
    videos={elements}
    frames={frames}
    order={order}
    view={current_view}
    pane={pane}
    source={visible ? values_source : 'off'}
    base={base}
    playing={playback.playing}
    onDrawn={position === 0 ? setValuesDrawn : undefined}
  />;

  const slot = (which, src, setElement, media, video_poster) => <div key={which} className="video-slot" style={slotStyle(which)}>
    <div className="video-content" style={{ ...contentStyle(media), filter }}>
      {animation ? <img ref={setElement} key={src} src={src} alt={which === 'new' ? 'New' : 'Reference'} />
        : <video
          ref={setElement}
          key={src}
          src={src}
          poster={video_poster}
          preload="metadata"
          crossOrigin={video.crossOrigin}
          muted
          playsInline
          disableRemotePlayback
          aria-label={which === 'new' ? 'New video' : 'Reference video'}
        />}
    </div>
    {visible && (mode === 'wipe' || contents.includes(which)) && <HighlightLayer
      controller={controller}
      video={elements[which]}
      highlight={highlight}
      view={current_view}
      pane={pane}
      media={media}
    />}
    {contents.includes(which) && !animation && pixelValues(which, contents.indexOf(which))}
    {contents.includes(which) && <RegionOutline region={region_for(which)} view={current_view} pane={pane} media={media} />}
    {(side_by_side || diff_between) && label(which, 'left')}
    {media?.error && <VideoError error={media.error} src={which === 'new' ? video.href ?? video.url : reference.href ?? reference.url} name={comparing ? names[which] : null} />}
  </div>;

  // a cross where the pointer is, on the other panes
  const crosshairs = columns > 1 && point && contents.map((_, i) => {
    if (i === pointer.pane) return null;
    return <svg key={`cross-${i}`} className="qiv-crosshair" style={{ left: i * (pane.width + GAP) + pointer.x, top: pointer.y }} width="25" height="25" viewBox="0 0 25 25" aria-hidden="true">
      <path d={CROSS} stroke="rgba(0, 0, 0, 0.75)" strokeWidth="3" />
      <path d={CROSS} stroke="#fff" strokeWidth="1" />
    </svg>;
  });

  const can_pan = current_view.zoom > Math.max(1, limits.min) + 1e-3;
  const stage_class = ['qiv-stage', 'video-stage', can_pan && 'can-pan', gesture_kind === 'pan' && 'panning', gesture_kind === 'wipe' && 'wiping']
    .filter(Boolean).join(' ');
  const diff_position = diff_between ? pane.width + GAP : 0;
  const timeline = (differences?.frames || video.info?.keyframes) ? {
    frames: differences?.frames,
    keyframes: video.info?.keyframes?.map(i => video.info.times?.[i]).filter(Number.isFinite),
    describe: i => describeFrame(differences?.frames?.[i], frameType(i)),
  } : null;
  const infos = {
    new: { ...video.info, size: video.size },
    reference: reference ? { ...reference.info, size: reference.size } : null,
  };
  const loading = !animation && !!video_new && !sizes.new && !info_new?.error;

  return <div
    ref={root}
    className={`qiv video-viewer ${fullscreen ? 'qiv-fullscreen' : ''} ${className}`}
    style={style}
    onPointerEnter={() => { hovered_viewer = root.current; }}
    onPointerLeave={() => {
      if (hovered_viewer === root.current) hovered_viewer = null;
      setPointer(null);
    }}
  >
    <svg className="qiv-filters" aria-hidden="true" width="0" height="0">
      <filter id={filter_id} colorInterpolationFilters="sRGB">
        {primitives.map((primitive, i) => <FilterPrimitive key={i} primitive={primitive} />)}
      </filter>
    </svg>
    <div className="qiv-header" ref={header}>
      <div className="qiv-toolbar video-toolbar">
        {comparing && <Segmented label="Comparison" options={modes} value={mode} onChange={pickMode} />}
        {mode === 'difference' && <Button
          icon="three-columns"
          title={diff_between ? 'Show the difference alone (4)' : `Show the videos on each side of the difference: ${names[first]} | difference | ${names[second]} (4)`}
          active={diff_between}
          aria-pressed={diff_between}
          onClick={toggleDiffLayout}
        />}
        {comparing && <Button icon="exchange" title={`${flip_title} (t)`} label="Swap" onClick={flip} active={swapped && !hidden} aria-pressed={swapped && !hidden} />}
        {comparing && <Button
          icon={!blind ? 'eye-off' : blind.revealed ? 'tick' : 'eye-open'}
          text={!blind ? 'Blind test' : blind.revealed ? 'Done' : 'Reveal'}
          title={!blind ? 'Blind test: the videos in a random order, called A and B (h)'
            : blind.revealed ? 'End the blind test: new and reference again, new first (h)'
            : 'Blind test: reveal which video is which (h)'}
          className={blind ? 'qiv-intent' : ''}
          active={!!blind}
          aria-pressed={!!blind}
          onClick={nextBlindStep}
        />}
        {mode === 'difference' && <DiffSettings diff={diff} onChange={value => setDiff({ ...value, layout: diff_layout })} />}
        {same && <span className="qiv-chip video-same" title="Both runs created exactly the same file"><Icon icon="duplicate" size={12} /> same video as the reference</span>}
        {notice}
        <span className="qiv-spacer" />
        <span className="qiv-tools">
          {message && <output className="qiv-toast">{message}</output>}
          {loading && <Spinner label="Loading the videos" />}
          {comparing && sizes.new && sizes.reference && Math.abs(sizes.new.width / sizes.new.height - sizes.reference.width / sizes.reference.height) > 1e-3 && <span className="qiv-warning-text" title="The videos are compared at the same width: their bottoms don't match.">
            <Icon icon="warning-sign" size={12} /> different aspect ratios
          </span>}
          {!animation && <Popover align="end" button={props => <Button
            {...props}
            icon="properties"
            label="What's in the files"
            title="What's in the files: codec, pixel format, color range, frame rate… and what your browser does with them"
            className={infoError ? 'qiv-warning' : ''}
          />}>
            <InfoPanel infos={infos} names={names} comparing={comparing && !hidden} loading={infoLoading} error={infoError} elements={elements} />
          </Popover>}
          {regionSets.length > 0 && !animation && <Popover align="end" button={props => <Button
            {...props}
            icon="detection"
            text={active_set ? active_set.label : undefined}
            label="Regions of interest"
            title="Regions of interest, and where the videos differ"
            className={active_set ? 'qiv-intent' : ''}
          />}>
            {({ close }) => <RegionsMenu sets={regionSets} selected={active_set?.id ?? null} onSelect={selectSet} onCopy={copyRegion} close={close} />}
          </Popover>}
          {!animation && <Popover align="end" button={props => <Button {...props} icon="flash" title="Adjust the display: brightness, contrast, gamma, channels…" className={adjusted ? 'qiv-intent qiv-dot' : ''} />}>
            <AdjustmentsPanel adjustments={adjustments} onChange={setAdjustments} />
          </Popover>}
          {!animation && <Popover align="end" button={props => <Button
            {...props}
            icon="numerical"
            label="Pixel values"
            title={`Values written on the pixels when zoomed in, paused: ${values_source === 'decoded' ? 'decoded' : values_source === 'display' ? 'displayed' : 'off'} (p)`}
            className={values_source !== 'off' ? 'qiv-intent' : ''}
          />}>
            <ValuesPanel source={values_source} available={!!getPixels} unavailable={decodedUnavailable} onChange={setValues} />
          </Popover>}
          {!animation && <Button icon="timeline-area-chart" title="Histogram of the frames" active={show_histogram} aria-pressed={show_histogram} onClick={() => setShowHistogram(!show_histogram)} />}
          <span className="qiv-group">
            <Button icon="zoom-out" label="Zoom out" title="Zoom out (−)" onClick={() => zoomBy(1 / ZOOM_STEP)} />
            <Button className="qiv-zoom video-zoom" text={`${zoom_percent}%`} title="Fit (0). Scroll or pinch to zoom, drag to pan. 100%: one video pixel per screen pixel" onClick={() => setView(FIT)} />
            <Button icon="zoom-in" label="Zoom in" title="Zoom in (+)" onClick={() => zoomBy(ZOOM_STEP)} />
            <Button text="1:1" title="Actual pixels: one video pixel per screen pixel" onClick={actualSize} />
          </span>
          {!animation && <Popover align="end" button={props => <Button {...props} icon="camera" label="Frames" title="Copy or save the frames" />}>
            {export_menu}
          </Popover>}
          <Popover align="end" button={props => <Button {...props} icon="key-command" label="Keyboard shortcuts" title="Keyboard shortcuts" />}>
            <Shortcuts />
          </Popover>
          {can_fullscreen && <Button
            icon={fullscreen ? 'minimize' : 'fullscreen'}
            label={fullscreen ? 'Exit full screen' : 'Full screen'}
            title={fullscreen ? 'Exit full screen (f or Esc)' : 'Full screen (f)'}
            onClick={toggleFullscreen}
          />}
        </span>
      </div>
      {active_set && <RegionsStrip
        set={{ ...active_set, regions: set_regions ?? undefined, empty: active_set.perFrame && active_set.regions ? 'No difference in this frame' : active_set.empty }}
        index={index}
        image={null}
        size={main}
        onSelect={selectRegion}
        onRetry={() => active_set.load?.()}
      />}
      {!animation && <Readout
        controller={controller}
        point={point}
        videos={elements}
        sizes={sizes}
        frames={frames}
        why={why_not_decoded}
        unavailable={getPixels ? null : decodedUnavailable}
        order={order}
        comparing={comparing}
        names={names}
        neutral={hidden}
        diff={diff}
        base={base}
        onToggleBase={() => setBase(b => b === 10 ? 16 : 10)}
        tiles={tiles}
      />}
    </div>
    <div
      ref={stage}
      className={stage_class}
      style={{ width: stage_width, height: pane.height }}
      tabIndex={0}
      role="application"
      aria-label="Videos: click to play or pause, scroll to zoom, drag to pan"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={event => gesture.current && event.preventDefault()}
    >
      {slot('new', video.url, setElementNew, info_new, poster)}
      {comparing && slot('reference', reference.url, setElementRef, info_ref, posterReference)}
      {mode === 'difference' && video_new && video_ref && <div className="video-slot video-diff-slot" style={{ width: pane.width, height: pane.height, left: diff_position, zIndex: 2 }}>
        <div className="video-content" style={contentStyle(main)}>
          {visible && <DiffLayer
            first={elements[first]}
            second={elements[second]}
            diff={diff}
            controller={controller}
            canvasRef={diff_canvas}
            onError={setDiffError}
          />}
        </div>
        {pixelValues('diff', contents.indexOf('diff'))}
        <RegionOutline region={region_for('new')} view={current_view} pane={pane} media={main} />
        {diff_between && <span className="qiv-label qiv-label-left qiv-label-diff" title={`${names[first]} − ${names[second]}`}>difference</span>}
        {diff_between && <div className="qiv-stage-notes"><DiffLegend diff={diff} names={[names[first], names[second]]} /></div>}
        {diff_error && <div className="qiv-message qiv-pane-message">{diff_error}</div>}
      </div>}
      {mode === 'wipe' && <>
        {label(first, 'left')}
        {label(second, 'right')}
        <div className="video-wipe" style={{ left: wipe * pane.width }}>
          <div className="video-wipe-handle"><Icon icon="arrows-horizontal" size={14} /></div>
        </div>
      </>}
      {mode === 'single' && label(first, 'left')}
      <div className="qiv-stage-notes">
        {mode === 'difference' && !diff_between && <DiffLegend diff={diff} names={[names[first], names[second]]} />}
        <ValuesBadge drawn={values_source !== 'off' ? values_drawn : null} />
        {!animation && <FrameBadge controller={controller} comparing={comparing} names={names} frameType={frameType} />}
      </div>
      {crosshairs}
      {!animation && <StageOverlay controller={controller} />}
      {!animation && main && <Minimap
        controller={controller}
        video={elements[first] ?? video_new}
        view={current_view}
        pane={pane}
        media={main}
        onPan={(u, v) => setView(view => clampView({ ...view, cx: u, cy: v }, pane, main))}
      />}
    </div>
    {!animation && <Transport controller={controller} timeline={timeline}>
      {differences && !differences.frames && <Button
        icon="timeline-bar-chart"
        text={differences.loading ? 'Comparing…' : 'Differences'}
        title={differences.error ?? 'Compare the decoded frames of the videos on the server: how much they differ, frame by frame, and where'}
        className={differences.error ? 'qiv-warning' : ''}
        disabled={differences.loading || !differences.load}
        onClick={() => differences.load?.()}
      />}
      {differences?.frames && <span className="video-difference-summary qiv-muted" title={differences.summaryTitle}>{differences.summary}</span>}
    </Transport>}
    {show_histogram && !animation && <Histogram
      controller={histogram_source}
      comparing={comparing}
      names={{ a: names[first], b: names[second] }}
      channels={histogram_channels}
      onChannelsChange={setHistogramChannels}
      range={highlight_range}
      onRangeChange={setHighlightRange}
    />}
  </div>;
};

const CROSS = 'M12.5 0v9M12.5 16v9M0 12.5h9M16 12.5h9';

// What the videos show, updated when it changes (not when their time does)
const usePlayback = controller => {
  const key = useSyncExternalStore(controller.subscribe, () => {
    const s = controller.getSnapshot();
    return JSON.stringify([s.playing, s.presented, s.presentedReference]);
  });
  const [playing, presented, presentedReference] = JSON.parse(key);
  return { playing, presented, presentedReference };
};

// The frame shown, updated when it changes
const useFrameIndex = controller => {
  const [frame, setFrame] = useState(null);
  useEffect(() => {
    const update = () => {
      const s = controller.getSnapshot();
      setFrame(s.presented?.index ?? s.frame);
    };
    update();
    return controller.subscribe(update);
  }, [controller]);
  return frame;
};

// The play hint until the videos play or move, a spinner while buffering,
// and how many frames the reference is off while it catches up (it shouldn't be visible)
const StageOverlay = memo(({ controller }) => {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const drift = s.drift !== null && s.frameDuration ? Math.round(s.drift / s.frameDuration) : 0;
  return <>
    {s.buffering && <div className="video-overlay-center"><Spinner size={36} label="Loading" /></div>}
    {!s.buffering && !s.played && s.ready && s.time < 1e-3 && <div className="video-overlay-center video-play-hint"><Icon icon="play" size={32} /></div>}
    {Math.abs(drift) >= 2 && <span className="video-drift" title="The reference is catching up with the new video">
      reference {drift > 0 ? '+' : ''}{drift} frames
    </span>}
  </>;
});

// The frames where the videos differ most: where the difference peaks above half of the largest
export const differencePeaks = frames => {
  if (!frames?.length) return [];
  const top = Math.max(...frames.map(f => f.value ?? 0));
  if (!(top > 0)) return [];
  const peaks = [];
  for (let i = 0; i < frames.length; i++) {
    const value = frames[i].value ?? 0;
    if (value < top / 2) continue;
    // the first of a run of frames above it
    if (i > 0 && (frames[i - 1].value ?? 0) >= top / 2) continue;
    peaks.push(i);
  }
  return peaks;
};

const describeFrame = (frame, type) => {
  if (!frame) return type ? `${type}-frame` : null;
  const parts = [];
  if (frame.max === 0) parts.push('identical');
  else {
    parts.push(`max Δ ${frame.max}`);
    if (frame.psnr !== null && frame.psnr !== undefined) parts.push(`PSNR ${frame.psnr.toFixed(1)} dB`);
    if (frame.changed !== null && frame.changed !== undefined) parts.push(`${(100 * frame.changed).toFixed(frame.changed < 0.01 ? 2 : 1)}% of pixels`);
  }
  const types = frame.type && frame.ref_type ? (frame.type === frame.ref_type ? `${frame.type}-frames` : `${frame.type} / ${frame.ref_type}-frames`) : type;
  if (types) parts.push(types);
  return parts.join(' · ');
};

export default VideoCompare;
