// The audio viewer: a file and, optionally, the same file of the reference, as waveforms or spectrograms on a shared
// time axis, played in sync. A/B switches what's heard at the same position, as audio people compare.
// Standalone: it imports nothing from the app (viewers/__tests__/isolation.test.js), QA-Board uses it through
// ../audio-viewer.jsx. On its own, with generated audio: npm start, then /audio-viewer.html (playground.jsx).
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Callout, Classes, Intent, SegmentedControl, Slider, Spinner, Switch, Tag } from '@blueprintjs/core';

import './audio.css';
import { createPlayer } from './player';
import { loadTrack, toTrack } from './tracks';
import { dbfs, difference } from './dsp';
import { drawSpectrogram, drawWaveform, spectrogramOf } from './draw';
import { formatDb, formatRate, formatTime, timeTicks } from './format';

// light and dark theme colors, like the app's for the new and reference sides
const COLORS = { new: ['#2d72d2', '#4c90f0'], reference: ['#9752fe', '#9c4bf5'], difference: ['#5f6b7c', '#abb3bf'] };
// a label's color: a CSS color, or the app's side colors { hex, hex_dark }
const colorOf = (color, side, dark) => {
  if (typeof color === 'string' && !color.startsWith('var(')) return color;
  if (color?.hex) return dark ? color.hex_dark ?? color.hex : color.hex;
  return COLORS[side][dark ? 1 : 0];
};

// src => { status: none | loading | ready | error, track, error }
function useTrack(src, onError) {
  const [state, setState] = useState({});
  // not a dependency: an inline callback would load the file again on every render
  const callback = useRef(onError);
  useEffect(() => { callback.current = onError; });
  useEffect(() => {
    if (!src) return undefined;
    const controller = new AbortController();
    loadTrack(src, { signal: controller.signal }).then(
      track => setState({ src, track }),
      error => {
        if (controller.signal.aborted) return;
        setState({ src, error });
        callback.current?.(error);
      });
    return () => controller.abort();
  }, [src]);
  if (!src) return { status: 'none' };
  if (state.src !== src) return { status: 'loading' };
  return state.error ? { status: 'error', error: state.error } : { status: 'ready', track: state.track };
}

// whether the viewer is in Blueprint's dark theme, a class on an ancestor
function useDark(ref) {
  const [dark, setDark] = useState(false);
  useLayoutEffect(() => {
    const detect = () => setDark(!!ref.current?.closest(`.${Classes.DARK}`));
    detect();
    if (typeof MutationObserver === 'undefined') return undefined;
    const observer = new MutationObserver(detect);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [ref]);
  return dark;
}

// [ref callback, width of the element]
function useWidth() {
  const [element, setElement] = useState(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    // it measures the element when it starts observing it, before the first paint
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  // jsdom lays out nothing
  return [setElement, width || 600];
}

const Lane = ({ track, view, width, height, duration, color, max_db, dark }) => {
  const canvas = useRef(null);
  useEffect(() => {
    if (!canvas.current || !width) return;
    if (view === 'spectrogram') drawSpectrogram(canvas.current, track, { width, height, duration, max_db });
    else drawWaveform(canvas.current, track, { width, height, duration, color, axis_color: dark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(17, 20, 24, 0.15)' });
  }, [track, view, width, height, duration, color, max_db, dark]);
  return <canvas ref={canvas} className="qa-audio-canvas" style={{ width: width || '100%', height }} aria-hidden="true"/>;
};

const Levels = ({ track }) => <span className="qa-audio-meta">
  {formatRate(track.sample_rate)}{track.resampled ? ' (as decoded)' : ''}
  {' · '}{track.channels.length === 1 ? 'mono' : track.channels.length === 2 ? 'stereo' : `${track.channels.length} channels`}
  {' · '}{formatTime(track.duration)}
  {' · '}peak {formatDb(dbfs(track.levels.peak))}
  {' · '}RMS {formatDb(dbfs(track.levels.rms))}
</span>;

const SHORTCUTS = 'Space: play or pause, X: switch between A and B, arrows: move 1 second (5 with Shift), Home: back to the start, L: loop the selection, Escape: clear the selection';
const NAVIGATION_KEYS = [' ', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];

// - src: the file's URL, src_ref: the reference's (optional)
// - labels: { new, reference, colors: { new, reference } }: names, and CSS colors or the app's side colors ({hex, hex_dark})
// - caption, caption_ref: shown under each track's name
// - height: of each track, in pixels
// - onError(error): when the file can't be loaded or decoded
export const AudioViewer = ({ src, src_ref, labels, caption, caption_ref, height = 96, onError }) => {
  const root = useRef(null);
  const shortcuts_id = useId();
  const dark = useDark(root);
  const [lanes, width] = useWidth();

  const loaded_new = useTrack(src, onError);
  const loaded_ref = useTrack(src_ref);
  const track_new = loaded_new.track;
  const track_ref = loaded_ref.track;

  const [view, setView] = useState('waveform');
  const [show_difference, setShowDifference] = useState(false);
  const [heard_, setHeard] = useState('new');
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [volume, setVolume] = useState(1);
  const [region, setRegion] = useState(null);
  const [looping, setLooping] = useState(false);
  const [selecting, setSelecting] = useState(null);
  const [play_error, setPlayError] = useState(null);

  // what's left of new - reference: sample-aligned only at the same rate
  const can_diff = !!track_new && !!track_ref && track_new.sample_rate === track_ref.sample_rate;
  const track_diff = useMemo(
    () => can_diff && show_difference ? toTrack({ sample_rate: track_new.sample_rate, channels: difference(track_new.channels, track_ref.channels) }) : null,
    [can_diff, show_difference, track_new, track_ref],
  );
  const tracks = [
    track_new && { side: 'new', track: track_new, name: labels?.new ?? 'new', caption, play: 'A' },
    track_ref && { side: 'reference', track: track_ref, name: labels?.reference ?? 'reference', caption: caption_ref, play: 'B' },
    track_diff && { side: 'difference', track: track_diff, name: 'Difference', caption: `${labels?.new ?? 'new'} − ${labels?.reference ?? 'reference'}`, play: 'Δ' },
  ].filter(Boolean);
  // what's heard, if it's still there
  const heard = tracks.some(t => t.side === heard_) ? heard_ : 'new';
  const duration = Math.max(0, ...tracks.map(t => t.track.duration));
  const max_db = useMemo(
    () => view === 'spectrogram' && track_new ? Math.max(...[track_new, track_ref].filter(Boolean).map(t => spectrogramOf(t).max)) : undefined,
    [view, track_new, track_ref],
  );

  // a player for the tracks. Changing them (e.g. showing the difference) keeps the position, but pauses.
  const player = useRef(null);
  const state = useRef({});
  useEffect(() => { state.current = { time, heard, volume, loop: looping ? region : null }; });
  useEffect(() => {
    if (!track_new) return undefined;
    const created = createPlayer({ new: track_new, reference: track_ref, difference: track_diff });
    const { time: t = 0, heard: h, volume: v = 1, loop } = state.current;
    created.seek(t);
    created.hear(h);
    created.setVolume(v);
    created.setLoop(loop ?? null);
    player.current = created;
    return () => {
      created.dispose();
      player.current = null;
      setPlaying(false);
    };
  }, [track_new, track_ref, track_diff]);

  // the playhead follows the player
  useEffect(() => {
    if (!playing) return undefined;
    let frame;
    const tick = () => {
      const p = player.current;
      if (!p) return;
      setTime(p.time());
      if (!p.playing) setPlaying(false);
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const play = () => {
    const p = player.current;
    if (!p) return;
    setPlayError(null);
    p.play().catch(error => {
      setPlaying(false);
      setPlayError(error);
    });
    setPlaying(true);
  };
  const pause = () => {
    player.current?.pause();
    setPlaying(false);
    setTime(player.current?.time() ?? time);
  };
  const toggle = () => playing ? pause() : play();
  const hear = side => {
    player.current?.hear(side);
    setHeard(side);
  };
  const seek = t => {
    const clamped = Math.max(0, Math.min(duration, t));
    player.current?.seek(clamped);
    setTime(clamped);
  };
  const changeVolume = value => {
    player.current?.setVolume(value);
    setVolume(value);
  };
  const loopOn = (on, selection = region) => {
    player.current?.setLoop(on ? selection : null);
    setLooping(on && !!selection);
  };
  const select = selection => {
    setRegion(selection);
    loopOn(!!selection, selection);
  };

  // click: seek, drag: select a region (and loop it)
  const drag = useRef(null);
  const timeAt = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / (rect.width || 1))) * duration;
  };
  const onPointerDown = event => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { x: event.clientX, time: timeAt(event), moved: false };
  };
  const onPointerMove = event => {
    const d = drag.current;
    if (!d) return;
    if (Math.abs(event.clientX - d.x) > 4) d.moved = true;
    if (d.moved) {
      const t = timeAt(event);
      setSelecting({ start: Math.min(d.time, t), end: Math.max(d.time, t) });
    }
  };
  const onPointerUp = event => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    setSelecting(null);
    if (!d.moved) return seek(d.time);
    const t = timeAt(event);
    select({ start: Math.min(d.time, t), end: Math.max(d.time, t) });
    seek(Math.min(d.time, t));
  };

  const onKeyDown = event => {
    const on_control = event.target !== event.currentTarget && event.target.closest?.(`button, input, select, textarea, a, .${Classes.SLIDER}`);
    if (on_control && NAVIGATION_KEYS.includes(event.key)) return;
    const sides = tracks.map(t => t.side);
    const step = event.shiftKey ? 5 : 1;
    const actions = {
      ' ': toggle,
      x: () => hear(sides[(sides.indexOf(heard) + 1) % sides.length]),
      a: () => hear('new'),
      b: () => track_ref && hear('reference'),
      ArrowLeft: () => seek(time - step),
      ArrowRight: () => seek(time + step),
      Home: () => seek(region?.start ?? 0),
      l: () => loopOn(!looping),
      Escape: () => select(null),
    };
    const action = actions[event.key.length === 1 ? event.key.toLowerCase() : event.key];
    if (!action || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    action();
  };

  if (loaded_new.status === 'error') return <div className="qa-audio" ref={root}>
    <Callout compact intent={Intent.WARNING} icon="warning-sign" className="qa-audio-callout">
      Could not read the audio ({loaded_new.error?.message ?? String(loaded_new.error)}). The browser's player may still play it.
    </Callout>
    {[[src, labels?.new ?? 'new'], [src_ref, labels?.reference ?? 'reference']].filter(([url]) => url).map(([url, name], i) => <div key={i} className="qa-audio-fallback">
      {src_ref && <span className="qa-audio-name">{name}</span>}
      {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- files that runs wrote have no captions */}
      <audio controls preload="metadata" src={url} aria-label={`Play ${name}`}/>
    </div>)}
  </div>;

  const loading = loaded_new.status === 'loading' || loaded_ref.status === 'loading';
  const shown = selecting ?? region;
  const ticks = timeTicks(duration, width);
  const percent = t => `${duration ? t / duration * 100 : 0}%`;
  // the keys of the tracks (a slider) and of the buttons bubble here
  // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- see above
  return <div className="qa-audio" ref={root} role="group" aria-label="Audio player" onKeyDown={onKeyDown}>
    {loading && <div className="qa-audio-loading" style={{ minHeight: height }}><Spinner size={20} aria-label="Loading the audio"/></div>}
    {loaded_ref.status === 'error' && <Callout compact icon="info-sign" className="qa-audio-callout">
      Could not load the reference ({loaded_ref.error?.message ?? String(loaded_ref.error)}): only the new file is shown.
    </Callout>}
    {play_error && <Callout compact intent={Intent.WARNING} icon="warning-sign" className="qa-audio-callout">
      Could not play: {play_error.message ?? String(play_error)}
    </Callout>}
    {!loading && track_new && <div className="qa-audio-toolbar">
      <Button
        icon={playing ? 'pause' : 'play'} intent={Intent.PRIMARY} size="small"
        aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (Space)' : 'Play (Space)'}
        onClick={toggle}
      />
      <span className="qa-audio-time" aria-live="off">{formatTime(time)} / {formatTime(duration)}</span>
      {tracks.length > 1 && <SegmentedControl
        size="small" role="radiogroup" aria-label="What's heard"
        title="What's heard: switches at the same position (X)"
        value={heard} onValueChange={hear}
        options={tracks.map(t => ({ value: t.side, label: `${t.play}: ${t.name}` }))}
      />}
      <Button
        icon="refresh" size="small" variant="minimal" active={looping} disabled={!region}
        aria-label="Loop the selection" aria-pressed={looping}
        title={region ? `Loop ${formatTime(region.start)}–${formatTime(region.end)} (L)` : 'Drag on a track to select a region to loop'}
        onClick={() => loopOn(!looping)}
      >Loop</Button>
      {region && <Button icon="cross" size="small" variant="minimal" aria-label="Clear the selection" title="Clear the selection (Escape)" onClick={() => select(null)}/>}
      <span className="qa-audio-volume">
        <Button
          icon={volume === 0 ? 'volume-off' : volume < 0.5 ? 'volume-down' : 'volume-up'} size="small" variant="minimal"
          aria-label={volume === 0 ? 'Unmute' : 'Mute'} onClick={() => changeVolume(volume === 0 ? 1 : 0)}
        />
        <Slider min={0} max={1} stepSize={0.01} labelRenderer={false} value={volume} onChange={changeVolume} handleHtmlProps={{ 'aria-label': 'Volume' }}/>
      </span>
      <span className="qa-audio-spacer"/>
      {can_diff && <Switch
        inline className="qa-audio-switch" label="Difference" checked={show_difference}
        title="What's left of new − reference, sample by sample: silent when they're identical"
        onChange={event => setShowDifference(event.target.checked)}
      />}
      <SegmentedControl
        size="small" aria-label="View" value={view} onValueChange={setView}
        options={[{ value: 'waveform', label: 'Waveform' }, { value: 'spectrogram', label: 'Spectrogram' }]}
      />
    </div>}
    <div
      ref={lanes} className="qa-audio-lanes"
      tabIndex={track_new ? 0 : -1} role="slider" aria-label="Position"
      aria-valuemin={0} aria-valuemax={Math.round(duration * 1000) / 1000} aria-valuenow={Math.round(time * 1000) / 1000}
      aria-valuetext={`${formatTime(time)} of ${formatTime(duration)}`} aria-describedby={shortcuts_id} title={SHORTCUTS}
    >
      {!loading && tracks.map(({ side, track, name, caption: text, play: letter }) => {
        const color = colorOf(labels?.colors?.[side], side, dark);
        return <div key={side} className={`qa-audio-track${tracks.length > 1 && heard === side ? ' qa-audio-heard' : ''}`} style={{ '--qa-audio-color': color }}>
          <div className="qa-audio-header">
            {tracks.length > 1 && <Button
              size="small" variant="minimal" icon={playing && heard === side ? 'volume-up' : 'play'}
              aria-label={`Play ${name}`} title={`Play ${name} (${letter})`}
              onClick={() => { hear(side); if (!playing) play(); }}
            />}
            <span className="qa-audio-name"><span className="qa-audio-dot"/>{name}</span>
            {text && <span className="qa-audio-caption">{text}</span>}
            <Levels track={track}/>
            {track.levels.clipped > 0 && side !== 'difference' && <Tag minimal intent={Intent.DANGER} title="Samples at full scale, in red on the waveform">
              {track.levels.clipped.toLocaleString()} clipped samples
            </Tag>}
            {side === 'difference' && track.levels.peak === 0 && <Tag minimal intent={Intent.SUCCESS}>identical samples</Tag>}
          </div>
          <div
            className="qa-audio-lane"
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
            onPointerCancel={() => { drag.current = null; setSelecting(null); }}
          >
            <Lane track={track} view={view} width={width} height={height} duration={duration} color={color} max_db={max_db} dark={dark}/>
            {shown && <div className="qa-audio-region" style={{ left: percent(shown.start), width: percent(shown.end - shown.start) }}/>}
            <div className="qa-audio-playhead" style={{ left: percent(time) }}/>
          </div>
        </div>;
      })}
    </div>
    <span id={shortcuts_id} hidden>{SHORTCUTS}</span>
    {!loading && track_new && <div className="qa-audio-axis" aria-hidden="true">
      {ticks.map(tick => <span key={tick.time} className="qa-audio-tick" style={{ left: percent(tick.time) }}>{tick.label}</span>)}
    </div>}
  </div>;
};
