// A screenshot of the web app, from website/media.json. See docs-media/README.md#shot.
// Props are literals in MDX (id="commit/flame-diff"), so the build can check them.
import React, {useState, type CSSProperties} from 'react';
import {Callout, CalloutMarkers, Caption, Picture, Placeholder, ZoomDialog, styles, useShot} from './media';

export type ShotProps = {
  id: string;
  /** Overrides the manifest caption; '' hides it */
  caption?: string;
  /** Overrides the manifest alt (rare) */
  alt?: string;
  callouts?: Callout[];
  /** CSS px; default and maximum: the manifest width (never upscaled) */
  maxWidth?: number;
  /** Eager load + fetchpriority="high" (the LCP image); default lazy */
  priority?: boolean;
  /** Click opens the full-size image in a dialog; default true */
  zoom?: boolean;
};

export default function Shot({id, caption, alt, callouts = [], maxWidth, priority = false, zoom = true}: ShotProps) {
  const shot = useShot(id);
  const [zoomed, setZoomed] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  if (shot.status !== 'published' || unavailable) {
    const planned = shot.status === 'planned' ? shot.planned : null;
    return (
      <figure className={styles.figure} style={maxWidth ? {maxWidth} : undefined}>
        <Placeholder shots={[shot]} kind="still" unavailable={unavailable} />
        <Caption caption={caption ?? (shot.status === 'published' ? shot.entry.caption : planned?.caption)} callouts={callouts} />
      </figure>
    );
  }
  const {entry, url} = shot;
  const altText = alt ?? entry.alt;
  const open = () => zoom && setZoomed(true);
  return (
    <figure className={styles.figure} style={{maxWidth: Math.min(maxWidth ?? entry.width, entry.width)}}>
      <div className={styles.frame} onClick={zoom ? open : undefined} data-zoom={zoom || undefined}>
        <Picture entry={entry} url={url} alt={altText} priority={priority} onError={() => setUnavailable(true)} />
        <CalloutMarkers callouts={callouts} anchors={entry.anchors} />
        {zoom && (
          <button
            type="button"
            className={styles.zoomButton}
            aria-label="Enlarge image"
            aria-haspopup="dialog"
            onClick={event => {
              event.stopPropagation();
              open();
            }}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
      <Caption caption={caption ?? entry.caption} callouts={callouts} />
      {zoom && (
        <ZoomDialog open={zoomed} onClose={() => setZoomed(false)} label={altText}>
          <div
            className={styles.dialogFrame}
            style={{aspectRatio: `${entry.width} / ${entry.height}`, '--qbm-ratio': entry.width / entry.height} as CSSProperties}>
            <Picture entry={entry} url={url} alt={altText} lazy={false} className={styles.dialogImage} />
            <CalloutMarkers callouts={callouts} anchors={entry.anchors} />
          </div>
        </ZoomDialog>
      )}
    </figure>
  );
}
