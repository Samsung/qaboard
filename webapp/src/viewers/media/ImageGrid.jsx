// Several images logged at a step (a list): thumbnails with their captions and boxes, each over the reference's
// image of the same index. Clicking one opens it in the image viewer.
import { useState } from "react";
import { Button, Classes } from "@blueprintjs/core";

import { useMediaContext } from "./context";
import { boxColor, boxGroups, boxInPixels, boxLabel, validBoxes } from "./media";

const THUMBNAIL = 140;
const SHOWN_AT_FIRST = 24;

// The image, its boxes outlined on top. Until we know its size (not in the index), the boxes wait for it to load.
export const Thumbnail = ({ src, item, label, color, selected, onClick }) => {
  const [natural, setNatural] = useState(null);
  const width = item.width ?? natural?.width;
  const height = item.height ?? natural?.height;
  const boxes = validBoxes(item);
  const groups = boxGroups(boxes);
  return <button
    type="button"
    onClick={onClick}
    aria-label={`Open ${item.caption ?? item.path}${label ? ` (${label})` : ''}`}
    aria-pressed={selected}
    style={{ position: 'relative', display: 'block', padding: 0, border: `2px solid ${selected ? '#2d72d2' : 'transparent'}`, background: 'none', cursor: 'zoom-in', lineHeight: 0 }}
  >
    <img
      src={src}
      alt={item.caption ?? item.path}
      loading="lazy"
      onLoad={e => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
      style={{ maxWidth: THUMBNAIL, maxHeight: THUMBNAIL, minWidth: 48, minHeight: 48, objectFit: 'contain', imageRendering: (width ?? THUMBNAIL) < THUMBNAIL / 2 ? 'pixelated' : undefined, display: 'block' }}
    />
    {width > 0 && height > 0 && boxes.length > 0 && <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
      {boxes.map((box, i) => {
        const { x, y, w, h } = boxInPixels(box, width, height);
        const text = boxLabel(box);
        const stroke = boxColor(groups, box);
        return <g key={i}>
          <rect x={x} y={y} width={w} height={h} fill="none" stroke={stroke} strokeWidth={2} vectorEffect="non-scaling-stroke"/>
          {text && <text x={x} y={y} dy="-0.2em" fill={stroke} style={{ fontSize: Math.max(height / 12, 1), fontWeight: 600 }}>{text}</text>}
        </g>;
      })}
    </svg>}
    {label && <span style={{ position: 'absolute', left: 2, top: 2, fontSize: 10, lineHeight: '14px', padding: '0 4px', borderRadius: 2, background: color ?? 'rgba(0,0,0,0.6)', color: 'white' }}>{label}</span>}
  </button>;
};

// items_new, items_ref: the images logged at the step, by index
const ImageGrid = ({ items_new, items_ref, output_new, output_ref, names, colors, selected, onSelect }) => {
  const { fileUrl } = useMediaContext();
  const [show_all, setShowAll] = useState(false);
  const shown = show_all ? items_new : items_new.slice(0, SHOWN_AT_FIRST);
  const ref_of = item => items_ref.find(ref => (ref.index ?? 0) === (item.index ?? 0));
  return <>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }} data-testid="image-grid">
      {shown.map(item => {
        const index = item.index ?? 0;
        const ref = ref_of(item);
        return <figure key={index} style={{ margin: 0, maxWidth: THUMBNAIL + 4 }}>
          <Thumbnail src={fileUrl(output_new, item.path)} item={item} label={ref ? names.new : undefined} color={colors.new} selected={selected === index} onClick={() => onSelect(selected === index ? null : index)}/>
          {ref && <div style={{ marginTop: 2 }}>
            <Thumbnail src={fileUrl(output_ref, ref.path)} item={ref} label={names.ref} color={colors.ref} selected={selected === index} onClick={() => onSelect(selected === index ? null : index)}/>
          </div>}
          {(item.caption || ref?.caption) && <figcaption className={Classes.TEXT_MUTED} style={{ fontSize: 11, overflowWrap: 'anywhere' }}>
            {item.caption}{ref?.caption && ref.caption !== item.caption && <> / {ref.caption}</>}
          </figcaption>}
        </figure>;
      })}
    </div>
    {items_new.length > shown.length && <Button size="small" variant="minimal" icon="chevron-down" onClick={() => setShowAll(true)}>
      Show the {items_new.length - shown.length} other images
    </Button>}
  </>;
};

export default ImageGrid;
