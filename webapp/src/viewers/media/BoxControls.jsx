// What boxes to draw on a key's images: groups (predictions, ground truth...) on or off, a score threshold, and the
// legend: a color per label, the same on every image.
import { Checkbox, Classes, Slider } from "@blueprintjs/core";

import { boxGroups, filterBoxes, labelColor, validBoxes } from "./media";

// items: the images shown (new and reference). filters: { hidden: Set of groups, min_score }
const BoxControls = ({ items, filters, onChange }) => {
  const boxes = items.flatMap(validBoxes);
  if (boxes.length === 0) return null;
  const groups = boxGroups(boxes);
  const shown = filterBoxes(boxes, filters);
  // labels can be numbers (class ids): 0 is one
  const labels = [...new Set(boxes.map(box => box.label).filter(label => label !== null && label !== undefined && label !== '').map(String))].sort();
  const scored = boxes.some(box => Number.isFinite(box.score));
  const toggle = group => {
    const hidden = new Set(filters.hidden);
    if (hidden.has(group)) hidden.delete(group); else hidden.add(group);
    onChange({ ...filters, hidden });
  };
  return <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '2px 14px', fontSize: 11, margin: '2px 0 8px' }} data-testid="box-controls">
    <span className={Classes.TEXT_MUTED}>{shown.length} of {boxes.length} boxes</span>
    {groups.length > 1 && groups.map(group => <Checkbox key={group} inline checked={!filters.hidden?.has(group)} onChange={() => toggle(group)} label={group || 'no group'} style={{ margin: 0, fontSize: 11 }}/>)}
    {scored && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      score ≥ {(filters.min_score ?? 0).toFixed(2)}
      <span style={{ width: 90, display: 'inline-block', paddingRight: 6 }}>
        <Slider min={0} max={1} stepSize={0.05} labelRenderer={false} value={filters.min_score ?? 0} onChange={min_score => onChange({ ...filters, min_score })} handleHtmlProps={{ 'aria-label': 'Score threshold' }}/>
      </span>
    </span>}
    {labels.length > 0 && <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '0 8px' }} aria-label="Labels">
      {labels.slice(0, 16).map(label => <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        <span style={{ width: 9, height: 9, border: `2px solid ${labelColor(label)}`, borderRadius: 1 }}/>{label}
      </span>)}
      {labels.length > 16 && <span className={Classes.TEXT_MUTED}>+{labels.length - 16}</span>}
    </span>}
  </div>;
};

export default BoxControls;
