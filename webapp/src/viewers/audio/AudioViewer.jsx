// The audio viewer: a file and, optionally, the same file of the reference, as waveforms or spectrograms on a shared
// time axis, played in sync. A/B switches what's heard at the same position, at matched loudness by default, so that
// the louder track doesn't win. With `compact`, a row for grids of sounds (CompactAudio.jsx) that expands into it.
// Standalone: it imports nothing from the app (viewers/__tests__/isolation.test.js), QA-Board uses it through
// ../audio-viewer.jsx. On its own, with generated audio: npm start, then /audio-viewer.html (playground.jsx).
import { useEffect, useRef, useState } from 'react';
import { Button, Callout, Classes, Intent, SegmentedControl, Slider, Switch, Tag, Tooltip } from '@blueprintjs/core';

import './audio.css';
import { useDark, usePlayback, useTrack, useWidth } from './hooks';
import { CompactAudioViewer } from './CompactAudio';
import { toTrack } from './tracks';
import { dbfs, difference } from './dsp';
import { drawSpectrogram, drawSplitWaveform, drawWaveform, DIFFERENCE_RANGE, SPECTROGRAM_RANGE, spectrogramTop } from './draw';
import { diverging, gradient, magma } from './colormap';
import { formatDb, formatGain, formatLufs, formatRate, formatTime, timeTicks } from './format';
import { colorOf, describe, nameOf } from './sides';

export { CompactAudioViewer };

const SHORTCUTS = [
  ['Space', 'Play or pause'],
  ['A / B', 'Hear the new or the reference track, at the same position'],
  ['X', 'Switch to the next track (A, B, difference)'],
  ['← / →', 'Move 1 second (5 with Shift)'],
  ['0 or Home', 'Back to the start (of the loop)'],
  ['Drag', 'Select a region: it loops'],
  ['L', 'Loop the selection, or stop looping'],
  ['M', 'Match loudness'],
  ['S', 'Waveform or spectrogram'],
  ['+ / −', 'Zoom in or out'],
  ['Ctrl + wheel, pinch', 'Zoom where the pointer is'],
  ['Shift + wheel, Alt + drag', 'Pan when zoomed in'],
  ['Z, double-click', 'Zoom on the selection, or show everything'],
  ['Escape', 'Clear the selection'],
  ['?', 'These shortcuts'],
];
const NAVIGATION_KEYS = [' ', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
// zoomed in to 2 ms at most: a few samples per pixel at 48 kHz
const MIN_SPAN = 0.002;

const Lane = ({ draw, height, deps }) => {
  const canvas = useRef(null);
  useEffect(() => {
    if (canvas.current) draw(canvas.current);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- draw is a new function at each render: deps says what it draws
  }, deps);
  return <canvas ref={canvas} className="qa-audio-canvas" style={{ height }} aria-hidden="true"/>;
};

const Legend = ({ colors, low, high, title }) => <span className="qa-audio-legend" title={title}>
  <span className="qa-audio-legend-label">{low}</span>
  <span className="qa-audio-legend-bar" style={{ background: gradient(colors) }}/>
  <span className="qa-audio-legend-label">{high}</span>
</span>;

const Shortcuts = ({ onClose }) => <div className="qa-audio-help" role="dialog" aria-label="Keyboard shortcuts">
  <div className="qa-audio-help-title">
    Keyboard shortcuts
    <Button size="small" variant="minimal" icon="cross" aria-label="Close" onClick={onClose}/>
  </div>
  <dl>{SHORTCUTS.map(([keys, what]) => <div key={keys}><dt><kbd>{keys}</kbd></dt><dd>{what}</dd></div>)}</dl>
</div>;

// - src: the file's URL, src_ref: the reference's (optional)
// - labels: { new, reference, colors: { new, reference } }: names, and CSS colors or the app's side colors ({hex, hex_dark})
// - caption, caption_ref: shown next to each track's name
// - height: of each track, in pixels
// - onError(error): when the file can't be loaded or decoded
// - onCollapse: shows a button that calls it (the compact row's full view)
// - version, version_ref: what identifies the files' contents (e.g. their hash), live: they can still change. Decoded
//   tracks are cached: a new version is decoded again, a live file without version every time (tracks.js)
export const FullAudioViewer = ({ src, src_ref, labels, caption, caption_ref, height = 96, onError, onCollapse, version, version_ref, live }) => {
  const root = useRef(null);
  const dark = useDark(root);
  const [lanes, width, lanes_element] = useWidth();

  const loaded_new = useTrack(src, { onError, version, live });
  const loaded_ref = useTrack(src_ref, { version: version_ref, live });
  const track_new = loaded_new.track;
  const track_ref = loaded_ref.track;

  const [view, setView] = useState('waveform');
  const [show_difference, setShowDifference] = useState(false);
  const [match_loudness, setMatchLoudness] = useState(true);
  const [zoom, setZoom] = useState(null);
  const [region, setRegion] = useState(null);
  const [selecting, setSelecting] = useState(null);
  const [help, setHelp] = useState(false);

  // new - reference: sample-aligned, so at the same rate and about the same duration
  const no_difference = !track_new || !track_ref ? 'it needs both tracks'
    : track_new.sample_rate !== track_ref.sample_rate ? `the sample rates differ (${formatRate(track_new.sample_rate)} and ${formatRate(track_ref.sample_rate)})`
    : Math.abs(track_new.duration - track_ref.duration) > 0.01 * Math.max(track_new.duration, track_ref.duration) ? `the durations differ (${formatTime(track_new.duration)} and ${formatTime(track_ref.duration)})`
    : null;
  const differing = show_difference && !no_difference;
  // computed when users turn it on, off the render: minutes of audio take a while
  const [computed, setComputed] = useState(null);
  useEffect(() => {
    if (!differing) return undefined;
    let cancelled = false;
    const compute = () => {
      if (cancelled) return;
      const track = toTrack({ sample_rate: track_new.sample_rate, channels: difference(track_new.channels, track_ref.channels) });
      setComputed({ track_new, track_ref, track });
    };
    if (globalThis.requestIdleCallback) {
      const id = globalThis.requestIdleCallback(compute, { timeout: 100 });
      return () => { cancelled = true; globalThis.cancelIdleCallback?.(id); };
    }
    const id = setTimeout(compute, 0);
    return () => { cancelled = true; clearTimeout(id); };
  }, [differing, track_new, track_ref]);
  const track_diff = differing && computed?.track_new === track_new && computed?.track_ref === track_ref ? computed.track : null;
  const computing_difference = differing && !track_diff;
  const playback = usePlayback({ new: track_new, reference: track_ref, difference: track_diff }, { match_loudness });
  const { duration, time, heard, playing } = playback;
  const looping = !!playback.loop;

  // what's shown: everything, or the zoomed-in window
  const shown = zoom ?? { start: 0, end: duration || 1 };
  const span = shown.end - shown.start;
  const setWindow = (start, end) => {
    const length = Math.max(MIN_SPAN, Math.min(duration, end - start));
    const from = Math.max(0, Math.min(duration - length, start));
    setZoom(length >= duration ? null : { start: from, end: from + length });
  };
  // around `center`, by default the playhead when it's in view
  const zoomBy = (factor, center = time >= shown.start && time <= shown.end ? time : shown.start + span / 2) =>
    setWindow(center - (center - shown.start) * factor, center + (shown.end - center) * factor);
  const timeAt = client_x => {
    const rect = lanes_element?.getBoundingClientRect();
    return shown.start + Math.max(0, Math.min(1, (client_x - (rect?.left ?? 0)) / (rect?.width || 1))) * span;
  };

  // while it plays, the window follows the playhead
  useEffect(() => {
    if (!zoom || !playing || (time >= zoom.start && time <= zoom.end)) return;
    const length = zoom.end - zoom.start;
    const start = Math.max(0, Math.min(duration - length, time));
    // oxlint-disable-next-line react/set-state-in-effect -- it follows the player, an external clock
    setZoom({ start, end: start + length });
  }, [zoom, playing, time, duration]);

  // ctrl + wheel and pinch zoom, shift + wheel and horizontal wheels pan. Plain wheels scroll the page.
  const onWheel = useRef(null);
  useEffect(() => {
    onWheel.current = event => {
      if (!duration) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        zoomBy(Math.exp(Math.max(-1, Math.min(1, event.deltaY * 0.01))), timeAt(event.clientX));
      } else if (zoom && (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY))) {
        event.preventDefault();
        const delta = event.shiftKey ? event.deltaY || event.deltaX : event.deltaX;
        setWindow(shown.start + delta / width * span, shown.end + delta / width * span);
      }
    };
  });
  useEffect(() => {
    if (!lanes_element) return undefined;
    // React's wheel listeners are passive: they can't keep the page from scrolling
    const listener = event => onWheel.current?.(event);
    lanes_element.addEventListener('wheel', listener, { passive: false });
    return () => lanes_element.removeEventListener('wheel', listener);
  }, [lanes_element]);

  const select = selection => {
    setRegion(selection);
    playback.setLoop(selection);
  };
  const toggleLoop = () => playback.setLoop(looping || !region ? null : region);

  // click: seek, drag: select a region (and loop it), alt or middle drag: pan
  const drag = useRef(null);
  const onPointerDown = event => {
    if (event.button !== 0 && event.button !== 1) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const pan = event.button === 1 || event.altKey;
    if (pan) event.preventDefault();
    drag.current = { x: event.clientX, time: timeAt(event.clientX), pan, window: shown, moved: false };
  };
  const onPointerMove = event => {
    const d = drag.current;
    if (!d) return;
    if (Math.abs(event.clientX - d.x) > 4) d.moved = true;
    if (!d.moved) return;
    if (d.pan) {
      const shift = (event.clientX - d.x) / width * (d.window.end - d.window.start);
      setWindow(d.window.start - shift, d.window.end - shift);
    } else {
      const t = timeAt(event.clientX);
      setSelecting({ start: Math.min(d.time, t), end: Math.max(d.time, t) });
    }
  };
  const onPointerUp = event => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.pan) return;
    setSelecting(null);
    if (!d.moved) return playback.seek(d.time);
    const t = timeAt(event.clientX);
    select({ start: Math.min(d.time, t), end: Math.max(d.time, t) });
    playback.seek(Math.min(d.time, t));
  };

  const sides = ['new', track_ref && 'reference', track_diff && 'difference'].filter(Boolean);
  const onKeyDown = event => {
    const on_control = event.target !== event.currentTarget && event.target.closest?.(`button, input, select, textarea, a, .${Classes.SLIDER}`);
    if (on_control && NAVIGATION_KEYS.includes(event.key)) return;
    if (!track_new || event.ctrlKey || event.metaKey || event.altKey) return;
    const step = event.shiftKey ? 5 : 1;
    const actions = {
      ' ': playback.toggle,
      a: () => playback.hear('new'),
      b: () => playback.hear('reference'),
      x: () => playback.hear(sides[(sides.indexOf(heard) + 1) % sides.length]),
      ArrowLeft: () => playback.seek(time - step),
      ArrowRight: () => playback.seek(time + step),
      0: () => playback.seek(looping ? region.start : 0),
      Home: () => playback.seek(looping ? region.start : 0),
      l: toggleLoop,
      m: () => setMatchLoudness(!match_loudness),
      s: () => setView(view === 'waveform' ? 'spectrogram' : 'waveform'),
      '+': () => zoomBy(0.5),
      '=': () => zoomBy(0.5),
      '-': () => zoomBy(2),
      z: () => region && !zoom ? setWindow(region.start, region.end) : setZoom(null),
      '?': () => setHelp(!help),
      Escape: () => help ? setHelp(false) : select(null),
    };
    const action = actions[event.key.length === 1 ? event.key.toLowerCase() : event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  if (loaded_new.status === 'error') return <div className="qa-audio" ref={root}>
    <Callout compact intent={Intent.WARNING} icon="warning-sign" className="qa-audio-callout">
      This browser can't decode the file ({loaded_new.error?.message ?? String(loaded_new.error)}): here is its own player.
    </Callout>
    {[[src, 'new'], [src_ref, 'reference']].filter(([url]) => url).map(([url, side]) => <div key={side} className="qa-audio-fallback">
      {src_ref && <span className="qa-audio-name"><span className="qa-audio-dot" style={{ background: colorOf(labels, side, dark) }}/>{nameOf(labels, side)}</span>}
      {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- files that runs wrote have no captions */}
      <audio controls preload="metadata" src={url} aria-label={`Play ${nameOf(labels, side)}`}/>
    </div>)}
  </div>;

  const ready = !!track_new && loaded_ref.status !== 'loading';
  const top_db = spectrogramTop(dbfs(Math.max(track_new?.levels.peak ?? 0, track_ref?.levels.peak ?? 0)));
  const shown_region = selecting ?? region;
  const percent = t => `${(t - shown.start) / span * 100}%`;
  const ticks = timeTicks(shown.start, shown.end, width);
  const axis_color = dark ? 'rgba(255, 255, 255, 0.14)' : 'rgba(17, 20, 24, 0.14)';
  const lane_deps = [view, width, height, shown.start, shown.end, dark, top_db];
  const rows = [
    { side: 'new', loaded: loaded_new, track: track_new, caption },
    src_ref && { side: 'reference', loaded: loaded_ref, track: track_ref, caption: caption_ref },
    track_diff && { side: 'difference', loaded: { status: 'ready' }, track: track_diff, caption: `${nameOf(labels, 'new')} − ${nameOf(labels, 'reference')}` },
  ].filter(Boolean);
  const multiple = !!track_ref;

  // the keys of the tracks (a slider) and of the buttons bubble here
  // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- see above
  return <div className="qa-audio" ref={root} role="group" aria-label="Audio player" onKeyDown={onKeyDown}>
    <div className="qa-audio-toolbar">
      <Button
        icon={playing ? 'pause' : 'play'} intent={Intent.PRIMARY} size="small" disabled={!ready}
        aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (Space)' : 'Play (Space)'}
        onClick={playback.toggle}
      />
      <span className="qa-audio-time"><span>{formatTime(time)}</span><span className="qa-audio-muted"> / {formatTime(duration)}</span></span>
      {src_ref && <SegmentedControl
        size="small" role="radiogroup" aria-label="What you hear" disabled={!ready || !track_ref}
        value={heard} onValueChange={playback.hear}
        options={sides.map((side, i) => ({ value: side, label: `${['A', 'B', 'Δ'][i]} · ${nameOf(labels, side)}` }))}
      />}
      {src_ref && <Tooltip
        content={track_new && track_ref ? `Played at the loudness of the quieter track (${formatLufs(Math.min(track_new.loudness, track_ref.loudness))}): the louder one doesn't win A/B. (M)` : 'Plays both tracks as loud'}
        placement="bottom" openOnTargetFocus={false}
      >
        <Switch inline className="qa-audio-switch" label="Match loudness" checked={match_loudness} disabled={!track_ref} onChange={event => setMatchLoudness(event.target.checked)}/>
      </Tooltip>}
      <span className="qa-audio-group">
        <Button
          icon="repeat" size="small" variant="minimal" active={looping} disabled={!region}
          aria-label="Loop the selection" aria-pressed={looping}
          title={region ? `Loop ${formatTime(region.start)}–${formatTime(region.end)} (L)` : 'Drag on a track to select a region, it loops'}
          onClick={toggleLoop}
        />
        {region && <Button icon="cross" size="small" variant="minimal" aria-label="Clear the selection" title="Clear the selection (Escape)" onClick={() => select(null)}/>}
      </span>
      <span className="qa-audio-volume">
        <Button
          icon={playback.volume === 0 ? 'volume-off' : playback.volume < 0.5 ? 'volume-down' : 'volume-up'} size="small" variant="minimal"
          aria-label={playback.volume === 0 ? 'Unmute' : 'Mute'} onClick={() => playback.setVolume(playback.volume === 0 ? 1 : 0)}
        />
        <Slider min={0} max={1} stepSize={0.01} labelRenderer={false} value={playback.volume} onChange={playback.setVolume} handleHtmlProps={{ 'aria-label': 'Volume' }}/>
      </span>
      <span className="qa-audio-spacer"/>
      {src_ref && <Tooltip
        content={no_difference ? `No difference: ${no_difference}` : 'New − reference: a waveform of what\'s left sample by sample (silent when identical), or where their spectra differ, in dB'}
        placement="bottom" openOnTargetFocus={false}
      >
        <Switch inline className="qa-audio-switch" label="Difference" checked={differing} disabled={!!no_difference} onChange={event => setShowDifference(event.target.checked)}/>
      </Tooltip>}
      {computing_difference && <span className="qa-audio-meta" role="status">computing the difference…</span>}
      <SegmentedControl
        size="small" aria-label="View" value={view} onValueChange={setView}
        options={[{ value: 'waveform', label: 'Waveform' }, { value: 'spectrogram', label: 'Spectrogram' }]}
      />
      {onCollapse && <Button icon="minimize" size="small" variant="minimal" aria-label="Collapse" title="Back to the compact row" onClick={onCollapse}/>}
    </div>
    {playback.error && <Callout compact intent={Intent.WARNING} icon="warning-sign" className="qa-audio-callout">
      Could not play: {playback.error.message ?? String(playback.error)}
    </Callout>}

    <div
      ref={lanes} className="qa-audio-lanes"
      tabIndex={ready ? 0 : -1} role="slider" aria-label="Position"
      aria-valuemin={0} aria-valuemax={Math.round(duration * 1000) / 1000} aria-valuenow={Math.round(time * 1000) / 1000}
      aria-valuetext={`${formatTime(time)} of ${formatTime(duration)}`} title="Press ? for the keyboard shortcuts"
    >
      {rows.map(({ side, loaded, track, caption: text }) => {
        const color = colorOf(labels, side, dark);
        const name = nameOf(labels, side);
        const gain = playback.gains[side] ?? 0;
        const is_heard = multiple && heard === side;
        const difference_lane = side === 'difference';
        return <div key={side} className={`qa-audio-track${is_heard ? ' qa-audio-heard' : ''}`} style={{ '--qa-audio-color': color }}>
          <div className="qa-audio-header">
            {multiple && <Button
              size="small" variant="minimal" icon={playing && is_heard ? 'volume-up' : 'play'} disabled={!track}
              aria-label={`Play ${name}`} title={`Play ${name} (${{ new: 'A', reference: 'B', difference: 'X' }[side]})`}
              onClick={() => { playback.hear(side); if (!playing) playback.play(); }}
            />}
            <span className="qa-audio-name"><span className="qa-audio-dot"/>{name}</span>
            {text && <span className="qa-audio-caption">{text}</span>}
            {track && !difference_lane && <span className="qa-audio-meta">{describe(track)}</span>}
            {difference_lane && <span className="qa-audio-meta">{track.levels.peak === 0 ? 'identical samples' : `peak ${formatDb(dbfs(track.levels.peak))} · ${formatLufs(track.loudness)}`}</span>}
            {loaded.status === 'loading' && <span className="qa-audio-meta">decoding…</span>}
            {match_loudness && Math.abs(gain) >= 0.05 && <Tag minimal round title={`Played ${formatGain(gain)} to sound as loud as the other track. Turn off Match loudness to hear it as it is.`}>
              {formatGain(gain)} to match
            </Tag>}
            {track && !difference_lane && track.levels.clipped > 0 && <Tag minimal round intent={Intent.DANGER} title="Samples at full scale, in red on the waveform">
              {track.levels.clipped.toLocaleString()} clipped
            </Tag>}
          </div>
          <div
            className="qa-audio-lane" style={{ height }}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
            onPointerCancel={() => { drag.current = null; setSelecting(null); }}
            onDoubleClick={() => setZoom(null)}
          >
            {track && <Lane height={height} deps={[track, track_ref, ...lane_deps, color]} draw={canvas => {
              const range = { width, height, start: shown.start, end: shown.end };
              if (view === 'spectrogram' && difference_lane) drawSpectrogram(canvas, track_new, { ...range, top_db, reference: track_ref });
              else if (view === 'spectrogram') drawSpectrogram(canvas, track, { ...range, top_db });
              else drawWaveform(canvas, track, { ...range, color, axis_color });
            }}/>}
            {loaded.status === 'loading' && <div className={`qa-audio-placeholder ${Classes.SKELETON}`}/>}
            {loaded.status === 'error' && <div className="qa-audio-lane-message">
              Could not load {name}: {loaded.error?.message ?? String(loaded.error)}
            </div>}
            {track && shown_region && <div className="qa-audio-region" style={{ left: percent(shown_region.start), width: `${(shown_region.end - shown_region.start) / span * 100}%` }}/>}
            {track && time >= shown.start && time <= shown.end && <div className="qa-audio-playhead" style={{ left: percent(time) }}/>}
          </div>
        </div>;
      })}
    </div>
    <div className="qa-audio-footer">
      <div className="qa-audio-axis" aria-hidden="true">
        {ready && ticks.map(tick => <span key={tick.time} className="qa-audio-tick" style={{ left: percent(tick.time) }}>{tick.label}</span>)}
      </div>
      {zoom && track_new && <Overview
        tracks={[track_new, track_ref].filter(Boolean).map((track, i) => ({ track, color: colorOf(labels, i ? 'reference' : 'new', dark) }))}
        duration={duration} shown={shown} time={time} width={width} dark={dark}
        onMove={center => setWindow(center - span / 2, center + span / 2)}
      />}
      <div className="qa-audio-footer-bar">
        <span className="qa-audio-group">
          <Button icon="zoom-in" size="small" variant="minimal" aria-label="Zoom in" title="Zoom in (+, Ctrl + wheel)" disabled={!ready || span <= MIN_SPAN * 1.01} onClick={() => zoomBy(0.5)}/>
          <Button icon="zoom-out" size="small" variant="minimal" aria-label="Zoom out" title="Zoom out (−)" disabled={!zoom} onClick={() => zoomBy(2)}/>
          <Button
            icon={region && !zoom ? 'zoom-to-fit' : 'maximize'} size="small" variant="minimal" disabled={!zoom && !region}
            aria-label={region && !zoom ? 'Zoom on the selection' : 'Show everything'} title={`${region && !zoom ? 'Zoom on the selection' : 'Show everything'} (Z)`}
            onClick={() => region && !zoom ? setWindow(region.start, region.end) : setZoom(null)}
          />
        </span>
        {zoom && <span className="qa-audio-hint" title="Ctrl + wheel or pinch to zoom, Shift + wheel or Alt + drag to pan, double-click to show everything">
          {formatTime(shown.start)}–{formatTime(shown.end)}
        </span>}
        <span className="qa-audio-spacer"/>
        {view === 'spectrogram' && <span className="qa-audio-legends">
          <Legend colors={magma} low={`${top_db - SPECTROGRAM_RANGE}`} high={`${top_db} dBFS`} title="Level of each frequency, in dBFS: a full-scale sine is 0 dB"/>
          {track_diff && <Legend colors={diverging} low={`louder in ${nameOf(labels, 'reference')} −${DIFFERENCE_RANGE}`} high={`+${DIFFERENCE_RANGE} dB louder in ${nameOf(labels, 'new')}`} title="New − reference, in dB: blue where the new track is louder, orange where the reference is. Dim where both are quiet."/>}
        </span>}
        <Button icon="key-command" size="small" variant="minimal" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" active={help} onClick={() => setHelp(!help)}/>
      </div>
    </div>
    {help && <Shortcuts onClose={() => setHelp(false)}/>}
  </div>;
};

// When zoomed in: everything, small, with the window shown. Click or drag to move it.
const Overview = ({ tracks, duration, shown, time, width, dark, onMove }) => {
  const dragging = useRef(false);
  const timeAt = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / (rect.width || 1))) * duration;
  };
  return <div
    className="qa-audio-overview" aria-hidden="true" title="Drag to move what's shown"
    onPointerDown={event => { event.currentTarget.setPointerCapture?.(event.pointerId); dragging.current = true; onMove(timeAt(event)); }}
    onPointerMove={event => dragging.current && onMove(timeAt(event))}
    onPointerUp={() => { dragging.current = false; }}
  >
    <Lane height={20} deps={[tracks[0].track, tracks[1]?.track, tracks[0].color, width, duration, dark]} draw={canvas => drawSplitWaveform(canvas, tracks, {
      width, height: 20, start: 0, end: duration, axis_color: dark ? 'rgba(255, 255, 255, 0.14)' : 'rgba(17, 20, 24, 0.14)',
    })}/>
    <div className="qa-audio-overview-window" style={{ left: `${shown.start / duration * 100}%`, width: `${(shown.end - shown.start) / duration * 100}%` }}/>
    <div className="qa-audio-playhead" style={{ left: `${time / duration * 100}%` }}/>
  </div>;
};

// The full viewer, or with `compact` a row that expands into it: in place, or with onExpand, wherever the page wants
// (e.g. full screen). See FullAudioViewer and CompactAudioViewer for the props.
export const AudioViewer = ({ compact = false, onExpand, ...props }) => {
  const [expanded, setExpanded] = useState(false);
  if (compact && !expanded) return <CompactAudioViewer {...props} onExpand={onExpand ?? (() => setExpanded(true))}/>;
  return <FullAudioViewer {...props} height={compact ? undefined : props.height} onCollapse={compact ? () => setExpanded(false) : undefined}/>;
};
