// The images a key logged at a step: thumbnails in a grid, each over the reference's same sample (matched by id, else
// caption, else position), with their boxes. Clicking one opens it in the image viewer. Slots take their size from
// the images' width and height, so that the grid doesn't move as steps change.
import { useState } from "react";
import { Button, Classes, Tooltip } from "@blueprintjs/core";

import { useMediaContext } from "./context";
import { boxInPixels, boxLabel, filterBoxes, labelColor, matchItem, sampleKey, validBoxes } from "./media";

const SHOWN_AT_FIRST = 48;

// The slot of an image: its aspect ratio when known, else 4:3 until it loads
export const slotSize = (item, natural, width) => {
  const w = item?.width ?? natural?.width, h = item?.height ?? natural?.height;
  return { width, height: Math.round(w > 0 && h > 0 ? width * Math.min(2, h / w) : width * 0.75) };
};

export const Thumbnail = ({ src, item, size = 150, label, color, selected, filters, onClick, title }) => {
  const [natural, setNatural] = useState(null);
  const width = item.width ?? natural?.width;
  const height = item.height ?? natural?.height;
  const boxes = filterBoxes(validBoxes(item), filters);
  const slot = slotSize(item, natural, size);
  return <button
    type="button"
    onClick={onClick}
    title={title}
    aria-label={`Open ${item.caption ?? item.id ?? item.path}${label ? ` (${label})` : ''}`}
    aria-pressed={selected}
    className="qa-media-thumbnail"
    style={{ position: 'relative', display: 'block', padding: 0, width: slot.width, height: slot.height, border: 'none', borderRadius: 2, outline: selected ? '2px solid #2d72d2' : undefined, outlineOffset: 1, background: 'rgba(128, 128, 128, 0.12)', cursor: 'zoom-in', overflow: 'hidden' }}
  >
    {src && <img
      src={src}
      alt={item.caption ?? item.id ?? item.path}
      loading="lazy"
      decoding="async"
      onLoad={e => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
      style={{ width: '100%', height: '100%', objectFit: 'contain', imageRendering: (width ?? size) < size / 2 ? 'pixelated' : undefined, display: 'block' }}
    />}
    {width > 0 && height > 0 && boxes.length > 0 && <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
      {boxes.map((box, i) => {
        const { x, y, w, h } = boxInPixels(box, width, height);
        const text = boxLabel(box);
        const stroke = labelColor(box.label);
        return <g key={i}>
          <rect x={x} y={y} width={w} height={h} fill="none" stroke={stroke} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeDasharray={box.group === 'ground_truth' ? '3 2' : undefined}/>
          {text && size >= 120 && <text x={x + 1} y={y} dy="-0.25em" fill={stroke} stroke="rgba(0,0,0,0.6)" strokeWidth={0.6} paintOrder="stroke" style={{ fontSize: Math.max(height / 11, 1), fontWeight: 600 }}>{text}</text>}
        </g>;
      })}
    </svg>}
    {label && <span style={{ position: 'absolute', left: 3, top: 3, fontSize: 10, lineHeight: '14px', padding: '0 4px', borderRadius: 2, background: color ?? 'rgba(0,0,0,0.6)', color: 'white', maxWidth: '80%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>}
    {validBoxes(item).length > 0 && <span style={{ position: 'absolute', right: 3, bottom: 3, fontSize: 10, lineHeight: '14px', padding: '0 4px', borderRadius: 2, background: 'rgba(0,0,0,0.6)', color: 'white' }}>
      {boxes.length}{boxes.length !== validBoxes(item).length && `/${validBoxes(item).length}`} ▢
    </span>}
  </button>;
};

// A placeholder of the same size when the reference has no such sample
const Missing = ({ size, item, text }) => {
  const slot = slotSize(item, null, size);
  return <div className={Classes.TEXT_MUTED} style={{ width: slot.width, height: slot.height, border: '1px dashed rgba(128, 128, 128, 0.4)', borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, textAlign: 'center', padding: 4 }}>{text}</div>;
};

// items_new: the images logged at the step, items_ref: the reference's (null without a reference).
// focused: the sampleKey users are on, flipped: the reference shown on top (space)
const ImageGrid = ({ items_new, items_ref, output_new, output_ref, names, colors, size, filters, focused, flipped, onOpen, onEvolution, side_by_side_room = false }) => {
  const { fileUrl } = useMediaContext();
  const [show_all, setShowAll] = useState(false);
  const shown = show_all ? items_new : items_new.slice(0, SHOWN_AT_FIRST);
  // one image: new and reference side by side, when there is room
  const side_by_side = items_new.length === 1 && !!items_ref && side_by_side_room;
  return <>
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, ${size}px)`, gap: '10px 10px' }} data-testid="image-grid">
      {shown.map(item => {
        const key = sampleKey(item);
        const ref = items_ref ? matchItem(item, items_ref).item : null;
        const is_focused = focused === key;
        const sides = [
          <Thumbnail key="new" src={fileUrl(output_new, item.path)} item={item} size={size} label={items_ref ? names.new : undefined} color={colors.new} selected={is_focused} filters={filters} onClick={() => onOpen(key)}/>,
          items_ref && (ref
            ? <Thumbnail key="ref" src={fileUrl(output_ref, ref.path)} item={ref} size={size} label={names.ref} color={colors.ref} selected={is_focused} filters={filters} onClick={() => onOpen(key)}/>
            : <Missing key="ref" size={size} item={item} text={`Not in ${names.ref}`}/>),
        ].filter(Boolean);
        if (flipped) sides.reverse();
        return <figure key={key} data-sample={key} style={{ margin: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3, gridColumn: side_by_side ? 'span 2' : undefined }}>
          <div style={{ display: 'flex', flexDirection: side_by_side ? 'row' : 'column', gap: side_by_side ? 10 : 3 }}>{sides}</div>
          <figcaption style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 11, minHeight: 20 }}>
            <span className={Classes.TEXT_MUTED} style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={[item.caption, item.id].filter(Boolean).join(' · ')}>
              {item.caption ?? item.id ?? `#${item.index ?? 0}`}
            </span>
            <Tooltip content="Across the steps (e)" compact>
              <Button size="small" variant="minimal" icon="film" aria-label={`Evolution of ${item.caption ?? item.id ?? `#${item.index ?? 0}`}`} onClick={() => onEvolution(key)}/>
            </Tooltip>
          </figcaption>
        </figure>;
      })}
    </div>
    {items_new.length > shown.length && <Button size="small" variant="minimal" icon="chevron-down" onClick={() => setShowAll(true)}>
      Show the {items_new.length - shown.length} other images
    </Button>}
  </>;
};

export default ImageGrid;
