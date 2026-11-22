// The images a key logged at a step: thumbnails in a grid, each over the reference's same sample (matched by id, else
// caption, else position), with their boxes. Clicking one opens it in the image viewer, under its row. Slots take their
// size from the images' width and height, so that the grid doesn't move as steps change.
import { Fragment, useState } from "react";
import { Button, Classes, Tooltip } from "@blueprintjs/core";

import { useMediaContext } from "./context";
import { LABEL_TEXT_COLOR, boxInPixels, boxLabel, filterBoxes, labelColor, matchItem, sampleKeys, validBoxes } from "./media";

const SHOWN_AT_FIRST = 48;
const GAP = 10;
const CHIP_HEIGHT = 13;
// thumbnails smaller than that draw boxes without their labels: they'd hide the image
const CHIPS_FROM = 120;

// The slot of an image: its aspect ratio when known, else 4:3 until it loads
export const slotSize = (item, natural, width) => {
  const w = item?.width ?? natural?.width, h = item?.height ?? natural?.height;
  return { width, height: Math.round(w > 0 && h > 0 ? width * Math.min(2, h / w) : width * 0.75) };
};

// How many columns of thumbnails, and their size: as many as fit in the width. When the last row would hold one or two
// samples that fit on the rows above with slightly smaller thumbnails, they're made smaller.
export const gridLayout = (count, width, size, span = 1) => {
  const fit = s => Math.max(1, Math.floor((width + GAP) / (s * span + (span - 1) * GAP + GAP)));
  const columns = fit(size);
  if (count <= columns) return { columns: Math.max(1, Math.min(columns, count)), size };
  const rows = Math.ceil(count / columns);
  const wanted = Math.ceil(count / (rows - 1 || 1));
  const smaller = Math.floor(((width + GAP) / wanted - GAP - (span - 1) * GAP) / span);
  if (rows > 1 && smaller >= size * 0.8 && fit(smaller) >= wanted) return { columns: wanted, size: smaller };
  return { columns, size };
};

// The boxes' labels as chips of a fixed size, in the label's color, over the image as it is shown (contained in its
// slot). Those that would overlap one already placed (higher scores first) only show while hovering.
const labelChips = (boxes, width, height, slot) => {
  const scale = Math.min(slot.width / width, slot.height / height);
  const ox = (slot.width - width * scale) / 2, oy = (slot.height - height * scale) / 2;
  const placed = [];
  return boxes
    .map((box, i) => ({ box, i, text: boxLabel(box) }))
    .filter(({ text }) => text)
    .sort((a, b) => (Number.isFinite(b.box.score) ? b.box.score : 2) - (Number.isFinite(a.box.score) ? a.box.score : 2) || a.i - b.i)
    .map(({ box, i, text }) => {
      const { x, y } = boxInPixels(box, width, height);
      const w = Math.min(slot.width, 6 + 5.6 * text.length);
      const left = Math.max(0, Math.min(slot.width - w, ox + x * scale));
      const top = Math.max(0, Math.min(slot.height - CHIP_HEIGHT, oy + y * scale - CHIP_HEIGHT));
      const overlaps = placed.some(p => left < p.left + p.w && p.left < left + w && top < p.top + CHIP_HEIGHT && p.top < top + CHIP_HEIGHT);
      if (!overlaps) placed.push({ left, top, w });
      return { key: i, text, left, top, overlaps, color: labelColor(box.label) };
    });
};

// badges: say how many boxes the image has (when images don't all have the same number: BoxControls says it otherwise)
export const Thumbnail = ({ src, item, size = 150, label, color, selected, filters, onClick, title, badges = false }) => {
  const [natural, setNatural] = useState(null);
  const width = item.width ?? natural?.width;
  const height = item.height ?? natural?.height;
  const all_boxes = validBoxes(item);
  const boxes = filterBoxes(all_boxes, filters);
  const slot = slotSize(item, natural, size);
  const measured = width > 0 && height > 0;
  return <button
    type="button"
    onClick={onClick}
    title={title}
    aria-label={`Open ${item.caption ?? item.id ?? item.path}${label ? ` (${label})` : ''}`}
    aria-pressed={selected}
    className="qa-media-thumbnail"
    style={{ position: 'relative', display: 'block', padding: 0, width: slot.width, height: slot.height, border: 'none', borderRadius: 2, outline: selected ? '2px solid var(--qa-side-0, #2d72d2)' : undefined, outlineOffset: 1, background: 'rgba(128, 128, 128, 0.12)', cursor: 'zoom-in', overflow: 'hidden' }}
  >
    {src && <img
      src={src}
      alt={item.caption ?? item.id ?? item.path}
      loading="lazy"
      decoding="async"
      onLoad={e => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
      style={{ width: '100%', height: '100%', objectFit: 'contain', imageRendering: (width ?? size) < size / 2 ? 'pixelated' : undefined, display: 'block' }}
    />}
    {measured && boxes.length > 0 && <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
      {boxes.map((box, i) => {
        const { x, y, w, h } = boxInPixels(box, width, height);
        return <rect key={i} x={x} y={y} width={w} height={h} fill="none" stroke={labelColor(box.label)} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeDasharray={box.group === 'ground_truth' ? '3 2' : undefined}/>;
      })}
    </svg>}
    {measured && size >= CHIPS_FROM && labelChips(boxes, width, height, slot).map(chip => <span
      key={chip.key}
      className="qa-box-chip"
      data-overlaps={chip.overlaps || undefined}
      style={{ left: chip.left, top: chip.top, height: CHIP_HEIGHT, lineHeight: `${CHIP_HEIGHT}px`, background: chip.color, color: LABEL_TEXT_COLOR }}
    >{chip.text}</span>)}
    {label && <span style={{ position: 'absolute', left: 3, bottom: 3, fontSize: 10, lineHeight: '14px', padding: '0 4px', borderRadius: 2, background: color ?? 'rgba(0,0,0,0.6)', color: 'white', maxWidth: '60%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>}
    {badges && all_boxes.length > 0 && <span data-testid="box-badge" style={{ position: 'absolute', right: 3, bottom: 3, fontSize: 10, lineHeight: '14px', padding: '0 4px', borderRadius: 2, background: 'rgba(0,0,0,0.6)', color: 'white' }}>
      {boxes.length}{boxes.length !== all_boxes.length && `/${all_boxes.length}`} ▢
    </span>}
  </button>;
};

// A placeholder of the same size when the reference has no such sample
const Missing = ({ size, item, text }) => {
  const slot = slotSize(item, null, size);
  return <div className={Classes.TEXT_MUTED} style={{ width: slot.width, height: slot.height, border: '1px dashed rgba(128, 128, 128, 0.4)', borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, textAlign: 'center', padding: 4 }}>{text}</div>;
};

// items_new: the images logged at the step, items_ref: the reference's (null without a reference).
// focused: the sampleKey users are on, flipped: the reference shown on top (space). width: the room there is.
// expanded: { sample, content }: what to show under the row of a sample (the image viewer, the evolution strip)
const ImageGrid = ({ items_new, items_ref, output_new, output_ref, names, colors, size: wanted_size, width = 800, filters, focused, flipped, onOpen, onEvolution, side_by_side_room = false, badges = true, expanded = null }) => {
  const { fileUrl } = useMediaContext();
  const [show_all, setShowAll] = useState(false);
  const shown = show_all ? items_new : items_new.slice(0, SHOWN_AT_FIRST);
  // one image: new and reference side by side, when there is room
  const side_by_side = items_new.length === 1 && !!items_ref && side_by_side_room;
  const { columns, size } = gridLayout(shown.length, width, wanted_size, side_by_side ? 2 : 1);
  const keys = sampleKeys(items_new);
  const expanded_at = expanded ? keys.indexOf(expanded.sample) : -1;
  // the end of the row of the sample: what's expanded goes after it, on a row of its own
  const after = expanded ? Math.min(shown.length - 1, expanded_at < 0 ? shown.length - 1 : (Math.floor(expanded_at / columns) + 1) * columns - 1) : -1;
  return <>
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, ${side_by_side ? size * 2 + GAP : size}px)`, gap: `${GAP}px ${GAP}px` }} data-testid="image-grid">
      {shown.map((item, i) => {
        const key = keys[i];
        const ref = items_ref ? matchItem(item, items_ref, items_new).item : null;
        const is_focused = focused === key;
        const sides = [
          <Thumbnail key="new" src={fileUrl(output_new, item.path)} item={item} size={size} label={items_ref ? names.new : undefined} color={colors.new} selected={is_focused} filters={filters} badges={badges} onClick={() => onOpen(key)}/>,
          items_ref && (ref
            ? <Thumbnail key="ref" src={fileUrl(output_ref, ref.path)} item={ref} size={size} label={names.reference} color={colors.reference} selected={is_focused} filters={filters} badges={badges} onClick={() => onOpen(key)}/>
            : <Missing key="ref" size={size} item={item} text={`Not in ${names.reference}`}/>),
        ].filter(Boolean);
        if (flipped) sides.reverse();
        const caption = item.caption ?? item.id ?? `#${item.index ?? 0}`;
        return <Fragment key={key}>
          <figure data-sample={key} style={{ margin: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', flexDirection: side_by_side ? 'row' : 'column', gap: side_by_side ? GAP : 3 }}>{sides}</div>
            <figcaption style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 11, minHeight: 20 }}>
              <span className={Classes.TEXT_MUTED} style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={[item.caption, item.id].filter(Boolean).join(' · ')}>
                {caption}
              </span>
              {onEvolution && <Tooltip content="Across the steps (e)" compact>
                <Button size="small" variant="minimal" icon="film" aria-label={`Evolution of ${caption}`} onClick={() => onEvolution(key)}/>
              </Tooltip>}
            </figcaption>
          </figure>
          {/* the key's whole width, even past the grid's columns */}
          {i === after && <div style={{ gridColumn: '1 / -1', width, maxWidth: width }} data-testid="image-grid-expanded">{expanded.content}</div>}
        </Fragment>;
      })}
    </div>
    {items_new.length > shown.length && <Button size="small" variant="minimal" icon="chevron-down" onClick={() => setShowAll(true)}>
      Show the {items_new.length - shown.length} other images
    </Button>}
  </>;
};

export default ImageGrid;
