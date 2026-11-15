// Run Tests / Tuning's "Choose the values", as a table: one row per parameter, its values as tags.
// It edits the text that is sent (see parameters.js): the text is one click away, and stays the source of truth.
import { useId, useState } from "react";
import styled from "styled-components";
import { Button, Callout, Classes, Icon, InputGroup, Intent, PopoverNext, SegmentedControl, Switch, TagInput, Tooltip } from "@blueprintjs/core";

import { parse_sets, serialize_sets, set_combinations, parse_value, format_value, split_values, range_values, pasted_parameters } from "./parameters";


const Table = styled.div`
  .qa-params-set { border: 1px solid var(--qa-border); border-radius: 6px; padding: 4px 12px 10px; margin-bottom: 10px; }
  .qa-params-set-title { display: flex; align-items: center; gap: 8px; padding: 6px 0 2px; font-weight: 600; }
  .qa-params-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; padding: 8px 0; border-bottom: 1px solid var(--qa-border); }
  .qa-params-row:last-of-type { border-bottom: none; }
  .qa-params-name { width: 240px; flex: none; }
  .qa-params-name input { font-family: var(--bp-font-family-monospace, monospace); }
  .qa-params-values { flex: 1; min-width: 260px; }
  .qa-params-count { flex: none; width: 70px; line-height: 30px; font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }
  .qa-params-hint { flex-basis: 100%; font-size: 12px; display: flex; align-items: center; gap: 6px; }
  .qa-params-error { color: #cd4246; }
  .bp6-dark & .qa-params-error { color: #fa999c; }
  .qa-params-then { text-align: center; font-size: 12px; margin: -4px 0 6px; }
  .qa-params-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  @media (max-width: 700px) { .qa-params-name { width: 100%; } }
`;

const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const unique = values => values.filter((value, index) => values.findIndex(other => same(other, value)) === index);

const number_pattern = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
const number = text => number_pattern.test(text.trim()) ? Number(text) : NaN;


// "From 0 to 1, 5 values": fills a row with evenly spaced values
const RangeForm = ({ row, onApply }) => {
  const id = useId();
  const numbers = row.values.filter(v => typeof v === 'number');
  const [from, setFrom] = useState(numbers.length ? String(Math.min(...numbers)) : '0');
  const [to, setTo] = useState(numbers.length > 1 ? String(Math.max(...numbers)) : '1');
  const [count, setCount] = useState('5');
  const [scale, setScale] = useState('linear');
  const [integer, setInteger] = useState(false);
  const range = range_values({ from: number(from), to: number(to), count: /^\d+$/.test(count.trim()) ? Number(count) : NaN, scale, integer });
  const field = (label, value, onChange, width = 90) => <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
    <span className={Classes.TEXT_MUTED}>{label}</span>
    <InputGroup value={value} onChange={e => onChange(e.target.value)} style={{ width }} inputMode="decimal"/>
  </label>;
  return <div style={{ padding: 14, width: 340 }} data-testid="parameters-range">
    <div style={{ fontWeight: 600, marginBottom: 8 }}>Evenly spaced values</div>
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 10 }}>
      {field('From', from, setFrom)}
      {field('To', to, setTo)}
      {field('How many', count, setCount, 80)}
    </div>
    <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 10 }}>
      <SegmentedControl
        size="small"
        aria-label="Spacing"
        options={[{ label: 'Linear', value: 'linear' }, { label: 'Log', value: 'log' }]}
        value={scale}
        onValueChange={setScale}
      />
      <Switch id={`${id}-integer`} label="Whole numbers" checked={integer} onChange={e => setInteger(e.target.checked)} style={{ margin: 0 }}/>
    </div>
    <div className={Classes.TEXT_MUTED} style={{ fontSize: 12, minHeight: 34, marginBottom: 10, overflowWrap: 'anywhere' }} data-testid="parameters-range-preview">
      {range.error ?? (range.values.length > 12
        ? `${range.values.slice(0, 6).join(', ')} … ${range.values.slice(-3).join(', ')} (${range.values.length} values)`
        : range.values.join(', '))}
      {scale === 'log' && !range.error && <div>As many values between 0.001 and 0.01 as between 0.01 and 0.1.</div>}
    </div>
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
      {row.values.length > 0 && <Button className={Classes.POPOVER_DISMISS} text="Add to its values" disabled={!!range.error} onClick={() => onApply(unique([...row.values, ...range.values]))}/>}
      <Button className={Classes.POPOVER_DISMISS} intent={Intent.PRIMARY} text={row.values.length > 0 ? 'Replace its values' : 'Use these values'} disabled={!!range.error} onClick={() => onApply(range.values)}/>
    </div>
  </div>;
};


let last_key = 0;
const with_keys = sets => sets.map(rows => ({ key: ++last_key, rows: rows.map(row => ({ ...row, key: ++last_key })) }));
const without_keys = sets => sets.map(set => set.rows);
const empty_row = () => ({ key: ++last_key, name: '', values: [] });

/**
 * The parameters and the values to try, as a table.
 * `value` is the text, `onChange` gets the new text. `known`: names to suggest. Render it only for text the table
 * can show (parse_sets(value).sets).
 */
export const ParametersTable = ({ value, onChange, known = [] }) => {
  const id = useId();
  // rows being written (no name, no values yet) are not in the text: we keep them here
  const [state, setState] = useState(() => ({ text: value, sets: with_keys(parse_sets(value).sets ?? [[]]) }));
  let sets = state.sets;
  if (value !== state.text) {
    // the text changed elsewhere: the editor, "Start from a previous batch"...
    sets = with_keys(parse_sets(value).sets ?? [[]]);
    setState({ text: value, sets });
  }
  const commit = next => {
    const text = serialize_sets(without_keys(next));
    setState({ text, sets: next });
    if (text !== value) onChange(text);
  };
  const changeSet = (set_index, rows) => commit(sets.map((set, index) => index === set_index ? { ...set, rows } : set));
  const several = sets.length > 1;
  // sets without a parameter that has a name and values are not in the text: they don't run
  const filled = sets.map(set => set.rows.some(row => row.name.trim() && row.values.length > 0));
  const combinations = sets.map(set => set_combinations(set.rows));
  const total = combinations.reduce((sum, n, index) => sum + (filled[index] ? n : 0), 0);
  const n_parameters = new Set(sets.flatMap(set => set.rows.filter(row => row.name.trim() && row.values.length > 0).map(row => row.name.trim()))).size;

  return <Table data-testid="parameters-table">
    {sets.map((set, set_index) => {
      const names = set.rows.map(row => row.name.trim());
      const changeRow = (row_index, changes) => changeSet(set_index, set.rows.map((row, index) => index === row_index ? { ...row, ...changes } : row));
      // "a=1\nb=2", or JSON: several parameters at once
      const paste = (row_index, event) => {
        const pasted = pasted_parameters(event.clipboardData?.getData('text') ?? '');
        if (!pasted) return;
        event.preventDefault();
        const rows = set.rows.filter((row, index) => index !== row_index || row.name.trim() || row.values.length > 0);
        for (const parameter of pasted) {
          const existing = rows.findIndex(row => row.name.trim() === parameter.name);
          if (existing >= 0) rows[existing] = { ...rows[existing], values: parameter.values };
          else rows.push({ key: ++last_key, ...parameter });
        }
        changeSet(set_index, rows);
      };
      return <div key={set.key}>
        {several && set_index > 0 && <div className={`qa-params-then ${Classes.TEXT_MUTED}`}>and also</div>}
        <div className={several ? 'qa-params-set' : undefined} data-testid={`parameters-set-${set_index}`}>
          {several && <div className="qa-params-set-title">
            <span>Set {set_index + 1}</span>
            <span className={Classes.TEXT_MUTED} style={{ fontWeight: 400, fontSize: 12 }}>{filled[set_index] ? plural(combinations[set_index], 'combination') : 'empty: not counted'}</span>
            <Button variant="minimal" size="small" icon="trash" aria-label={`Remove set ${set_index + 1}`} style={{ marginLeft: 'auto' }} onClick={() => commit(sets.filter((_, index) => index !== set_index))}/>
          </div>}
          {set.rows.length === 0 && <p className={Classes.TEXT_MUTED} style={{ margin: '8px 0' }}>
            {several ? 'No parameter yet.' : 'No parameter: the tests run once, as they are. Add parameters to try other values.'}
          </p>}
          {set.rows.map((row, row_index) => {
            const name = row.name.trim();
            const duplicate = !!name && names.indexOf(name) !== row_index;
            return <div className="qa-params-row" key={row.key} data-testid={`parameters-row-${set_index}-${row_index}`}>
              <InputGroup
                className="qa-params-name"
                aria-label="Parameter name"
                placeholder="name, e.g. threshold"
                value={row.name}
                list={`${id}-known`}
                intent={duplicate ? Intent.DANGER : undefined}
                onChange={e => changeRow(row_index, { name: e.target.value })}
                onPaste={e => paste(row_index, e)}
              />
              <TagInput
                className="qa-params-values"
                inputProps={{ 'aria-label': `Values to try${name ? ` for ${name}` : ''}` }}
                placeholder="values to try: Enter after each, or 1, 2, 3"
                values={row.values.map(format_value)}
                onChange={values => changeRow(row_index, { values: unique(values.flatMap(v => split_values(String(v))).map(parse_value)) })}
                separator={false}
                addOnBlur
                tagProps={{ minimal: true }}
              />
              <span className={`qa-params-count ${Classes.TEXT_MUTED}`}>{row.values.length > 0 && plural(row.values.length, 'value')}</span>
              <PopoverNext placement="bottom-end" content={<RangeForm row={row} onApply={values => changeRow(row_index, { values })}/>}>
                <Tooltip content="Evenly spaced values: from, to, how many" hoverOpenDelay={400}>
                  <Button variant="minimal" icon="array-numeric" aria-label={`Evenly spaced values${name ? ` for ${name}` : ''}`}/>
                </Tooltip>
              </PopoverNext>
              <Button variant="minimal" icon="trash" aria-label={`Remove ${name || 'this parameter'}`} onClick={() => changeSet(set_index, set.rows.filter((_, index) => index !== row_index))}/>
              {duplicate
                ? <div className="qa-params-hint qa-params-error"><Icon icon="error" size={12}/> {name} is already listed{several ? ' in this set' : ''}: only the last one counts.</div>
                : !name
                  ? <div className={`qa-params-hint ${Classes.TEXT_MUTED}`}><Icon icon="edit" size={12}/> Name it like your code reads it, e.g. <code>threshold</code> or <code>denoise.strength</code>. Not counted until it has a name.</div>
                  : row.values.length === 0
                    ? <div className={`qa-params-hint ${Classes.TEXT_MUTED}`}><Icon icon="edit" size={12}/> Add the values to try. Not counted until it has one.</div>
                    : row.values.length === 1 && <div className={`qa-params-hint ${Classes.TEXT_MUTED}`}><Icon icon="pin" size={12}/> One value: every run uses it.</div>}
            </div>;
          })}
          <Button icon="add" text="Add a parameter" size={several ? 'small' : undefined} onClick={() => changeSet(set_index, [...set.rows, empty_row()])} style={{ marginTop: 8 }} data-testid={`parameters-add-${set_index}`}/>
        </div>
      </div>;
    })}
    <datalist id={`${id}-known`}>{known.map(name => <option key={name} value={name}>{name}</option>)}</datalist>
    <div className="qa-params-actions" style={{ marginTop: 10 }}>
      <Tooltip
        content={<div style={{ maxWidth: 320 }}>Within a set, every combination of the values runs. Add a set for values that go together, like a low and a high threshold that only make sense in pairs: sets run one after the other.</div>}
        hoverOpenDelay={300}
      >
        <Button variant="minimal" icon="add-to-artifact" text="Add a set of values that go together" onClick={() => commit([...sets, { key: ++last_key, rows: [empty_row()] }])} data-testid="parameters-add-set"/>
      </Tooltip>
      <span className={Classes.TEXT_MUTED} style={{ marginLeft: 'auto', fontSize: 12 }} data-testid="parameters-summary">
        {n_parameters === 0
          ? 'No tuning'
          : <>{plural(n_parameters, 'parameter')}, <strong>{plural(total, 'combination')}</strong>{filled.filter(Boolean).length > 1 && ` in ${filled.filter(Boolean).length} sets`}</>}
      </span>
    </div>
    {sets.every(set => set.rows.length === 0) && <Callout icon="lightbulb" style={{ marginTop: 10 }} compact>
      Paste lines like <code>block.gain=4</code>, or JSON, in a name to add several parameters at once.
    </Callout>}
  </Table>;
};

export default ParametersTable;
