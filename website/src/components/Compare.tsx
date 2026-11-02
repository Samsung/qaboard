// Two screenshots of the same size, stacked, with a divider to drag between them. See docs-media/README.md#compare.
import React, {useRef, useState, type KeyboardEvent, type PointerEvent} from 'react';
import clsx from 'clsx';
import {Caption, MediaEntry, Picture, Placeholder, styles, useShot} from './media';

export type CompareProps = {
  /** Two still ids with the same width and height (build check) */
  before: string;
  after: string;
  /** Default 'Before' */
  beforeLabel?: string;
  /** Default 'After' */
  afterLabel?: string;
  /** Initial divider position in %, default 50 */
  position?: number;
  /** Default 'horizontal' (the divider moves left-right) */
  orientation?: 'horizontal' | 'vertical';
  caption?: string;
  maxWidth?: number;
};

const clamp = (value: number) => Math.min(100, Math.max(0, value));

function Slider({before, after, beforeUrl, afterUrl, onError, beforeLabel, afterLabel, initial, vertical}: {
  before: MediaEntry;
  after: MediaEntry;
  beforeUrl: (key: string) => string;
  afterUrl: (key: string) => string;
  onError: () => void;
  beforeLabel: string;
  afterLabel: string;
  initial: number;
  vertical: boolean;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(clamp(initial));
  const [dragging, setDragging] = useState(false);

  const moveTo = (event: PointerEvent) => {
    const box = stage.current?.getBoundingClientRect();
    if (box)
      setPosition(clamp(vertical ? ((event.clientY - box.top) / box.height) * 100 : ((event.clientX - box.left) / box.width) * 100));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0)
      return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    moveTo(event);
    // Keyboard users continue from where they clicked
    handle.current?.focus({preventScroll: true});
    event.preventDefault();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // The position is from the left (or the top): right (or down, when vertical) increases it
    const steps: Record<string, (p: number) => number> = {
      ArrowLeft: p => p - 1, ArrowRight: p => p + 1,
      ArrowUp: vertical ? p => p - 1 : p => p + 1, ArrowDown: vertical ? p => p + 1 : p => p - 1,
      PageDown: p => p - 10, PageUp: p => p + 10, Home: () => 0, End: () => 100,
    };
    const step = steps[event.key];
    if (step) {
      event.preventDefault();
      setPosition(p => clamp(Math.round(step(p))));
    }
  };

  const clip = vertical ? `inset(${position}% 0 0 0)` : `inset(0 0 0 ${position}%)`;
  const at = vertical ? {top: `${position}%`} : {left: `${position}%`};
  return (
    <div
      ref={stage}
      className={clsx(styles.frame, styles.compare, vertical ? styles.compareVertical : styles.compareHorizontal, dragging && styles.dragging)}
      onPointerDown={onPointerDown}
      onPointerMove={event => dragging && moveTo(event)}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}>
      <Picture entry={before} url={beforeUrl} alt={before.alt} onError={onError} />
      <div className={styles.compareAfter} style={{clipPath: clip}}>
        <Picture entry={after} url={afterUrl} alt={after.alt} onError={onError} />
      </div>
      <span className={clsx(styles.compareLabel, styles.compareLabelBefore)} aria-hidden="true">{beforeLabel}</span>
      <span className={clsx(styles.compareLabel, vertical ? styles.compareLabelAfterVertical : styles.compareLabelAfter)} aria-hidden="true">{afterLabel}</span>
      <div
        ref={handle}
        className={styles.divider}
        style={at}
        role="slider"
        tabIndex={0}
        aria-label={`Divider between ${beforeLabel} and ${afterLabel}`}
        aria-orientation={vertical ? 'vertical' : 'horizontal'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(position)}
        aria-valuetext={`${Math.round(position)}%: ${beforeLabel} ${vertical ? 'above' : 'on the left'}, ${afterLabel} ${vertical ? 'below' : 'on the right'}`}
        onKeyDown={onKeyDown}>
        <span className={styles.dividerHandle} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </div>
    </div>
  );
}

export default function Compare({
  before, after, beforeLabel = 'Before', afterLabel = 'After', position = 50, orientation = 'horizontal', caption, maxWidth,
}: CompareProps) {
  const shots = [useShot(before), useShot(after)];
  const [a, b] = shots;
  const [unavailable, setUnavailable] = useState(false);
  if (a.status !== 'published' || b.status !== 'published' || unavailable) {
    return (
      <figure className={styles.figure} style={maxWidth ? {maxWidth} : undefined}>
        <Placeholder shots={shots} kind="still" unavailable={unavailable} />
        <Caption caption={caption} />
      </figure>
    );
  }
  const width = Math.min(maxWidth ?? a.entry.width, a.entry.width);
  return (
    <figure className={styles.figure} style={{maxWidth: width}}>
      <Slider
        before={a.entry}
        after={b.entry}
        beforeUrl={a.url}
        afterUrl={b.url}
        onError={() => setUnavailable(true)}
        beforeLabel={beforeLabel}
        afterLabel={afterLabel}
        initial={position}
        vertical={orientation === 'vertical'}
      />
      <Caption caption={caption ?? b.entry.caption} />
    </figure>
  );
}
