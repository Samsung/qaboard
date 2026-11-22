// A sound as a row, for grids of many (logged media): play, A/B, and a waveform with the new track above the axis and
// the reference's below, what's heard in full color. It decodes the files once scrolled to, plays at matched loudness,
// and starting one pauses the others. Expands into the full viewer (AudioViewer.jsx).
import { useEffect, useRef } from 'react';
import { Button, Classes, Intent } from '@blueprintjs/core';

import './audio.css';
import { useDark, usePlayback, useSeen, useTrack, useWidth } from './hooks';
import { drawSplitWaveform } from './draw';
import { formatGain, formatTime } from './format';
import { colorOf, describe, nameOf } from './sides';

// - src, src_ref, labels, caption, onError, version, version_ref, live: like the full viewer's
// - height: of the waveform, in pixels
// - onExpand: what the expand button does
export const CompactAudioViewer = ({ src, src_ref, labels, caption, height = 36, onError, onExpand, version, version_ref, live }) => {
  const root = useRef(null);
  const dark = useDark(root);
  const [row, seen] = useSeen();
  const [lane, width] = useWidth(240);
  const loaded_new = useTrack(src, { onError, enabled: seen, version, live });
  const loaded_ref = useTrack(src_ref, { enabled: seen, version: version_ref, live });
  const track_new = loaded_new.track, track_ref = loaded_ref.track;
  const playback = usePlayback({ new: track_new, reference: track_ref }, { match_loudness: true });
  const { duration, time, heard, playing } = playback;
  const ready = !!track_new && loaded_ref.status !== 'loading';

  const canvas = useRef(null);
  const color_new = colorOf(labels, 'new', dark), color_ref = colorOf(labels, 'reference', dark);
  useEffect(() => {
    if (!canvas.current || !track_new) return;
    const alpha = side => track_ref && heard !== side ? 0.4 : 1;
    drawSplitWaveform(canvas.current, [
      { track: track_new, color: color_new, alpha: alpha('new') },
      track_ref && { track: track_ref, color: color_ref, alpha: alpha('reference') },
    ].filter(Boolean), { width, height, start: 0, end: duration, axis_color: dark ? 'rgba(255, 255, 255, 0.14)' : 'rgba(17, 20, 24, 0.14)' });
  }, [track_new, track_ref, heard, width, height, duration, dark, color_new, color_ref]);

  const onKeyDown = event => {
    if (!ready || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target !== event.currentTarget && event.target.closest?.('button') && [' ', 'Enter'].includes(event.key)) return;
    const actions = {
      ' ': playback.toggle,
      a: () => playback.hear('new'),
      b: () => playback.hear('reference'),
      x: () => playback.hear(heard === 'new' ? 'reference' : 'new'),
      ArrowLeft: () => playback.seek(time - (event.shiftKey ? 5 : 1)),
      ArrowRight: () => playback.seek(time + (event.shiftKey ? 5 : 1)),
      0: () => playback.seek(0),
    };
    const action = actions[event.key.length === 1 ? event.key.toLowerCase() : event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };
  const seekAt = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    playback.seek(Math.max(0, Math.min(1, (event.clientX - rect.left) / (rect.width || 1))) * duration);
  };

  const name_new = nameOf(labels, 'new'), name_ref = nameOf(labels, 'reference');
  const ab = side => {
    const gain = playback.gains[side];
    const name = side === 'new' ? name_new : name_ref;
    return <Button
      size="small" variant="minimal" className="qa-audio-ab" active={heard === side} aria-pressed={heard === side} disabled={!ready}
      style={{ '--qa-audio-color': side === 'new' ? color_new : color_ref }}
      aria-label={`Hear ${name}`}
      title={`${name}${gain ? `, played ${formatGain(gain)} to match loudness` : ''} (${side === 'new' ? 'A' : 'B'})`}
      onClick={() => playback.hear(side)}
    >{side === 'new' ? 'A' : 'B'}</Button>;
  };

  // the keys of its buttons and of the waveform bubble here
  // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- see above
  return <div
    className="qa-audio qa-audio-compact" ref={element => { root.current = element; row(element); }}
    role="group" aria-label={`Audio: ${caption ?? name_new}`} onKeyDown={onKeyDown}
  >
    <div className="qa-audio-compact-row">
      <Button
        icon={playing ? 'pause' : 'play'} intent={Intent.PRIMARY} variant="minimal" size="small" disabled={!ready}
        aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={playback.toggle}
      />
      {src_ref && <span className="qa-audio-ab-group" role="group" aria-label="What you hear">{ab('new')}{ab('reference')}</span>}
      <div
        ref={lane} className="qa-audio-compact-lane" style={{ height }}
        title={track_new ? describe(track_new) : undefined}
        onPointerDown={event => ready && seekAt(event)}
      >
        {track_new && <canvas ref={canvas} className="qa-audio-canvas" style={{ height }} aria-hidden="true"/>}
        {!track_new && loaded_new.status !== 'error' && <div className={`qa-audio-placeholder ${Classes.SKELETON}`}/>}
        {loaded_new.status === 'error' && <>
          {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- files that runs wrote have no captions */}
          <audio controls preload="none" src={src} aria-label={`Play ${name_new}`} className="qa-audio-compact-fallback"/>
        </>}
        {track_new && <div className="qa-audio-playhead" style={{ left: `${duration ? time / duration * 100 : 0}%` }}/>}
      </div>
      <span className="qa-audio-time qa-audio-compact-time">{track_new ? formatTime(playing || time ? time : duration, 1) : ''}</span>
      <Button icon="maximize" size="small" variant="minimal" aria-label="Expand" title="Open in the full viewer" onClick={onExpand}/>
    </div>
    {caption && <div className="qa-audio-compact-caption" title={caption}>{caption}</div>}
  </div>;
};
