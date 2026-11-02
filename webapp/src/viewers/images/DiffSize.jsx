// The size of the differences users look for in "Where they differ", in pixels: the server finds the differences of
// that size only (e.g. small defects, not a whole sky that changed). Remembered by project.
import { useState } from 'react';

import { useSelected } from '../../hooks';
import { usePrefsStore } from '../../stores/prefs';

// { min, max } of the project, or null
export const useDiffSize = () => {
  const { project } = useSelected();
  const size = usePrefsStore(state => state.imageDiffSize?.[project]) ?? null;
  const setSize = usePrefsStore(state => state.setImageDiffSize);
  return [size && (size.min || size.max) ? size : null, next => setSize(project, next && (next.min || next.max) ? next : null)];
};

export const describeDiffSize = size => !size ? 'any size'
  : size.min && size.max ? `${size.min}–${size.max} px`
  : size.min ? `≥ ${size.min} px` : `≤ ${size.max} px`;

// A number of pixels, applied when users leave the field or press Enter: each change searches again
const Pixels = ({ label, value, placeholder, onChange }) => {
  const [draft, setDraft] = useState(null);
  const commit = text => {
    setDraft(null);
    const number = Math.round(Number(text));
    onChange(text === '' || !Number.isFinite(number) || number <= 0 ? null : number);
  };
  return <input
    type="number"
    className="qiv-diff-size-input"
    aria-label={label}
    min={1}
    step={1}
    placeholder={placeholder}
    value={draft ?? value ?? ''}
    onChange={event => setDraft(event.target.value)}
    onBlur={event => draft !== null && commit(event.target.value)}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Enter') commit(event.currentTarget.value);
      if (event.key === 'Escape') setDraft(null);
    }}
  />;
};

export const DiffSizeFilter = ({ size, onChange }) => {
  const change = patch => {
    const next = { min: size?.min ?? null, max: size?.max ?? null, ...patch };
    // the other way around: swapped
    if (next.min && next.max && next.min > next.max) [next.min, next.max] = [next.max, next.min];
    onChange(next);
  };
  return <span
    className={`qiv-diff-size ${size ? 'qiv-active' : ''}`}
    title="The size of the differences to find, in pixels: their longest side, where the difference is over half of its peak. The search goes on past the others, e.g. to find small defects that differ less than a large change. Remembered for the project"
  >
    <span>Size</span>
    <Pixels label="Smallest difference, in pixels" value={size?.min} placeholder="any" onChange={min => change({ min })} />
    <span aria-hidden="true">–</span>
    <Pixels label="Largest difference, in pixels" value={size?.max} placeholder="any" onChange={max => change({ max })} />
    <span>px</span>
    {size && <button type="button" className="qiv-diff-size-clear" title="Any size" aria-label="Any size" onClick={() => onChange(null)}>×</button>}
  </span>;
};
