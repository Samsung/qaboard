// What the full and compact audio viewers share: loading tracks, the page's theme and layout, and playback
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Classes } from '@blueprintjs/core';

import { cachedTrack } from './tracks';
import { createPlayer } from './player';
import { matchingGains } from './dsp';

// src => { status: none | loading | ready | error, track, error }. Nothing is loaded until `enabled`.
export function useTrack(src, { onError, enabled = true } = {}) {
  const [state, setState] = useState({});
  // not a dependency: an inline callback would load the file again on every render
  const callback = useRef(onError);
  useEffect(() => { callback.current = onError; });
  useEffect(() => {
    if (!src || !enabled) return undefined;
    let current = true;
    cachedTrack(src).then(
      track => current && setState({ src, track }),
      error => {
        if (!current) return;
        setState({ src, error });
        callback.current?.(error);
      });
    return () => { current = false; };
  }, [src, enabled]);
  if (!src) return { status: 'none' };
  if (state.src !== src) return { status: 'loading' };
  return state.error ? { status: 'error', error: state.error } : { status: 'ready', track: state.track };
}

// whether the viewer is in Blueprint's dark theme, a class on an ancestor
export function useDark(ref) {
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

// [ref callback, width of the element, the element]
export function useWidth(fallback = 600) {
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
  return [setElement, width || fallback, element];
}

// [ref callback, whether the element was ever near the screen]: grids of sounds decode what's scrolled to
export function useSeen() {
  const [element, setElement] = useState(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (!element || seen) return undefined;
    const observer = new IntersectionObserver(entries => entries.some(e => e.isIntersecting) && setSeen(true), { rootMargin: '200px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, seen]);
  return [setElement, seen];
}

// Playback of { new, reference, difference } tracks: what's heard, where, at what volume, matched loudness, a loop.
// Changing the tracks (e.g. showing the difference) keeps the position, and pauses.
export function usePlayback(tracks, { match_loudness = false } = {}) {
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [heard_, setHeard] = useState('new');
  const [volume, setVolume] = useState(1);
  const [loop, setLoop] = useState(null);
  const [error, setError] = useState(null);
  const { new: track_new, reference: track_ref, difference: track_diff } = tracks;

  // the gains that bring new and reference to the same loudness
  const [gain_new, gain_ref] = match_loudness && track_new && track_ref ? matchingGains([track_new.loudness, track_ref.loudness]) : [0, 0];

  const player = useRef(null);
  const state = useRef({});
  useEffect(() => { state.current = { time, heard: heard_, volume, loop, gain_new, gain_ref }; });
  useEffect(() => {
    if (!track_new) return undefined;
    const created = createPlayer({ new: track_new, reference: track_ref, difference: track_diff });
    const { time: t = 0, heard: h, volume: v = 1, loop: l = null, gain_new: g_new = 0, gain_ref: g_ref = 0 } = state.current;
    created.seek(t);
    created.hear(h);
    created.setVolume(v);
    created.setLoop(l);
    created.setTrims({ new: g_new, reference: g_ref });
    player.current = created;
    return () => {
      created.dispose();
      player.current = null;
      setPlaying(false);
    };
  }, [track_new, track_ref, track_diff]);
  useEffect(() => { player.current?.setTrims({ new: gain_new, reference: gain_ref }); }, [gain_new, gain_ref]);

  // the playhead follows the player. It stops when another player starts.
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

  const duration = Math.max(0, ...[track_new, track_ref, track_diff].filter(Boolean).map(t => t.duration));
  const play = () => {
    const p = player.current;
    if (!p) return;
    setError(null);
    p.play().catch(e => {
      setPlaying(false);
      setError(e);
    });
    setPlaying(true);
  };
  const pause = () => {
    player.current?.pause();
    setPlaying(false);
    if (player.current) setTime(player.current.time());
  };
  return {
    playing, time, volume, loop, error, duration, gains: { new: gain_new, reference: gain_ref },
    // what's heard, if it's still there
    heard: tracks[heard_] ? heard_ : 'new',
    play, pause,
    toggle: () => playing ? pause() : play(),
    hear: side => {
      if (!tracks[side]) return;
      player.current?.hear(side);
      setHeard(side);
    },
    seek: t => {
      const clamped = Math.max(0, Math.min(duration, t));
      player.current?.seek(clamped);
      setTime(clamped);
    },
    setVolume: value => {
      player.current?.setVolume(value);
      setVolume(value);
    },
    setLoop: region => {
      player.current?.setLoop(region);
      setLoop(region);
    },
  };
}
