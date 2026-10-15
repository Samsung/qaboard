// Shared by <Shot>, <Clip> and <Compare>: the media data from website/plugins/media, pictures, placeholders,
// call-outs and captions. See docs-media/README.md#website-components-spec-ws4-implements.
import React, {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import clsx from 'clsx';
import useGlobalData from '@docusaurus/useGlobalData';
import {useBaseUrlUtils} from '@docusaurus/useBaseUrl';
import styles from './media.module.css';

export type Kind = 'still' | 'clip' | 'tape';
export type Box = {x: number; y: number; w: number; h: number};
export type MediaFiles = Partial<Record<'avif' | 'webp' | 'png' | 'mp4' | 'webm' | 'poster' | 'vtt', string>>;
export type MediaEntry = {
  kind: Kind;
  width: number;
  height: number;
  lqip: string;
  alt: string;
  caption?: string;
  duration?: number;
  anchors?: Record<string, Box>;
  files: MediaFiles;
  /** The same shot in the web app's dark theme, shown in the docs' dark mode */
  dark?: {lqip: string; files: MediaFiles};
};
export type PlannedEntry = {kind?: Kind; shows: string; width?: number; height?: number; caption?: string};
type MediaData = {
  mode: 'local' | 'remote' | 'placeholder';
  base: string | null;
  shots: Record<string, MediaEntry>;
  planned: Record<string, PlannedEntry>;
  // QABOARD_MEDIA_MISSING=remote: shots the build couldn't download, loaded from remoteBase
  remoteBase?: string | null;
  remoteShots?: string[];
};

export type Callout = {
  /** A name recorded by ui.anchor() in the shot's spec; or give x/y */
  anchor?: string;
  /** % of the image width/height, top-left origin */
  x?: number;
  y?: number;
  /** % size, for kind 'box' */
  w?: number;
  h?: number;
  /** Default: 'dot' for x/y, 'box' for an anchor */
  kind?: 'dot' | 'box';
  /** Plain text, listed under the image */
  label?: string;
};

export type ShotState =
  | {status: 'published'; id: string; entry: MediaEntry; url: (key: string) => string; remote: boolean}
  | {status: 'planned'; id: string; planned: PlannedEntry}
  | {status: 'unknown'; id: string};

const EMPTY: MediaData = {mode: 'placeholder', base: null, shots: {}, planned: {}};

function useMediaData(): MediaData {
  const data = useGlobalData()['qaboard-media']?.default as MediaData | undefined;
  return data ?? EMPTY;
}

/** What the docs know about a shot id: published (with its files' URLs), planned, or unknown. */
export function useShot(id: string): ShotState {
  const data = useMediaData();
  const {withBaseUrl} = useBaseUrlUtils();
  const fallback = !!data.remoteBase && !!data.remoteShots?.includes(id);
  const base = fallback ? data.remoteBase : data.base;
  const url = useCallback((key: string) => withBaseUrl(`${base}${key}`), [withBaseUrl, base]);
  const entry = data.shots[id];
  if (entry && base !== null)
    return {status: 'published', id, entry, url, remote: data.mode === 'remote' || fallback};
  const planned = data.planned[id];
  return planned ? {status: 'planned', id, planned} : {status: 'unknown', id};
}

const PLANNED_LABEL: Record<Kind, string> = {
  still: 'Screenshot not captured yet',
  clip: 'Clip not recorded yet',
  tape: 'Terminal recording not recorded yet',
};

const UNAVAILABLE_LABEL: Record<Kind, string> = {
  still: 'Screenshot unavailable',
  clip: 'Clip unavailable',
  tape: 'Terminal recording unavailable',
};

/**
 * The box shown until a shot is published: the planned aspect ratio, what it will show, and its id.
 * `unavailable`: the shot is published, but the browser couldn't load it (e.g. a proxy blocks the media host).
 */
export function Placeholder({shots, kind = 'still', unavailable = false}: {shots: ShotState[]; kind?: Kind; unavailable?: boolean}) {
  const known = shots.map(s => (s.status === 'planned' ? s.planned : s.status === 'published' ? {kind: s.entry.kind, shows: s.entry.alt} : null));
  // The planned size when it's known (e.g. the published half of a <Compare>), else 16:10
  const sized = shots.map(s => (s.status === 'published' ? s.entry : s.status === 'planned' ? s.planned : null)).find(s => s?.width);
  const width = sized?.width ?? 16;
  const height = sized?.height ?? 10;
  const unknown = shots.filter(s => s.status === 'unknown');
  // With `yarn start`, a typo shows here instead of stopping the server. Builds fail before.
  const isError = unknown.length > 0 && process.env.NODE_ENV === 'development';
  const label = (unavailable ? UNAVAILABLE_LABEL : PLANNED_LABEL)[known.find(k => k?.kind)?.kind ?? kind];
  const shows = known.map(k => k?.shows).filter(Boolean).join(' / ');
  return (
    <div
      className={clsx(styles.placeholder, isError && styles.placeholderError)}
      style={{aspectRatio: `${width} / ${height}`}}
      role="img"
      aria-label={`${label}${shows ? `: ${shows}` : ''}`}>
      <div className={styles.placeholderBody} aria-hidden="true">
        <span className={styles.placeholderLabel}>{isError ? 'Unknown shot id' : label}</span>
        {isError ? (
          <p className={styles.placeholderShows}>
            Add it to <code>docs-media/shots.yaml</code>, or fix the typo: it&apos;s not in{' '}
            <code>website/media.json</code> either.
          </p>
        ) : (
          shows && <p className={styles.placeholderShows}>{shows}</p>
        )}
        <span className={styles.placeholderIds}>
          {shots.map(s => (
            <code key={s.id}>{s.id}</code>
          ))}
        </span>
      </div>
    </div>
  );
}

type PictureProps = {
  entry: MediaEntry;
  url: (key: string) => string;
  alt: string;
  priority?: boolean;
  className?: string;
  lazy?: boolean;
  /** The browser couldn't load the image */
  onError?: () => void;
};

/**
 * <picture> with AVIF and WebP sources, its intrinsic size (no layout shift), and the LQIP until it loads.
 * With a dark variant, both are in the page and CSS shows the one of the docs' color mode: no flash after hydration,
 * and the browser doesn't fetch the hidden one (lazy images in display: none). Eager images load both.
 */
export function Picture(props: PictureProps) {
  const {dark} = props.entry;
  if (!dark)
    return <OnePicture {...props} files={props.entry.files} lqip={props.entry.lqip} />;
  return (
    <>
      <OnePicture {...props} files={props.entry.files} lqip={props.entry.lqip} variant={styles.lightOnly} />
      <OnePicture {...props} files={dark.files} lqip={dark.lqip} variant={styles.darkOnly} />
    </>
  );
}

function OnePicture({entry, files, lqip, variant, url, alt, priority = false, className, lazy = true, onError}: PictureProps & {
  files: MediaFiles;
  lqip: string;
  /** Shown in one color mode only */
  variant?: string;
}) {
  const ref = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  // The image may have loaded, or failed, before hydration, when React wasn't listening yet
  useEffect(() => {
    if (ref.current?.complete && ref.current.naturalWidth > 0)
      setLoaded(true);
    else if (ref.current?.complete && ref.current.currentSrc)
      onError?.();
  }, []);
  const fallback = files.webp ?? files.png ?? files.avif;
  return (
    <picture className={variant}>
      {files.avif && <source type="image/avif" srcSet={url(files.avif)} />}
      {files.webp && <source type="image/webp" srcSet={url(files.webp)} />}
      <img
        ref={ref}
        className={clsx(styles.image, className)}
        src={fallback && url(fallback)}
        alt={alt}
        width={entry.width}
        height={entry.height}
        loading={priority || !lazy ? 'eager' : 'lazy'}
        decoding="async"
        fetchPriority={priority ? 'high' : undefined}
        onLoad={() => setLoaded(true)}
        onError={onError}
        style={loaded || !lqip ? undefined : {backgroundImage: `url("${lqip}")`}}
      />
    </picture>
  );
}

type Marker = {n: number; kind: 'dot' | 'box'; x: number; y: number; w?: number; h?: number};

function markersOf(callouts: Callout[], anchors: Record<string, Box> = {}): Marker[] {
  return callouts.flatMap((callout, index): Marker[] => {
    const n = index + 1;
    if (callout.anchor) {
      const box = anchors[callout.anchor];
      if (!box)
        return [];
      return (callout.kind ?? 'box') === 'box'
        ? [{n, kind: 'box', ...box}]
        : [{n, kind: 'dot', x: box.x + box.w / 2, y: box.y + box.h / 2}];
    }
    if (callout.x === undefined || callout.y === undefined)
      return [];
    const kind = callout.kind ?? 'dot';
    if (kind === 'box' && callout.w !== undefined && callout.h !== undefined)
      return [{n, kind, x: callout.x, y: callout.y, w: callout.w, h: callout.h}];
    return [{n, kind: 'dot', x: callout.x, y: callout.y}];
  });
}

// A box's number goes outside it, so it doesn't hide what the box points at: on its left, else above it
function badgeSide(m: Marker) {
  if (m.x >= 3.5)
    return styles.badgeLeft;
  return m.y >= 5 ? styles.badgeTop : styles.badgeInside;
}

/** Numbered markers over the image, scaled with it. Hidden from screen readers: the labels are in the caption. */
export function CalloutMarkers({callouts, anchors}: {callouts: Callout[]; anchors?: Record<string, Box>}) {
  const markers = markersOf(callouts, anchors);
  if (!markers.length)
    return null;
  return (
    <div className={styles.markers} aria-hidden="true">
      {markers.map(m =>
        m.kind === 'box' ? (
          <div key={m.n} className={styles.markerBox} style={{left: `${m.x}%`, top: `${m.y}%`, width: `${m.w}%`, height: `${m.h}%`}}>
            <span className={clsx(styles.badge, badgeSide(m))}>{m.n}</span>
          </div>
        ) : (
          <span key={m.n} className={clsx(styles.badge, styles.badgeDot)} style={{left: `${m.x}%`, top: `${m.y}%`}}>
            {m.n}
          </span>
        ),
      )}
    </div>
  );
}

/** The caption, then the call-outs' labels as an ordered list, numbered like the markers. */
export function Caption({caption, callouts = []}: {caption?: ReactNode; callouts?: Callout[]}) {
  const labeled = callouts.map((c, i) => ({n: i + 1, label: c.label})).filter(c => c.label);
  if (!caption && !labeled.length)
    return null;
  return (
    <figcaption className={styles.caption}>
      {caption && <span>{caption}</span>}
      {labeled.length > 0 && (
        <ol className={styles.calloutList} role="list">
          {labeled.map(({n, label}) => (
            <li key={n} value={n}>
              <span className={styles.badge} aria-hidden="true">
                {n}
              </span>
              {label}
            </li>
          ))}
        </ol>
      )}
    </figcaption>
  );
}

/** A modal <dialog> with the image at the largest size that fits the window. */
export function ZoomDialog({open, onClose, children, label}: {open: boolean; onClose: () => void; children: ReactNode; label: string}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog)
      return;
    if (open && !dialog.open)
      dialog.showModal();
    if (!open && dialog.open)
      dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-label={label}
      onClose={onClose}
      onClick={event => {
        // A click on the backdrop, or on the image, closes it
        if (event.target === ref.current || (event.target as HTMLElement).tagName === 'IMG')
          onClose();
      }}>
      {open && (
        <div className={styles.dialogBody}>
          {children}
          <button type="button" className={styles.dialogClose} onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
    </dialog>
  );
}

export {styles};
