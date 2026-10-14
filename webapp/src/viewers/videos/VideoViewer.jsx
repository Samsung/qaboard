import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Button,
  ButtonGroup,
  Classes,
  HTMLSelect,
  Icon,
  Intent,
  Menu,
  MenuDivider,
  MenuItem,
  PopoverNext,
  SegmentedControl,
  Spinner,
  Tag,
} from '@blueprintjs/core';

import { useInView } from 'react-intersection-observer';

import { is_same_data } from '../../utils';
import { toaster } from '../../toaster';
import { SyncedPlayback } from './syncedPlayback';
import { FIT, clampView, panBy, transformOf, videoPointAt, zoomAt, zoomLimits, zoomTo } from './viewTransform';
import { Transport, RATES } from './Transport';
import { DiffLayer } from './DiffLayer';
import { copyFrame, fileUrl, mediaErrorMessage, saveFrame, usePreference } from './utils';
import './videos.css';

// Compares the video of a run with its reference's: they play in sync, frame by frame, side by side,
// with a wipe, toggled, or as their difference. Zoom (wheel, pinch) and pan (drag) apply to both.
// Animated images (.webp, .gif) are compared too, but the browser plays them on its own.

const MODES = [
  { value: 'side-by-side', label: 'Side by side', icon: 'split-columns' },
  { value: 'wipe', label: 'Wipe', icon: 'drag-handle-vertical' },
  { value: 'toggle', label: 'Toggle', icon: 'swap-horizontal' },
  { value: 'difference', label: 'Difference', icon: 'contrast' },
];
const GAINS = [1, 2, 4, 8, 16, 32, 64];
const GAP = 4;
const ZOOM_STEP = 1.5;
// a press that moves less is a click
const CLICK_SLOP = 4;
// grab the wipe's divider that close
const WIPE_GRAB = 14;

const SHORTCUTS = [
  ['Space', 'Play / pause (or click the video)'],
  ['← →', 'Previous / next frame'],
  ['Shift ← →', 'Back / forward 1 second'],
  ['Home End', 'First / last frame'],
  ['[ ]', 'Slower / faster'],
  ['Wheel, pinch', 'Zoom'],
  ['Drag', 'Pan (or move the wipe when not zoomed)'],
  ['+ − 0', 'Zoom in / out / fit'],
  ['1 2 3 4', 'Side by side / wipe / toggle / difference'],
  ['t', 'Swap new and reference'],
  ['h', 'Hide the labels'],
  ['m', 'Mute / unmute'],
];

const basename = path => path.split('/').pop().replace(/\.[^.]+$/, '');
const is_animated_image = path => /\.(webp|gif)$/i.test(path);

const clamp = (x, min, max) => Math.min(max, Math.max(min, x));

const Shortcuts = () => <table className={`${Classes.HTML_TABLE} ${Classes.COMPACT} video-shortcuts`}>
  <tbody>
    {SHORTCUTS.map(([keys, action]) => <tr key={keys}><td><kbd>{keys}</kbd></td><td>{action}</td></tr>)}
  </tbody>
</table>;

// The play hint until the videos play or move, a spinner while buffering,
// and how many frames the reference is off while it catches up (it shouldn't be visible)
const StageOverlay = memo(({ controller }) => {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const drift = s.drift !== null && s.frameDuration ? Math.round(s.drift / s.frameDuration) : 0;
  return <>
    {s.buffering && <div className="video-overlay-center"><Spinner size={36} aria-label="Loading" /></div>}
    {!s.buffering && !s.played && s.ready && s.time < 1e-3 && <div className="video-overlay-center video-play-hint"><Icon icon="play" size={32} /></div>}
    {Math.abs(drift) >= 2 && <span className="video-drift" title="The reference is catching up with the new video">
      reference {drift > 0 ? '+' : ''}{drift} frames
    </span>}
  </>;
});

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

const VideoError = ({ error, src }) => <div className="video-message">
  <strong>Can't play this video</strong>
  <span>{mediaErrorMessage(error)}</span>
  {(error.code === 3 || error.code === 4) && <span className="video-message-hint">
    Browsers play H.264, VP9 or AV1 videos (.mp4, .webm). To convert:{' '}
    <code>ffmpeg -i input -c:v libx264 -pix_fmt yuv420p -movflags +faststart output.mp4</code>
  </span>}
  <a href={src} target="_blank" rel="noopener noreferrer">Open the file</a>
</div>;


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
  const path_reference = path_ref ?? path;
  const src_new = fileUrl(output_new, path);
  const same_video = !!output_ref && is_same_data(path, manifests?.new?.[path], manifests?.reference?.[path_reference]);
  const src_ref = output_ref && !same_video ? fileUrl(output_ref, path_reference) : null;
  const comparing = !!src_ref;
  const animation = is_animated_image(path);
  const modes = animation ? MODES.filter(m => m.value !== 'difference') : MODES;
  const poster_new = manifests?.new?.[poster] ? fileUrl(output_new, poster) : undefined;
  const poster_ref = manifests?.reference?.[poster] && output_ref ? fileUrl(output_ref, poster) : undefined;

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
  const info_new = useMediaInfo(element_new);
  const info_ref = useMediaInfo(comparing ? element_ref : null);

  const [stored_mode, setMode] = usePreference('mode', 'side-by-side');
  const mode = comparing ? (modes.some(m => m.value === stored_mode) ? stored_mode : 'side-by-side') : 'single';
  const [gain, setGain] = usePreference('gain', 4);
  const [swapped, setSwapped] = useState(false);
  const [hide_labels, setHideLabels] = useState(false);
  const [wipe, setWipe] = useState(0.5);
  const [view, setView] = useState(FIT);
  const [diff_error, setDiffError] = useState(null);
  // where the pointer is, in pane coordinates
  const [pointer, setPointer] = useState(null);
  const [gesture_kind, setGestureKind] = useState(null);
  const diff_canvas = useRef(null);

  // Layout: as wide as we can, as high as the window allows
  const root = useRef(null);
  const [available, setAvailable] = useState(0);
  const [window_height, setWindowHeight] = useState(window.innerHeight);
  useLayoutEffect(() => {
    const element = root.current;
    const measure = () => setAvailable(element.clientWidth);
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

  // the zoom, pan and layout follow the new video, or the reference's if the new one can't play
  const main = info_new?.width ? info_new : info_ref?.width ? info_ref : null;
  const aspect = main ? main.width / main.height : 16 / 9;
  const side_by_side = mode === 'side-by-side';
  // the toolbar and the timeline fit in the window too, under the commit page's bars
  const max_height = Math.max(160, window_height - (fullscreen ? 130 : 300));
  const width_per_pane = Math.max(0, side_by_side ? (available - GAP) / 2 : available);
  const pane_width = Math.floor(Math.min(width_per_pane, max_height * aspect));
  const pane = { width: pane_width, height: Math.floor(pane_width / aspect) };
  const stage_width = side_by_side ? 2 * pane.width + GAP : pane.width;
  const current_view = clampView(view, pane, main);
  const limits = zoomLimits(pane, main);
  const zoom_percent = Math.round(100 * current_view.zoom / limits.native);

  // what event handlers need
  const layout = useRef({});
  useLayoutEffect(() => {
    layout.current = { pane, main, view: current_view, mode, wipe, side_by_side, comparing, limits, modes };
  });

  const first = swapped ? 'reference' : 'new';
  const swap = () => setSwapped(swapped => !swapped);

  // where a mouse event is, in pane coordinates
  const stage = useRef(null);
  // the difference is computed only near the screen
  const { ref: visible_ref, inView: visible } = useInView({ rootMargin: '200px 0px' });
  const stageRef = useCallback(node => {
    stage.current = node;
    visible_ref(node);
  }, [visible_ref]);
  const local = event => {
    const rect = stage.current.getBoundingClientRect();
    const { pane, side_by_side } = layout.current;
    let x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let index = 0;
    if (side_by_side && x > pane.width + GAP / 2) {
      index = 1;
      x -= pane.width + GAP;
    }
    return { x, y, index };
  };

  // Gestures: click to play/pause, drag to pan (or move the wipe), pinch to zoom
  const gesture = useRef(null);
  const pointers = useRef(new Map());
  const startGesture = gesture_ => {
    gesture.current = gesture_;
    setGestureKind(gesture_?.kind ?? null);
  };
  const onPointerDown = event => {
    // links in error messages...
    if (event.button !== 0 || event.target.closest('a, button, .video-message')) return;
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

  // Keyboard shortcuts, for the viewer that has the focus, or under the mouse
  const hovered = useRef(false);
  const onKey = useRef(null);
  const handleKey = event => {
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
      case '[':
      case ']': {
        const index = RATES.indexOf(controller.rate);
        const next = index === -1 ? RATES.indexOf(1) : clamp(index + (key === '[' ? -1 : 1), 0, RATES.length - 1);
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
      case 'h':
        setHideLabels(hide => !hide);
        return true;
      case 't':
        if (!layout.current.comparing) return false;
        swap();
        return true;
      case '1':
      case '2':
      case '3':
      case '4': {
        const { comparing, modes } = layout.current;
        if (!comparing || !modes[Number(key) - 1]) return false;
        setMode(modes[Number(key) - 1].value);
        return true;
      }
      default:
        return false;
    }
  };
  useLayoutEffect(() => {
    onKey.current = handleKey;
  });
  useEffect(() => {
    let handled_space = false;
    const onKeyDown = event => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const element = root.current;
      const target = event.target;
      if (target instanceof Element && target.closest('input:not([type="range"]), textarea, select, [contenteditable="true"]')) return;
      const focus = document.activeElement;
      const active = element.contains(focus) || (hovered.current && (!focus || focus === document.body));
      if (!active || !onKey.current(event)) return;
      // it also stops the image viewers from handling "t" (they listen to keypress)
      event.preventDefault();
      handled_space = event.key === ' ';
    };
    // else a focused button would be clicked too
    const onKeyUp = event => {
      if (event.key !== ' ' || !handled_space) return;
      event.preventDefault();
      handled_space = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const copy = (source, name) => copyFrame(source).then(
    () => toaster.show({ message: `Copied the ${name} to the clipboard`, intent: Intent.SUCCESS, icon: 'duplicate' }),
    error => toaster.show({ message: `Can't copy the ${name}: ${error.message}`, intent: Intent.DANGER }),
  );
  const save = (source, label) => {
    const { frame } = controller.getSnapshot();
    saveFrame(source, `${basename(path)}.${label}${frame !== null ? `.frame${frame}` : ''}.png`).catch(error =>
      toaster.show({ message: `Can't save the frame: ${error.message}`, intent: Intent.DANGER })
    );
  };
  const frames_menu = <Menu>
    <MenuItem icon="duplicate" text="Copy the new frame" disabled={!video_new} onClick={() => copy(video_new, 'new frame')} />
    {comparing && <MenuItem icon="duplicate" text="Copy the reference frame" disabled={!video_ref} onClick={() => copy(video_ref, 'reference frame')} />}
    {mode === 'difference' && <MenuItem icon="duplicate" text="Copy the difference" onClick={() => copy(diff_canvas.current, 'difference')} />}
    <MenuDivider />
    <MenuItem icon="media" text="Save the new frame (PNG)" disabled={!video_new} onClick={() => save(video_new, 'new')} />
    {comparing && <MenuItem icon="media" text="Save the reference frame (PNG)" disabled={!video_ref} onClick={() => save(video_ref, 'reference')} />}
    <MenuDivider />
    <MenuItem icon="video" text="Open the new video" href={src_new} target="_blank" rel="noopener noreferrer" />
    {comparing && <MenuItem icon="video" text="Open the reference video" href={src_ref} target="_blank" rel="noopener noreferrer" />}
  </Menu>;

  // where each video shows
  const slotStyle = which => {
    const is_first = which === first;
    const base = { width: pane.width, height: pane.height, left: 0 };
    if (side_by_side) return { ...base, left: is_first ? 0 : pane.width + GAP };
    if (mode === 'wipe' && !is_first) return { ...base, clipPath: `inset(0 0 0 ${wipe * pane.width}px)` };
    if ((mode === 'toggle' && !is_first) || mode === 'difference') return { ...base, opacity: 0 };
    return base;
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

  const resolution = media => media?.width ? <span className="video-label-detail">{media.width}×{media.height}</span> : null;
  const duration_note = () => {
    if (!info_new?.duration || !info_ref?.duration || Math.abs(info_new.duration - info_ref.duration) < 0.05) return null;
    return <span className="video-label-detail">{info_ref.duration < info_new.duration ? 'shorter' : 'longer'}: {info_ref.duration.toFixed(2)}s</span>;
  };
  const label = (which, position) => {
    if (!comparing || hide_labels) return null;
    const is_new = which === 'new';
    return <Tag
      key={`label-${which}`}
      className={`video-label ${position}`}
      intent={is_new ? Intent.PRIMARY : Intent.WARNING}
      interactive
      title="Swap new and reference (t). Hide the labels with h"
      onClick={swap}
      onPointerDown={event => event.stopPropagation()}
    >
      {is_new ? 'new' : 'reference'}{is_new ? resolution(info_new) : <>{resolution(info_ref)}{duration_note()}</>}
    </Tag>;
  };
  const second = first === 'new' ? 'reference' : 'new';
  const labels = !comparing ? null
    : side_by_side ? null  // in their slot
    : mode === 'wipe' ? <>{label(first, 'left')}{label(second, 'right')}</>
    : mode === 'toggle' ? label(first, 'left')
    : !hide_labels && <Tag className="video-label left" intent={Intent.NONE}>|new − reference| × {gain}</Tag>;

  const slot = (which, src, setElement, media, video_poster) => {
    const error = media?.error;
    return <div key={which} className="video-slot" style={slotStyle(which)}>
      <div className="video-content" style={contentStyle(media)}>
        {animation ? <img
          ref={setElement}
          key={src}
          src={src}
          alt={which === 'new' ? 'New' : 'Reference'}
        /> : <video
          ref={setElement}
          key={src}
          src={src}
          poster={video_poster}
          preload="metadata"
          muted
          playsInline
          disableRemotePlayback
          aria-label={which === 'new' ? 'New video' : 'Reference video'}
        />}
      </div>
      {side_by_side && label(which, 'left')}
      {error && <VideoError error={error} src={src} />}
    </div>;
  };

  // In side by side, a cross shows where the pointer is on the other video
  const crosshair = side_by_side && pointer && !gesture_kind
    && pointer.x >= 0 && pointer.x <= pane.width && pointer.y >= 0 && pointer.y <= pane.height
    && <div className="video-crosshair" style={{ left: (pointer.index === 0 ? pane.width + GAP : 0) + pointer.x, top: pointer.y }} />;
  const pixel = pointer && main && (() => {
    const { u, v } = videoPointAt(pointer, current_view, pane, main);
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return null;
    return { x: Math.floor(u * main.width), y: Math.floor(v * main.height) };
  })();

  const can_pan = current_view.zoom > Math.max(1, limits.min) + 1e-3;
  const stage_class = [
    'video-stage',
    can_pan && 'can-pan',
    gesture_kind === 'pan' && 'panning',
    gesture_kind === 'wipe' && 'wiping',
  ].filter(Boolean).join(' ');

  return (
    <div
      ref={root}
      className="video-viewer"
      style={{ width: style?.width, maxWidth: '100%' }}
      onPointerEnter={() => { hovered.current = true; }}
      onPointerLeave={() => { hovered.current = false; setPointer(null); }}
    >
      <div className="video-toolbar">
        {comparing && <SegmentedControl
          size="small"
          aria-label="Comparison"
          options={modes.map(({ value, label, icon }) => ({ value, label, icon }))}
          value={mode}
          onValueChange={value => {
            setMode(value);
            // the keys go to the videos, not to the buttons (arrows would change the mode)
            stage.current.focus({ preventScroll: true });
          }}
        />}
        {comparing && mode !== 'difference' && <Button
          size="small"
          variant="minimal"
          icon="exchange"
          text="Swap"
          title="Swap new and reference (t)"
          onClick={swap}
        />}
        {mode === 'difference' && <HTMLSelect
          minimal
          aria-label="Amplification"
          title="Amplify the difference"
          value={gain}
          onChange={event => setGain(Number(event.target.value))}
          options={GAINS.map(g => ({ value: g, label: `×${g}` }))}
        />}
        {same_video && <Tag minimal icon="duplicate" title="Both runs created exactly the same file">same video as the reference</Tag>}
        <span className="video-toolbar-spacer" />
        {pixel && <span className="video-pixel" aria-label="Pixel">x {pixel.x} y {pixel.y}</span>}
        <ButtonGroup variant="minimal" size="small">
          <Button icon="zoom-out" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomBy(1 / ZOOM_STEP)} />
          <Button className="video-zoom" text={`${zoom_percent}%`} title="Fit (0). Scroll or pinch to zoom, drag to pan" onClick={() => setView(FIT)} />
          <Button icon="zoom-in" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomBy(ZOOM_STEP)} />
          <Button text="1:1" title="Actual pixels: one video pixel per screen pixel" onClick={actualSize} />
        </ButtonGroup>
        {!animation && <PopoverNext content={frames_menu} placement="bottom-end">
          <Button size="small" variant="minimal" icon="camera" aria-label="Frames" title="Copy or save the current frame" />
        </PopoverNext>}
        <PopoverNext content={<Shortcuts />} placement="bottom-end" interactionKind="hover">
          <Button size="small" variant="minimal" icon="key-command" aria-label="Keyboard shortcuts" />
        </PopoverNext>
      </div>
      <div
        ref={stageRef}
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
        {slot('new', src_new, setElementNew, info_new, poster_new)}
        {comparing && slot('reference', src_ref, setElementRef, info_ref, poster_ref)}
        {mode === 'difference' && video_new && video_ref && <div className="video-slot" style={{ width: pane.width, height: pane.height, left: 0 }}>
          <div className="video-content" style={contentStyle(main)}>
            {visible && <DiffLayer
              key={`${src_new} ${src_ref}`}
              a={video_new}
              b={video_ref}
              gain={gain}
              controller={controller}
              canvasRef={diff_canvas}
              onError={setDiffError}
            />}
          </div>
          {diff_error && <div className="video-message">{diff_error}</div>}
        </div>}
        {labels}
        {mode === 'wipe' && <div className="video-wipe" style={{ left: wipe * pane.width }}>
          <div className="video-wipe-handle"><Icon icon="arrows-horizontal" size={14} /></div>
        </div>}
        {crosshair}
        {!animation && <StageOverlay controller={controller} />}
      </div>
      {!animation && <Transport controller={controller} />}
    </div>
  );
};

export default VideoViewer;
