// The Inputs page's metadata sidebar, like a dataset browser's (FiftyOne's): each key of the inputs' data.metadata,
// by name, with a hint of its type, and
// - numbers: a histogram above a range slider, and min/max inputs ({key: {min, max}} in the URL's `meta`);
// - text, true/false, and numbers with few values: their most common values to tick, with how many inputs have each,
//   and a search in the key's values when it has more than the server lists.
// Keys with one value (every input has it, or none) say so on one line.
// The server's facets: backend/backend/input_catalog.py (metadata_facets, metadata_values).
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import styled from "styled-components";
import { Button, Checkbox, Classes, Colors, Icon, InputGroup, Intent, RangeSlider, Spinner, Tag } from "@blueprintjs/core";

import {
  stringify_meta, toggle_meta, set_meta_range, is_range, format_number, describe_meta, metadataValuesQuery,
} from "./api";


// Numbers with this many values or fewer are ticked like text (0/1 flags, two exposures): a range would be slower
export const few_numbers = 3;
// How a key is filtered: 'range' or 'values'. Its filter in the URL wins (a link may tick numbers).
export const facet_kind = (facet, filter) => {
  if (is_range(filter)) return 'range';  // without a histogram (no numbers here): says so
  if (filter?.length) return 'values';
  return facet.type === 'number' && facet.distinct > few_numbers && facet.histogram?.length > 0 ? 'range' : 'values';
};

const types = {
  number: { icon: 'numerical', title: 'Numbers' },
  string: { icon: 'font', title: 'Text' },
  boolean: { icon: 'switch', title: 'True or false' },
  mixed: { icon: 'asterisk', title: 'Values of several types' },
};
const value_label = (facet, value) => {
  if (value === '') return <em>empty</em>;
  if (facet.type === 'boolean') return value === 'true' ? 'True' : value === 'false' ? 'False' : value;
  return value;
};

const Section = styled.section`
  .qa-meta-type {
    flex: none;
    display: inline-flex;
    color: ${Colors.GRAY3};
  }
  .qa-meta-search {
    margin: 2px 0 4px 22px;
  }
  .qa-meta-range {
    padding: 2px 8px 6px 22px;
  }
  .qa-histogram {
    display: flex;
    align-items: flex-end;
    gap: 1px;
    height: 36px;
  }
  .qa-histogram button {
    flex: 1 1 0;
    min-width: 0;
    padding: 0;
    border: 0;
    border-radius: 1px 1px 0 0;
    background: ${Colors.GRAY4};
    opacity: 0.5;
    cursor: pointer;
  }
  .qa-histogram button.qa-in-range {
    background: ${Colors.BLUE4};
    opacity: 1;
  }
  .qa-histogram button:hover, .qa-histogram button:focus-visible {
    opacity: 0.8;
    outline: 1px solid ${Colors.BLUE3};
  }
  .qa-meta-range .${Classes.SLIDER} {
    min-width: 0;
    margin: 4px 0 2px;
    height: 20px;
  }
  .qa-range-inputs {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .qa-range-inputs input {
    width: 100%;
    min-width: 0;
    font-variant-numeric: tabular-nums;
  }
`;

// The step of a slider over [min, max]: 1 for integers, else a round tenth to thousandth of the span
const step_of = facet => {
  if (facet.integers) return 1;
  const span = facet.max - facet.min;
  return span > 0 ? 10 ** Math.floor(Math.log10(span / 100)) : 1;
};
const round_to = (x, step) => step >= 1 ? Math.round(x / step) * step : Number(x.toFixed(Math.max(0, -Math.floor(Math.log10(step)))));

// A number users type: a bound, null when empty, undefined when it's not a number
const parse_bound = text => {
  if (text.trim() === '') return null;
  const n = Number(text.replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
};

const RangeFacet = ({ facet, range, onRange }) => {
  const step = step_of(facet);
  const extent = [facet.min, facet.max];
  const from_props = [Math.max(range?.min ?? facet.min, facet.min), Math.min(range?.max ?? facet.max, facet.max)];
  // while dragging: the slider's values, sent when released
  const [drag, setDrag] = useState(null);
  const [lo, hi] = drag ?? from_props;
  const [texts, setTexts] = useState(null);
  const shown_texts = texts ?? [range?.min ?? '', range?.max ?? ''].map(String);
  // the whole extent is no filter
  const send = ([a, b]) => {
    setDrag(null);
    const min = a <= facet.min ? null : a;
    const max = b >= facet.max ? null : b;
    onRange(min === null && max === null ? null : { min, max });
  };
  const send_texts = () => {
    const [min, max] = shown_texts.map(parse_bound);
    setTexts(null);
    if (min === undefined || max === undefined) return;
    if (min !== null && max !== null && min > max) return onRange({ min: max, max: min });
    onRange(min === null && max === null ? null : { min, max });
  };
  const peak = Math.max(1, ...facet.histogram.map(b => b.count));
  // integers, a bin each: [n, n + 1)
  const bin_range = bin => facet.integers && bin.end - bin.start === 1 ? { min: bin.start, max: bin.start } : { min: bin.start, max: bin.end };
  const bin_words = bin => {
    const { min, max } = bin_range(bin);
    return `${min === max ? format_number(min) : `${format_number(min)} to ${format_number(max)}`}: ${bin.count.toLocaleString()} input${bin.count === 1 ? '' : 's'}`;
  };
  return <div className="qa-meta-range">
    <div className="qa-histogram" role="group" aria-label={`Histogram of ${facet.key}`}>
      {facet.histogram.map(bin => {
        const { min, max } = bin_range(bin);
        const inside = max >= lo && min <= hi;
        return <button
          key={bin.start}
          type="button"
          className={inside ? 'qa-in-range' : undefined}
          style={{ height: bin.count ? `${Math.max(6, (100 * bin.count) / peak)}%` : 1 }}
          title={bin_words(bin)}
          aria-label={bin_words(bin)}
          onClick={() => onRange(bin_range(bin))}
        />;
      })}
    </div>
    <RangeSlider
      min={extent[0]}
      max={extent[1]}
      stepSize={step}
      labelRenderer={false}
      value={[lo, hi]}
      onChange={([a, b]) => setDrag([round_to(a, step), round_to(b, step)])}
      onRelease={([a, b]) => send([round_to(a, step), round_to(b, step)])}
      handleHtmlProps={{ start: { 'aria-label': `${facet.key} from` }, end: { 'aria-label': `${facet.key} to` } }}
    />
    <form className="qa-range-inputs" onSubmit={event => { event.preventDefault(); send_texts(); }}>
      <input
        className={`${Classes.INPUT} ${Classes.SMALL}`}
        inputMode="decimal"
        aria-label={`${facet.key} at least`}
        placeholder={format_number(facet.min)}
        value={drag ? String(drag[0]) : shown_texts[0]}
        onChange={event => setTexts([event.target.value, shown_texts[1]])}
        onBlur={() => texts && send_texts()}
      />
      <span className={Classes.TEXT_MUTED}>to</span>
      <input
        className={`${Classes.INPUT} ${Classes.SMALL}`}
        inputMode="decimal"
        aria-label={`${facet.key} at most`}
        placeholder={format_number(facet.max)}
        value={drag ? String(drag[1]) : shown_texts[1]}
        onChange={event => setTexts([shown_texts[0], event.target.value])}
        onBlur={() => texts && send_texts()}
      />
      {/* Enter sends the form */}
      <button type="submit" hidden aria-label="Apply the range"/>
      {range && <Button variant="minimal" size="small" icon="cross" aria-label={`Clear the range of ${facet.key}`} title="Clear" onClick={() => onRange(null)}/>}
    </form>
  </div>;
};

// After a pause in typing
const useDebounced = (value, delay = 250) => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
};

const values_shown = 5;
const ValuesFacet = ({ facet, selected, onToggle, project, filters }) => {
  const [all, setAll] = useState(false);
  const [search, setSearch] = useState('');
  const searched = useDebounced(search.trim());
  // the server lists the 20 most common values: more, and users search the others
  const searchable = facet.distinct > facet.values.length;
  const found = useQuery({ ...metadataValuesQuery(project, filters, facet.key, searched), enabled: !!project && searchable && !!searched });
  const searching = searchable && !!searched;
  const listed = searching ? found.data?.values ?? [] : facet.values;
  const values = searching ? listed : listed.filter((v, i) => all || i < values_shown || selected.includes(v.value));
  const missing = searching ? [] : selected.filter(value => !listed.some(v => v.value === value));
  return <>
    {searchable && <InputGroup
      className="qa-meta-search"
      size="small"
      type="search"
      leftIcon="search"
      placeholder={`Search ${facet.distinct.toLocaleString()} values`}
      aria-label={`Search the values of ${facet.key}`}
      value={search}
      onChange={event => setSearch(event.target.value)}
      rightElement={searching && found.isFetching ? <Spinner size={14}/> : undefined}
    />}
    <ul className="qa-meta-values">
      {[...values, ...missing.map(value => ({ value, count: 0 }))].map(v => <li key={v.value}>
        <Checkbox
          checked={selected.includes(v.value)}
          onChange={() => onToggle(facet.key, v.value)}
          labelElement={<span className="qa-meta-value"><span className="qa-facet-name" title={v.value}>{value_label(facet, v.value)}</span><span className={`qa-facet-count ${Classes.TEXT_MUTED}`}>{v.count.toLocaleString()}</span></span>}
        />
      </li>)}
      {searching && found.isSuccess && listed.length === 0 && <li className={`qa-facet-note ${Classes.TEXT_MUTED}`}>No value contains “{searched}”</li>}
      {searching && found.isError && <li className={`qa-facet-note ${Classes.TEXT_MUTED}`}>Couldn't search the values</li>}
      {searching && (found.data?.distinct ?? 0) > listed.length && <li className={`qa-facet-note ${Classes.TEXT_MUTED}`}>
        the {listed.length} most common of {found.data.distinct.toLocaleString()} matching values
      </li>}
      {!searching && !all && listed.length > values_shown && <li><Button variant="minimal" size="small" text={`${listed.length - values_shown} more`} onClick={() => setAll(true)}/></li>}
      {!searching && (all || listed.length <= values_shown) && searchable && <li className={`qa-facet-note ${Classes.TEXT_MUTED}`}>
        and {(facet.distinct - listed.length).toLocaleString()} rarer values: search them above
      </li>}
    </ul>
  </>;
};

export const MetadataFacet = ({ facet, filter, onToggle, onRange, project, filters }) => {
  const kind = facet_kind(facet, filter);
  const filtered = is_range(filter) || !!filter?.length;
  const [open, setOpen] = useState(filtered || facet.distinct <= 12);
  const type = types[facet.type] ?? types.mixed;
  return <li className="qa-meta-key">
    <button type="button" className="qa-facet-row qa-meta-key-row" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Icon icon={open ? 'chevron-down' : 'chevron-right'} size={12} className={Classes.TEXT_MUTED}/>
      {/* a hint on hover: the type in the name would make it "Numbers iso 6" */}
      <span className="qa-meta-type" title={type.title}><Icon icon={type.icon} size={12} aria-hidden/></span>
      <span className="qa-facet-name" title={facet.key}>{facet.key}</span>
      {is_range(filter) && <Tag minimal round intent={Intent.PRIMARY}>{describe_meta('', filter).trim()}</Tag>}
      {!is_range(filter) && filtered && <Tag minimal round intent={Intent.PRIMARY}>{filter.length}</Tag>}
      <span className={`qa-facet-count ${Classes.TEXT_MUTED}`} title={`${facet.count.toLocaleString()} inputs have it, ${facet.distinct.toLocaleString()} values`}>
        {kind === 'range' && facet.histogram?.length ? `${format_number(facet.min)}–${format_number(facet.max)}` : facet.distinct.toLocaleString()}
      </span>
    </button>
    {open && (kind === 'range' && !facet.histogram?.length
      // a range on a key that has no numbers among these inputs (other filters, or not only numbers)
      ? <p className={`qa-facet-note ${Classes.TEXT_MUTED}`}>
          {facet.count ? `Not only numbers: the range keeps the inputs whose ${facet.key} is a number in it.` : `No input with these filters has ${facet.key}.`}{' '}
          <Button variant="minimal" size="small" text="Clear" onClick={() => onRange(facet.key, null)}/>
        </p>
      : kind === 'range'
      ? <RangeFacet facet={facet} range={is_range(filter) ? filter : null} onRange={range => onRange(facet.key, range)}/>
      : <ValuesFacet facet={facet} selected={is_range(filter) ? [] : filter ?? []} onToggle={onToggle} project={project} filters={filters}/>)}
  </li>;
};

export const Metadata = ({ metadata, project, filters, setFilters, loading, docs_root }) => {
  const meta = filters.meta;
  const toggle = (key, value) => setFilters({ meta: stringify_meta(toggle_meta(meta, key, value)) });
  const setRange = (key, range) => setFilters({ meta: stringify_meta(set_meta_range(meta, key, range)) });
  const [open, setOpen] = useState(false);
  const meta_count = Object.keys(meta).length;
  if (loading) return null;
  // by name: keys don't move when users filter. Those with one value (every input has it, or none) say so on one line
  const sorted = [...metadata].sort((a, b) => a.key.localeCompare(b.key));
  const useful = sorted.filter(f => f.distinct > 1 || meta[f.key]);
  const constant = sorted.filter(f => f.distinct === 1 && !meta[f.key]);
  return <Section aria-label="Metadata" className={open ? 'qa-meta-open' : undefined}>
    <h2 className={`qa-facet-title ${Classes.TEXT_MUTED}`}>
      Metadata
      {useful.length > 0 && <button type="button" className="qa-meta-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'hide' : `${useful.length} key${useful.length === 1 ? '' : 's'}${meta_count ? `, ${meta_count} filtered` : ''}`}
      </button>}
    </h2>
    {metadata.length === 0
      ? <p className={`qa-facet-note ${Classes.TEXT_MUTED}`}>
          These inputs have no metadata. Give them some with <code>qa inputs add</code> or in <code>qaboard.yaml</code>, to filter by it here.{' '}
          <a href={`${docs_root}docs/user-guide/inputs-and-collections#find-inputs`} target="_blank" rel="noopener noreferrer">How</a>
        </p>
      : <ul className="qa-facet-list qa-meta-list">
          {useful.map(facet => <MetadataFacet key={facet.key} facet={facet} filter={meta[facet.key]} onToggle={toggle} onRange={setRange} project={project} filters={filters}/>)}
          {constant.map(facet => <li key={facet.key} className={`qa-facet-note ${Classes.TEXT_MUTED}`} title={`${facet.count.toLocaleString()} inputs have it`}>
            {facet.key}: <strong>{value_label(facet, facet.values[0]?.value ?? '')}</strong> (all that have it)
          </li>)}
        </ul>}
  </Section>;
};
