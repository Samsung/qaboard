// A short silent clip of the web app, or a terminal recording, from website/media.json. See docs-media/README.md#clip.
// Plays when at least half visible, never with prefers-reduced-motion; a pause/play button is always visible.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import clsx from 'clsx';
import Head from '@docusaurus/Head';
import {useColorMode} from '@docusaurus/theme-common';
import {Caption, MediaEntry, Placeholder, styles, useShot} from './media';

export type ClipProps = {
  /** A shot of kind 'clip' or 'tape' */
  id: string;
  caption?: string;
  alt?: string;
  maxWidth?: number;
  priority?: boolean;
  /** Default 'inview' */
  autoplay?: 'inview' | 'never';
  /** Default true */
  loop?: boolean;
};

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(REDUCED_MOTION);
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

const cueText = (cue: TextTrackCue) => ((cue as VTTCue).text ?? '').replace(/<[^>]+>/g, '');

function Player({entry, url, remote, alt, priority, autoplay, loop, onError}: {
  entry: MediaEntry;
  url: (key: string) => string;
  remote: boolean;
  /** The browser couldn't load any of the video's sources */
  onError: () => void;
  alt: string;
  priority: boolean;
  autoplay: 'inview' | 'never';
  loop: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<HTMLTrackElement>(null);
  const [playing, setPlaying] = useState(false);
  // The poster is usually the last frame: the captions show once the clip has started
  const [started, setStarted] = useState(false);
  const [cue, setCue] = useState('');
  // Without JavaScript, the browser's controls are the only way to play
  const [hydrated, setHydrated] = useState(false);
  const userPaused = useRef(false);
  const inView = useRef(false);
  const reducedMotion = useReducedMotion();
  const canAutoplay = autoplay === 'inview' && !reducedMotion;

  useEffect(() => setHydrated(true), []);

  // The sources may have failed before hydration, when React wasn't listening yet. A video React just created (a tab
  // switch, a client-side navigation) is NETWORK_NO_SOURCE too, until the browser has looked at its sources, which it
  // does once the current task ends: check after that
  useEffect(() => {
    const timer = setTimeout(() => {
      if (video.current?.networkState === HTMLMediaElement.NETWORK_NO_SOURCE)
        onError();
    });
    return () => clearTimeout(timer);
  }, []);

  const play = useCallback(() => {
    const v = video.current;
    if (v) {
      v.muted = true;
      v.play().catch(() => setPlaying(false));
    }
  }, []);

  // Autoplay while at least half visible, unless the reader paused it
  useEffect(() => {
    const v = video.current;
    if (!v || typeof IntersectionObserver === 'undefined')
      return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        inView.current = entry.intersectionRatio >= 0.5;
        if (inView.current && canAutoplay && !userPaused.current)
          play();
        else if (!inView.current && !v.paused)
          v.pause();
      },
      {threshold: [0, 0.5]},
    );
    observer.observe(v);
    return () => observer.disconnect();
  }, [canAutoplay, play]);

  useEffect(() => {
    if (reducedMotion && !userPaused.current)
      video.current?.pause();
  }, [reducedMotion]);

  // The captions are drawn over the video, not by the browser, so they look the same everywhere
  useEffect(() => {
    const textTrack = track.current?.track;
    if (!textTrack)
      return;
    textTrack.mode = 'hidden';
    const onCueChange = () => setCue(Array.from(textTrack.activeCues ?? []).map(cueText).join('\n'));
    textTrack.addEventListener('cuechange', onCueChange);
    return () => textTrack.removeEventListener('cuechange', onCueChange);
  }, []);

  const toggle = () => {
    const v = video.current;
    if (!v)
      return;
    if (v.paused) {
      userPaused.current = false;
      play();
    } else {
      userPaused.current = true;
      v.pause();
    }
  };

  const {files} = entry;
  const poster = files.poster && url(files.poster);
  return (
    <div className={clsx(styles.frame, styles.videoFrame)}>
      {priority && poster && (
        <Head>
          <link rel="preload" as="image" href={poster} fetchPriority="high" />
        </Head>
      )}
      <video
        ref={video}
        className={styles.video}
        width={entry.width}
        height={entry.height}
        poster={poster}
        // With `yarn start`, media come from the bucket: its CORS headers let the captions track load
        crossOrigin={remote ? 'anonymous' : undefined}
        preload={priority ? 'metadata' : 'none'}
        muted
        playsInline
        loop={loop}
        controls={!hydrated}
        tabIndex={0}
        aria-label={alt}
        onPlay={() => {
          setPlaying(true);
          setStarted(true);
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onClick={toggle}
        onKeyDown={event => {
          if (event.key === ' ' || event.key === 'Enter' || event.key === 'k') {
            event.preventDefault();
            toggle();
          }
        }}>
        {/* The browser tries the sources in order: the last one's error means none could play */}
        {files.webm && <source src={url(files.webm)} type="video/webm" onError={files.mp4 ? undefined : onError} />}
        {files.mp4 && <source src={url(files.mp4)} type="video/mp4" onError={onError} />}
        {files.vtt && <track ref={track} kind="captions" src={url(files.vtt)} srcLang="en" label="English" default />}
      </video>
      {started && cue && (
        <div className={styles.cue} aria-hidden="true">
          <span>{cue}</span>
        </div>
      )}
      {hydrated && !playing && (
        <span className={styles.bigPlay} aria-hidden="true" onClick={toggle}>
          <svg viewBox="0 0 24 24" width="30" height="30">
            <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
          </svg>
        </span>
      )}
      {hydrated && (
        <button type="button" className={styles.playButton} onClick={toggle} aria-label={playing ? 'Pause the clip' : 'Play the clip'}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            {playing ? <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" /> : <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />}
          </svg>
        </button>
      )}
    </div>
  );
}

export default function Clip({id, caption, alt, maxWidth, priority = false, autoplay = 'inview', loop = true}: ClipProps) {
  const shot = useShot(id);
  const [unavailable, setUnavailable] = useState(false);
  // In the docs' dark mode, the dark variant (pages are rendered in light mode, then hydrated): a new player loads it
  const {colorMode} = useColorMode();
  if (shot.status !== 'published' || unavailable) {
    const planned = shot.status === 'planned' ? shot.planned : null;
    return (
      <figure className={styles.figure} style={maxWidth ? {maxWidth} : undefined}>
        <Placeholder shots={[shot]} kind={shot.status === 'published' ? shot.entry.kind : 'clip'} unavailable={unavailable} />
        <Caption caption={caption ?? (shot.status === 'published' ? shot.entry.caption : planned?.caption)} />
      </figure>
    );
  }
  const {url, remote} = shot;
  const dark = colorMode === 'dark' && !!shot.entry.dark;
  const entry = dark ? {...shot.entry, ...shot.entry.dark!} : shot.entry;
  const isTape = entry.kind === 'tape';
  const width = Math.min(maxWidth ?? entry.width, entry.width);
  const player = <Player key={dark ? 'dark' : 'light'} entry={entry} url={url} remote={remote} alt={alt ?? entry.alt} priority={priority} autoplay={autoplay} loop={loop} onError={() => setUnavailable(true)} />;
  return (
    <figure className={styles.figure} style={{maxWidth: isTape ? `calc(${width}px + 2 * var(--qbm-tape-padding))` : width}}>
      {isTape ? (
        <div className={styles.terminal}>
          <div className={styles.terminalBar} aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          {player}
        </div>
      ) : (
        player
      )}
      <Caption caption={caption ?? entry.caption} />
    </figure>
  );
}
