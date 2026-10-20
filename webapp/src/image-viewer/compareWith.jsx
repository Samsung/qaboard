// What the image is compared with: the reference, or another image the app offers (`compareWith`), e.g. another file
// of the same run: the ground truth, the input, a previous stage... The app lists them, the viewer lets users pick one.
//   compareWith: [{ id, image, label?, group?, detail?, title? }]
// Apps can also say where a pick applies (compareScopes), e.g. to every run of a page or to this one only.
// The viewer knows nothing of where they come from: apps add their own groups (e.g. "Suggested", "This run", later
// "Other runs").
import { useEffect, useRef, useState } from 'react';

import { normalizeImage, thumbnailUrl } from './sources';
import { Icon, Segmented } from './ui';

// The most items listed at once: type to find the others
const LIMIT = 200;

export const candidateLabel = candidate => candidate.label ?? normalizeImage(candidate.image)?.label ?? candidate.id;

// The candidates whose label, group or detail have all the words of the query, in any order and case
export const matchCandidates = (candidates, query) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return candidates;
  return candidates.filter(candidate => {
    const text = [candidateLabel(candidate), candidate.group, candidate.detail].filter(Boolean).join(' ').toLowerCase();
    return words.every(word => text.includes(word));
  });
};

// [{ group, items }], in the order the groups first appear
export const groupCandidates = candidates => {
  const groups = new Map();
  for (const candidate of candidates) {
    const group = candidate.group ?? null;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(candidate);
  }
  return [...groups].map(([group, items]) => ({ group, items }));
};

// A path's folder, muted, and its name
const PathLabel = ({ text, query }) => {
  const slash = text.lastIndexOf('/');
  return <span className="qiv-compare-name">
    {slash > 0 && <span className="qiv-muted">{text.slice(0, slash + 1)}</span>}
    <Highlight text={text.slice(slash + 1)} query={query} />
  </span>;
};

// The first word of the query, in bold
const Highlight = ({ text, query }) => {
  const word = query.trim().toLowerCase().split(/\s+/)[0];
  const at = word ? text.toLowerCase().indexOf(word) : -1;
  if (at === -1) return text;
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + word.length)}</mark>{text.slice(at + word.length)}</>;
};

const Thumbnail = ({ image }) => {
  const [failed, setFailed] = useState(false);
  const url = thumbnailUrl(image, null, 32);
  return <span className="qiv-compare-thumbnail">
    {url && !failed ? <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} /> : <Icon icon="media" size={14} />}
  </span>;
};

// The menu: a search box, the reference, then the app's images by group. Arrows and Enter pick one.
export const CompareWithMenu = ({ reference, referenceName, candidates, selected, onSelect, close, scopes = [], scope, onScopeChange }) => {
  const [query, setQuery] = useState('');
  const matches = matchCandidates(candidates, query);
  const shown = matches.slice(0, LIMIT);
  const groups = groupCandidates(shown);
  // what Enter picks: the reference (null) when it's listed, then the images
  const show_reference = !!reference && matchCandidates([{ label: `${referenceName} reference` }], query).length > 0;
  const order = [...(show_reference ? [null] : []), ...groups.flatMap(({ items }) => items.map(item => item.id))];
  const [active, setActive] = useState(() => Math.max(0, order.indexOf(selected ?? null)));
  const active_id = order[Math.min(active, order.length - 1)];
  const list = useRef(null);
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active_id]);
  const pick = id => {
    onSelect(id);
    close();
  };
  const onKeyDown = event => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (step && order.length > 0) {
      event.preventDefault();
      setActive((Math.min(active, order.length - 1) + step + order.length) % order.length);
    } else if (event.key === 'Enter' && order.length > 0) {
      event.preventDefault();
      pick(active_id);
    }
  };
  const item = (id, content, props) => <button
    key={id ?? 'reference'}
    type="button"
    role="option"
    aria-selected={id === (selected ?? null)}
    data-active={id === active_id}
    className={`qiv-compare-item ${id === (selected ?? null) ? 'qiv-active' : ''}`}
    onClick={() => pick(id)}
    onPointerMove={() => setActive(order.indexOf(id))}
    {...props}
  >
    {content}
    <Icon icon="tick" size={14} className={id === (selected ?? null) ? '' : 'qiv-hidden'} />
  </button>;

  return <div className="qiv-compare-menu">
    <label className="qiv-compare-search">
      <Icon icon="search" size={14} />
      <input
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the menu opened to find an image
        autoFocus
        type="search"
        placeholder="Find an image…"
        aria-label="Find an image to compare with"
        value={query}
        onChange={event => { setQuery(event.target.value); setActive(0); }}
        onKeyDown={onKeyDown}
      />
    </label>
    <div className="qiv-compare-list" role="listbox" aria-label="Compare with" ref={list}>
      {show_reference && item(null, <>
        <span className="qiv-compare-thumbnail qiv-compare-reference"><Icon icon="git-branch" size={14} /></span>
        <span className="qiv-compare-text">
          <span className="qiv-compare-name">{referenceName}</span>
          <span className="qiv-compare-detail">{normalizeImage(reference)?.detail ?? 'The reference'}</span>
        </span>
      </>, { title: 'Compare with the reference' })}
      {groups.map(({ group, items }) => <div key={group ?? ''} role="group" aria-label={group ?? undefined}>
        {group && <div className="qiv-menu-title">{group}</div>}
        {items.map(candidate => item(candidate.id, <>
          <Thumbnail image={candidate.image} />
          <span className="qiv-compare-text">
            <PathLabel text={candidateLabel(candidate)} query={query} />
            {candidate.detail && <span className="qiv-compare-detail">{candidate.detail}</span>}
          </span>
        </>, { title: candidate.title ?? candidateLabel(candidate) }))}
      </div>)}
      {order.length === 0 && <div className="qiv-hint">
        {candidates.length === 0 ? 'No other image to compare with' : <>No image matches “{query}”</>}
      </div>}
      {matches.length > shown.length && <div className="qiv-hint">{matches.length - shown.length} more: type to find them</div>}
    </div>
    {scopes.length > 1 && <div className="qiv-compare-scope">
      <span className="qiv-muted">Apply to</span>
      <Segmented label="Apply to" options={scopes} value={scope} onChange={onScopeChange} />
      <span className="qiv-compare-scope-hint">{scopes.find(option => option.value === scope)?.title}</span>
    </div>}
    <div className="qiv-hint qiv-compare-footer">
      <kbd>↑</kbd> <kbd>↓</kbd> <kbd>Enter</kbd> to pick · <kbd>c</kbd> switches between the reference and the image picked last
    </div>
  </div>;
};
