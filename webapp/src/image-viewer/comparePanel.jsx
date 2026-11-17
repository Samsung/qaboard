// With more than two images: the pixel under the pointer in every image, and how far apart the images are.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { distanceMatrix, formatDistance, readCanvas } from './grid';
import { BaseToggle, ImageValues, PinnedTag, useImageValue, Values } from './panels';
import { Icon } from './ui';

// Viewers have no name: we number them, to tell React when the list changes
const ids = new WeakMap();
let next_id = 1;
const idOf = controller => {
  if (!controller) return 0;
  if (!ids.has(controller)) ids.set(controller, next_id++);
  return ids.get(controller);
};

// How far apart the views of the images are (grid.js): a matrix, by the images' indexes, computed once the viewers
// stop drawing. controllers: the viewer of each image, or null. Without `full`, only against the anchor.
export const useDistances = (controllers, { enabled, anchor, full }) => {
  const [matrix, setMatrix] = useState(null);
  const current = useRef(controllers);
  useEffect(() => {
    current.current = controllers;
  });
  const key = `${controllers.map(idOf).join()} ${anchor} ${full}`;
  useEffect(() => {
    if (!enabled) return;
    let timer = null;
    const compute = () => {
      timer = null;
      const list = current.current;
      // viewers that don't show the same region as the anchor (yet) would compare different places
      const reference = list[anchor]?.viewportOf('a');
      const follows = controller => {
        const viewport = controller.viewportOf('a');
        return !!viewport && !!reference && Math.abs(viewport.zoom - reference.zoom) < 1e-6 * reference.zoom
          && Math.abs(viewport.center.x - reference.center.x) < 1e-6 && Math.abs(viewport.center.y - reference.center.y) < 1e-6;
      };
      // ...and those still loading show nothing, or a blurry version
      const loaded = controller => {
        const { status, fullyLoaded } = controller.getSnapshot().a;
        return status === 'ready' && fullyLoaded;
      };
      const next = distanceMatrix(list.map(controller => controller && loaded(controller) && follows(controller) ? readCanvas(controller.canvas('a')) : null), full ? null : anchor);
      setMatrix(previous => previous?.key === key && JSON.stringify(previous.matrix) === JSON.stringify(next) ? previous : { key, matrix: next });
    };
    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(compute, 200);
    };
    schedule();
    const stops = current.current.filter(Boolean).flatMap(controller => [controller.onDraw(schedule), controller.subscribe(schedule)]);
    return () => {
      stops.forEach(stop => stop());
      if (timer !== null) clearTimeout(timer);
    };
    // oxlint-disable-next-line react/exhaustive-deps -- the key says which viewers, the anchor and whether all pairs
  }, [enabled, key]);
  // not the distances of other images, or with another anchor
  return enabled && matrix?.key === key ? matrix.matrix : null;
};

const Square = ({ entry, number }) => <span className="qiv-square" style={{ background: entry.color, color: entry.textColor }} title={entry.name}>{number}</span>;

// The values of an image's pixel, and how they differ from the anchor's
const ValueRow = ({ entry, number, point, tiles, base, anchorDisplay }) => {
  // It reads its viewer as it renders, like the readout
  'use no memo';
  const { controller, image, name } = entry;
  const [, redraw] = useState(0);
  useEffect(() => controller?.onDraw(() => redraw(n => n + 1)), [controller]);
  const pixel = controller && point ? controller.imagePixel('a', point) : null;
  const display = pixel ? controller.displayPixel('a', point) : null;
  const size = controller?.getSnapshot().a;
  const value = useImageValue(tiles, controller ? image : null, size, pixel);
  const delta = display && anchorDisplay && !entry.anchor ? [0, 1, 2].map(c => display[c] - anchorDisplay[c]) : null;
  return <div className="qiv-compare-row">
    <Square entry={entry} number={number} />
    {!controller ? <span className="qiv-muted">{name}: {image?.loading ? 'loading…' : 'no image'}</span>
      : !point ? <span className="qiv-muted">{name}{size?.width ? ` ${size.width}×${size.height}` : ''}</span>
      : <ImageValues label={name} intent="neutral" pixel={pixel} display={display} image={value} base={base} />}
    {entry.anchor && <span className="qiv-compare-anchor" title="The anchor: the other images are compared with it"><Icon icon="anchor" size={12} /></span>}
    {delta && <span className="qiv-readout-image qiv-compare-delta" title={`${name} − the anchor, as displayed`}>
      <span className="qiv-readout-label">Δ</span> <Values values={delta} signed />
    </span>}
  </div>;
};

// entries: [{ index, name, color, textColor, image, controller, anchor }], one per image, in order
// main: the anchor's viewer: it knows where the pointer is, in every tile
export const ComparePanel = ({ entries, main, tiles, base, onToggleBase, distances, onPair, unavailable }) => {
  'use no memo';
  const pointer = useSyncExternalStore(main.subscribePointer, main.getPointer);
  const [, redraw] = useState(0);
  useEffect(() => main.onDraw(() => redraw(n => n + 1)), [main]);
  // the values stay when the pointer leaves the images, e.g. to switch them to hexadecimal
  const [last, setLast] = useState(null);
  const hovering = pointer?.point ?? null;
  if (hovering && hovering !== last) setLast(hovering);
  const point = hovering ?? last;
  const anchor = entries.find(entry => entry.anchor);
  const anchor_pixel = point ? main.imagePixel('a', point) : null;
  const anchor_display = anchor_pixel ? main.displayPixel('a', point) : null;
  const pinned = !!pointer?.pinned;
  return <div className="qiv-compare">
    <div className={`qiv-compare-values ${hovering || !point ? '' : 'qiv-stale'}`}>
      <div className="qiv-compare-title">
        <span>Under the pointer</span>
        {anchor_pixel && <span className="qiv-coordinates">x {anchor_pixel.x} y {anchor_pixel.y}</span>}
        {pinned && <PinnedTag onUnpin={() => main.unpin()} />}
        {!point && <span className="qiv-muted">hover a pixel · click to pin it{unavailable && <> · <span className="qiv-warning-text">{unavailable}</span></>}</span>}
        {point && <BaseToggle base={base} onToggle={onToggleBase} />}
      </div>
      {entries.map((entry, i) => <ValueRow key={entry.index} entry={entry} number={i + 1} point={point} tiles={tiles} base={base} anchorDisplay={anchor_display} />)}
    </div>
    <div className="qiv-compare-distances">
      <div className="qiv-compare-title" title="The mean difference of the colors of the views, as displayed, in levels (0–255). It follows the zoom: zoom in to compare a detail.">
        <span>How far apart</span>
        <span className="qiv-muted">on screen, in levels (0–255) · click a pair to see it alone</span>
      </div>
      <table className="qiv-distances">
        <thead>
          <tr><td aria-label="Images" />{entries.map((entry, i) => <th key={entry.index} scope="col"><Square entry={entry} number={i + 1} /></th>)}</tr>
        </thead>
        <tbody>
          {entries.map((row, i) => <tr key={row.index}>
            <th scope="row"><Square entry={row} number={i + 1} /></th>
            {entries.map((column, j) => {
              // each pair once
              if (j <= i) return <td key={column.index} className="qiv-distance-self" aria-label={i === j ? 'The same image' : 'See above'} />;
              const value = distances?.[row.index]?.[column.index] ?? null;
              const can_pair = !!row.controller && !!column.controller;
              return <td key={column.index}>
                <button
                  type="button"
                  className={`qiv-distance ${value === 0 ? 'qiv-distance-same' : ''}`}
                  style={{ '--qiv-distance': value ? `${Math.min(100, Math.round(8 * value))}%` : '0%' }}
                  title={`${row.name} and ${column.name}${value === 0 ? ': the same in this view' : ''}. Click to compare them alone`}
                  disabled={!can_pair}
                  onClick={() => onPair(row.index, column.index)}
                >{formatDistance(value)}</button>
              </td>;
            })}
          </tr>)}
        </tbody>
      </table>
      {anchor && <span className="qiv-muted qiv-compare-hint">Click an image's name to compare the others with it.</span>}
    </div>
  </div>;
};
