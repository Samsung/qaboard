// What boxes to draw on a key's images: groups (predictions, ground truth...) on or off, a score threshold, and the
// legend: a color per label, the same on every image, each label shown or hidden by a click.
import { Checkbox, Classes, Slider } from "@blueprintjs/core";

import { boxGroups, filterBoxes, labelColor, validBoxes } from "./media";

export const NO_BOX_FILTERS = Object.freeze({ hidden: new Set(), hidden_labels: new Set(), min_score: 0 });

// How many boxes the images show: { total, shown, uniform: the same number on every image that has boxes, each }.
// Counts are said once: "4 boxes each" in the controls when they're uniform, else on each image.
export const boxCounts = (items, filters) => {
  const per_image = items.map(item => [validBoxes(item).length, filterBoxes(validBoxes(item), filters).length]).filter(([all]) => all > 0);
  const total = per_image.reduce((sum, [all]) => sum + all, 0);
  const shown = per_image.reduce((sum, [, n]) => sum + n, 0);
  const uniform = per_image.length > 0 && per_image.every(([, n]) => n === per_image[0][1]);
  return { total, shown, uniform, each: uniform ? per_image[0][1] : null, images: per_image.length };
};

const legend_style = { display: 'inline-flex', alignItems: 'center', gap: 3, border: 'none', background: 'none', padding: '0 2px', font: 'inherit', color: 'inherit', cursor: 'pointer', borderRadius: 2 };

// items: the images shown (new and reference). filters: { hidden: Set of groups, hidden_labels: Set of labels, min_score }
const BoxControls = ({ items, filters, onChange, counts = boxCounts(items, filters) }) => {
  const boxes = items.flatMap(validBoxes);
  if (boxes.length === 0) return null;
  const groups = boxGroups(boxes);
  // labels can be numbers (class ids): 0 is one
  const labels = [...new Set(boxes.map(box => box.label).filter(label => label !== null && label !== undefined && label !== '').map(String))].sort();
  const scored = boxes.some(box => Number.isFinite(box.score));
  const toggle = (field, value) => {
    const hidden = new Set(filters[field]);
    if (hidden.has(value)) hidden.delete(value); else hidden.add(value);
    onChange({ ...filters, [field]: hidden });
  };
  return <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '2px 14px', fontSize: 11, margin: '2px 0 8px' }} data-testid="box-controls">
    {counts.uniform && <span className={Classes.TEXT_MUTED} data-testid="box-count">
      {counts.each} {counts.each === 1 ? 'box' : 'boxes'}{counts.images > 1 ? ' each' : ''}{counts.shown !== counts.total ? ` (of ${counts.total})` : ''}
    </span>}
    {groups.length > 1 && groups.map(group => <Checkbox key={group} inline checked={!filters.hidden?.has(group)} onChange={() => toggle('hidden', group)} label={group || 'no group'} style={{ margin: 0, fontSize: 11 }}/>)}
    {scored && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      score ≥ {(filters.min_score ?? 0).toFixed(2)}
      <span className="qa-media-score" style={{ width: 90, display: 'inline-block', marginLeft: 4, marginRight: 8 }}>
        <Slider min={0} max={1} stepSize={0.05} labelRenderer={false} value={filters.min_score ?? 0} onChange={min_score => onChange({ ...filters, min_score })} handleHtmlProps={{ 'aria-label': 'Score threshold' }}/>
      </span>
    </span>}
    {labels.length > 0 && <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '0 6px' }} role="group" aria-label="Labels">
      {labels.slice(0, 16).map(label => {
        const hidden = !!filters.hidden_labels?.has(label);
        return <button key={label} type="button" className="qa-media-legend" aria-pressed={!hidden} title={hidden ? `Show the ${label} boxes` : `Hide the ${label} boxes`} onClick={() => toggle('hidden_labels', label)} style={{ ...legend_style, opacity: hidden ? 0.45 : 1, textDecoration: hidden ? 'line-through' : undefined }}>
          <span aria-hidden style={{ width: 9, height: 9, border: `2px solid ${labelColor(label)}`, background: hidden ? undefined : `${labelColor(label)}55`, borderRadius: 1 }}/>{label}
        </button>;
      })}
      {labels.length > 16 && <span className={Classes.TEXT_MUTED}>+{labels.length - 16}</span>}
    </span>}
  </div>;
};

export default BoxControls;
