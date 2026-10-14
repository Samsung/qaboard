import { memo, useRef, useState, useSyncExternalStore } from 'react';
import { Button, HTMLSelect, Tooltip, Classes } from '@blueprintjs/core';

import { formatTime, formatFps } from './utils';

export const RATES = [0.1, 0.25, 0.5, 1, 1.5, 2, 4];

const clamp = (x, min, max) => Math.min(max, Math.max(min, x));

// The timeline: click or drag to seek. Paused while dragging, it plays again after.
// We map the pointer to the track we draw ourselves: a range input maps it with an inset for its thumb.
// The (transparent) input is there for assistive technologies.
const Scrubber = ({ controller, snapshot }) => {
  const { time, duration, buffered, frameDuration, ready } = snapshot;
  const drag = useRef(null);
  const [hover, setHover] = useState(null);

  const timeAt = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    return clamp((event.clientX - rect.left) / rect.width, 0, 1) * duration;
  };
  const onPointerDown = event => {
    if (!ready || event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { resume: controller.playing };
    if (controller.playing) controller.pause();
    controller.seek(timeAt(event));
  };
  const onPointerMove = event => {
    if (!ready) return;
    setHover(timeAt(event));
    if (drag.current) controller.seek(timeAt(event));
  };
  const onPointerUp = () => {
    if (drag.current?.resume) controller.play();
    drag.current = null;
  };
  const percent = t => `${duration ? 100 * clamp(t / duration, 0, 1) : 0}%`;
  return (
    <div
      className="video-scrubber"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => setHover(null)}
    >
      <div className="video-scrubber-track">
        {buffered.map(([start, end]) =>
          <div key={start} className="video-scrubber-buffered" style={{ left: percent(start), width: `calc(${percent(end)} - ${percent(start)})` }} />
        )}
        <div className="video-scrubber-played" style={{ width: percent(time) }} />
      </div>
      <div className="video-scrubber-thumb" style={{ left: percent(time) }} />
      {hover !== null && <div className="video-scrubber-hover" style={{ left: percent(hover) }}>
        {formatTime(hover)}{frameDuration ? ` · frame ${Math.floor(hover / frameDuration + 1e-3)}` : ''}
      </div>}
      <input
        type="range"
        className="video-scrubber-input"
        aria-label="Seek"
        aria-valuetext={formatTime(time)}
        min={0}
        max={duration || 0}
        step="any"
        value={Math.min(time, duration || 0)}
        disabled={!ready}
        onChange={event => controller.seek(Number(event.target.value))}
      />
    </div>
  );
};

// memo: it renders on its own when the playback changes, not when the viewer does (e.g. on mouse moves)
export const Transport = memo(({ controller }) => {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const disabled = !s.ready;
  const fps = s.frameDuration ? 1 / s.frameDuration : null;
  const fps_help = s.fpsSource === 'config'
    ? 'From qaboard.yaml'
    : s.fpsSource === 'measured'
    ? 'Measured while playing. Set `fps` in qaboard.yaml if it\'s wrong.'
    : 'Unknown until the video plays or you step through frames. You can set `fps` in qaboard.yaml.';
  // the longest text, so that the timeline doesn't move
  const frame_width = `frame ${s.frames ?? 999} / ${s.frames ?? 999}`.length;
  return (
    <div className="video-transport">
      <Button
        variant="minimal"
        icon={s.playing ? 'pause' : 'play'}
        aria-label={s.playing ? 'Pause' : 'Play'}
        title={`${s.playing ? 'Pause' : 'Play'} (space)`}
        disabled={disabled}
        onClick={() => controller.toggle()}
      />
      <Button variant="minimal" icon="step-backward" aria-label="Previous frame" title="Previous frame (←)" disabled={disabled} onClick={() => controller.stepFrames(-1)} />
      <Button variant="minimal" icon="step-forward" aria-label="Next frame" title="Next frame (→)" disabled={disabled} onClick={() => controller.stepFrames(1)} />
      <Scrubber controller={controller} snapshot={s} />
      <span className="video-time" aria-label="Time">
        {formatTime(s.time)} <span className={Classes.TEXT_MUTED}>/ {formatTime(s.duration)}</span>
      </span>
      <Tooltip content={<span>Frame rate: {fps ? formatFps(fps) : 'unknown'}. {fps_help}</span>} placement="top">
        <span className="video-time" aria-label="Frame" style={{ minWidth: `${frame_width}ch` }}>
          {s.frame !== null ? <>frame {s.frame}{s.frames ? <span className={Classes.TEXT_MUTED}> / {s.frames}</span> : null}</> : <span className={Classes.TEXT_MUTED}>frame ?</span>}
        </span>
      </Tooltip>
      {s.error && <span className="video-error-text" title={s.error}>Can't play: {s.error}</span>}
      <HTMLSelect
        minimal
        aria-label="Speed"
        title="Speed ([ and ])"
        value={s.rate}
        onChange={event => controller.setRate(Number(event.target.value))}
        options={RATES.map(rate => ({ value: rate, label: `${rate}×` }))}
      />
      <Button variant="minimal" icon="repeat" active={s.loop} aria-label="Loop" title="Loop" onClick={() => controller.setLoop(!s.loop)} />
      <Button
        variant="minimal"
        icon={s.muted ? 'volume-off' : 'volume-up'}
        aria-label={s.muted ? 'Unmute' : 'Mute'}
        title={`${s.muted ? 'Unmute' : 'Mute'} the new video (m)`}
        onClick={() => controller.setMuted(!s.muted)}
      />
    </div>
  );
});
