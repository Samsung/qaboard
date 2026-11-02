import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { colorAt } from '../../image-viewer/colormaps';
import { Button, Select } from '../../image-viewer/ui';
import { formatTime, formatFps } from './utils';

export const RATES = [0.1, 0.25, 0.5, 1, 1.5, 2, 4];

const clamp = (x, min, max) => Math.min(max, Math.max(min, x));

// How much the videos differ over time, frame by frame, above the timeline: the taller and darker, the more.
// timeline: { frames: [{ time, value }], keyframes: [time], describe(frame) }
const DifferenceStrip = ({ timeline, duration }) => {
  const canvas = useRef(null);
  const { frames, keyframes } = timeline;
  useEffect(() => {
    const element = canvas.current;
    if (!element || !duration) return;
    const ratio = window.devicePixelRatio || 1;
    const width = element.clientWidth;
    const height = element.clientHeight;
    element.width = Math.round(width * ratio);
    element.height = Math.round(height * ratio);
    const context = element.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const top = Math.max(1e-9, ...(frames ?? []).map(f => f.value));
    (frames ?? []).forEach((frame, i) => {
      if (!(frame.value > 0)) return;
      const end = frames[i + 1]?.time ?? frame.time + (frame.time - (frames[i - 1]?.time ?? 0));
      const x0 = frame.time / duration * width;
      const x1 = Math.max(x0 + 1, end / duration * width);
      const amount = frame.value / top;
      const [r, g, b] = colorAt('inferno', 1 - 0.85 * amount);
      context.fillStyle = `rgb(${r}, ${g}, ${b})`;
      const h = Math.max(2, amount * (height - 3));
      context.fillRect(x0, height - 3 - h, x1 - x0, h);
    });
    // keyframes, under the bars
    context.fillStyle = 'rgba(143, 153, 168, 0.9)';
    for (const time of keyframes ?? []) context.fillRect(time / duration * width, height - 2, 1, 2);
  });
  return <canvas ref={canvas} className="video-difference-strip" aria-hidden="true" />;
};

// The timeline: click or drag to seek. Paused while dragging, it plays again after.
// We map the pointer to the track we draw ourselves: a range input maps it with an inset for its thumb.
// The (transparent) input is there for assistive technologies.
const Scrubber = ({ controller, snapshot, timeline }) => {
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
  const hover_frame = hover === null ? null : controller.frameAt(hover);
  const strip = !!timeline && (timeline.frames?.length > 0 || timeline.keyframes?.length > 0);
  return (
    <div
      className={`video-scrubber ${strip ? 'video-scrubber-strip' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => setHover(null)}
    >
      {strip && <DifferenceStrip timeline={timeline} duration={duration} />}
      <div className="video-scrubber-track">
        {buffered.map(([start, end]) =>
          <div key={start} className="video-scrubber-buffered" style={{ left: percent(start), width: `calc(${percent(end)} - ${percent(start)})` }} />
        )}
        <div className="video-scrubber-played" style={{ width: percent(time) }} />
      </div>
      <div className="video-scrubber-thumb" style={{ left: percent(time) }} />
      {hover !== null && <div className="video-scrubber-hover" style={{ left: percent(hover) }}>
        {formatTime(hover)}{hover_frame !== null && (frameDuration || controller.times) ? ` · frame ${hover_frame}` : ''}
        {hover_frame !== null && timeline?.describe?.(hover_frame) && <div className="video-scrubber-detail">{timeline.describe(hover_frame)}</div>}
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
export const Transport = memo(({ controller, timeline, children }) => {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const disabled = !s.ready;
  const fps = s.frameDuration ? 1 / s.frameDuration : null;
  const fps_help = s.fpsSource === 'config'
    ? 'From qaboard.yaml.'
    : s.fpsSource === 'file'
    ? 'From the timestamps of the file\'s frames: frames are numbered as in the file.'
    : s.fpsSource === 'measured'
    ? 'Measured while playing. Set `fps` in qaboard.yaml if it\'s wrong.'
    : 'Unknown until the video plays or you step through frames. You can set `fps` in qaboard.yaml.';
  // the longest text, so that the timeline doesn't move
  const frame_width = `frame ${s.frames ?? 999} / ${s.frames ?? 999}`.length;
  return (
    <div className="video-transport">
      <Button
        icon={s.playing ? 'pause' : 'play'}
        label={s.playing ? 'Pause' : 'Play'}
        title={`${s.playing ? 'Pause' : 'Play'} (space)`}
        disabled={disabled}
        onClick={() => controller.toggle()}
      />
      <Button icon="step-backward" label="Previous frame" title="Previous frame (←)" disabled={disabled} onClick={() => controller.stepFrames(-1)} />
      <Button icon="step-forward" label="Next frame" title="Next frame (→)" disabled={disabled} onClick={() => controller.stepFrames(1)} />
      <Scrubber controller={controller} snapshot={s} timeline={timeline} />
      <span className="video-time" aria-label="Time">
        {formatTime(s.time)} <span className="qiv-muted">/ {formatTime(s.duration)}</span>
      </span>
      <span className="video-time" aria-label="Frame" style={{ minWidth: `${frame_width}ch` }} title={`Frame rate: ${fps ? formatFps(fps) : 'unknown'}. ${fps_help}`}>
        {s.frame !== null ? <>frame {s.frame}{s.frames ? <span className="qiv-muted"> / {s.frames}</span> : null}</> : <span className="qiv-muted">frame ?</span>}
      </span>
      {s.error && <span className="video-error-text" title={s.error}>Can't play: {s.error}</span>}
      <Select
        label="Speed"
        title="Speed (< and >)"
        value={s.rate}
        onChange={value => controller.setRate(Number(value))}
        options={RATES.map(rate => ({ value: rate, label: `${rate}×` }))}
      />
      <Button icon="repeat" active={s.loop} aria-pressed={s.loop} label="Loop" title="Loop" onClick={() => controller.setLoop(!s.loop)} />
      <Button
        icon={s.muted ? 'volume-off' : 'volume-up'}
        label={s.muted ? 'Unmute' : 'Mute'}
        title={`${s.muted ? 'Unmute' : 'Mute'} the new video (m)`}
        onClick={() => controller.setMuted(!s.muted)}
      />
      {children}
    </div>
  );
});
