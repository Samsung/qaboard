// The control of each type of setting. Switches and choices save at once (with "Undo" in the toast), texts,
// numbers and lists show Save and Cancel once changed. Secrets are write-only: admins replace or clear them.
import { useState } from "react";
import {
  Button, Classes, HTMLSelect, InputGroup, Intent, NumericInput, SegmentedControl, Switch, Tag, TagInput, TextArea, Tooltip,
} from "@blueprintjs/core";
import styled from "styled-components";

import { formatSettingValue } from "../settingValue";
import { settingType, unit_labels } from "./model";
import { SecretValue } from "./values";


export const ErrorText = styled.div.attrs({ role: 'alert' })`
  font-size: 12px;
  color: var(--qa-text-danger);
  margin-top: 4px;
  overflow-wrap: anywhere;
`;

const Row = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  min-width: 0;
  > .grow { flex: 1 1 180px; min-width: 0; }
`;

const EditButtons = ({ saving, onCancel, disabled }) => <>
  <Button type="submit" size="small" intent={Intent.PRIMARY} text="Save" loading={saving} disabled={disabled}/>
  <Button size="small" variant="minimal" text="Cancel" onClick={onCancel} disabled={saving}/>
</>;

const label_of = setting => `Value of ${setting.key}`;


export const BoolControl = ({ setting, saving, save }) => <Switch
  checked={!!setting.value}
  disabled={saving}
  onChange={() => save(!setting.value)}
  aria-label={label_of(setting)}
  labelElement={setting.value ? 'On' : 'Off'}
  style={{ marginBottom: 0 }}
  large
/>;


// A few short choices are buttons side by side, the others a menu
export const ChoiceControl = ({ setting, saving, save }) => {
  const choices = setting.choices ?? [];
  const nullable = setting.nullable || setting.value === null;
  if (choices.length <= 3 && !nullable && choices.every(choice => String(choice).length <= 12))
    return <SegmentedControl
      aria-label={label_of(setting)}
      size="small"
      value={setting.value ?? ''}
      onValueChange={value => value !== setting.value && save(value)}
      options={choices.map(choice => ({ value: choice, label: choice, disabled: saving }))}
    />;
  return <HTMLSelect
    aria-label={label_of(setting)}
    value={setting.value ?? ''}
    disabled={saving}
    onChange={e => save(e.target.value === '' ? null : e.target.value)}
    options={[...(nullable ? [{ value: '', label: 'Not set' }] : []), ...choices.map(choice => ({ value: choice, label: choice }))]}
  />;
};


// Texts and numbers: Save and Cancel appear once the value changed. Enter saves, Escape cancels.
export const TextControl = ({ setting, saving, save, error, setError }) => {
  const type = settingType(setting);
  const initial = formatSettingValue(setting.value);
  const [text, setText] = useState(initial);
  const [base, setBase] = useState(initial);
  // the value changed elsewhere (saved, reset): we follow it, unless admins are typing
  if (initial !== base) {
    setBase(initial);
    setText(initial);
  }
  const dirty = text !== initial;
  const cancel = () => { setText(initial); setError(null); };
  const submit = event => {
    event.preventDefault();
    const trimmed = text.trim();
    if (trimmed === '') {
      if (setting.nullable) return save(null);
      return setError(setting.default !== null && setting.default !== undefined ? 'Type a value, or reset it to its default.' : 'Type a value.');
    }
    if (type === 'int') {
      const value = Number(trimmed);
      if (!Number.isInteger(value)) return setError('Type a whole number.');
      if (setting.minimum !== null && setting.minimum !== undefined && value < setting.minimum) return setError(`At least ${setting.minimum}.`);
      if (setting.maximum !== null && setting.maximum !== undefined && value > setting.maximum) return setError(`At most ${setting.maximum}.`);
      return save(value);
    }
    save(trimmed);
  };
  const keys = e => { if (e.key === 'Escape') cancel(); };
  const unit = setting.unit ? (unit_labels[setting.unit]?.[1] ?? setting.unit) : null;
  const placeholder = setting.nullable ? (setting.default_text ? 'Not set: the default' : 'Not set') : setting.placeholder ?? '';
  let input;
  if (type === 'int')
    input = <NumericInput
      className="grow"
      value={text}
      onValueChange={(_, value) => { setText(value); setError(null); }}
      aria-label={label_of(setting)}
      placeholder={placeholder || 'A number'}
      intent={error ? Intent.DANGER : undefined}
      min={setting.minimum ?? undefined}
      max={setting.maximum ?? undefined}
      minorStepSize={null}
      size="small"
      onKeyDown={keys}
      rightElement={unit ? <Tag minimal>{unit}</Tag> : undefined}
      fill
      style={{ minWidth: 80 }}
    />;
  else if (setting.multiline)
    input = <TextArea
      className="grow"
      value={text}
      onChange={e => { setText(e.target.value); setError(null); }}
      aria-label={label_of(setting)}
      placeholder={setting.placeholder ?? placeholder}
      intent={error ? Intent.DANGER : undefined}
      autoResize
      fill
      onKeyDown={keys}
    />;
  else
    input = <InputGroup
      className="grow"
      value={text}
      onChange={e => { setText(e.target.value); setError(null); }}
      aria-label={label_of(setting)}
      placeholder={setting.placeholder ?? placeholder}
      intent={error ? Intent.DANGER : undefined}
      size="small"
      onKeyDown={keys}
      fill
    />;
  return <form onSubmit={submit}>
    <Row>
      {input}
      {dirty && <EditButtons saving={saving} onCancel={cancel}/>}
    </Row>
    {setting.nullable && dirty && text.trim() === '' && <div className={Classes.TEXT_MUTED} style={{ fontSize: 12, marginTop: 4 }}>Empty: not set{setting.default_text ? `, ${setting.default_text.charAt(0).toLowerCase()}${setting.default_text.slice(1)}` : ''}</div>}
  </form>;
};


// Lists are tags: type and press Enter or a comma, paste a comma-separated list
export const ListControl = ({ setting, saving, save }) => {
  const initial = Array.isArray(setting.value) ? setting.value : [];
  const [values, setValues] = useState(initial);
  const [base, setBase] = useState(initial);
  if (JSON.stringify(initial) !== JSON.stringify(base)) {
    setBase(initial);
    setValues(initial);
  }
  const dirty = JSON.stringify(values) !== JSON.stringify(initial);
  const add = added => setValues(current => [...current, ...added.map(v => v.trim()).filter(v => v && !current.includes(v))]);
  return <form onSubmit={e => { e.preventDefault(); save(values); }}>
    <Row>
      <TagInput
        className="grow"
        values={values}
        onAdd={add}
        onRemove={(_, index) => setValues(current => current.filter((__, i) => i !== index))}
        addOnBlur
        addOnPaste
        separator={/[,\n]/}
        size="small"
        placeholder={values.length ? '' : setting.placeholder ? `e.g. ${setting.placeholder}` : 'Type, then Enter'}
        inputProps={{ 'aria-label': label_of(setting) }}
        tagProps={{ minimal: true }}
        disabled={saving}
        fill
        rightElement={values.length > 1 ? <Tooltip content="Remove all" hoverOpenDelay={300}><Button variant="minimal" size="small" icon="cross" aria-label="Remove all" onClick={() => setValues([])}/></Tooltip> : undefined}
      />
      {dirty && <EditButtons saving={saving} onCancel={() => setValues(initial)}/>}
    </Row>
  </form>;
};


// The new value of a secret, hidden while typed (with a button to show it)
export const SecretInput = ({ value, onChange, label, placeholder, autoFocus, intent, onKeyDown }) => {
  const [shown, setShown] = useState(false);
  return <InputGroup
    className="grow"
    type={shown ? 'text' : 'password'}
    autoComplete="new-password"
    value={value}
    onChange={e => onChange(e.target.value)}
    aria-label={label}
    placeholder={placeholder}
    autoFocus={autoFocus}
    intent={intent}
    size="small"
    onKeyDown={onKeyDown}
    fill
    rightElement={<Tooltip content={shown ? 'Hide' : 'Show'} hoverOpenDelay={300}>
      <Button variant="minimal" size="small" icon={shown ? 'eye-off' : 'eye-open'} aria-label={shown ? 'Hide the value' : 'Show the value'} onClick={() => setShown(!shown)}/>
    </Tooltip>}
  />;
};

// Secrets are never shown again: "Set" or "Not set", then Replace, Clear
export const SecretControl = ({ setting, saving, save, setError }) => {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const is_set = setting.is_set ?? !!setting.value;
  const cancel = () => { setEditing(false); setText(''); setError(null); };
  if (!editing)
    return <Row>
      <SecretValue value={setting.value}/>
      <Button size="small" variant="outlined" icon={is_set ? 'refresh' : 'key'} text={is_set ? 'Replace' : 'Set'} aria-label={`${is_set ? 'Replace' : 'Set'} ${setting.key}`} onClick={() => setEditing(true)}/>
    </Row>;
  return <form onSubmit={e => {
    e.preventDefault();
    if (!text.trim()) return setError('Type the new value.');
    save(text).then(ok => ok && cancel());
  }}>
    <Row>
      <SecretInput
        value={text}
        onChange={value => { setText(value); setError(null); }}
        label={label_of(setting)}
        placeholder={is_set ? 'The new value (the current one stays hidden)' : setting.placeholder ?? 'The value'}
        autoFocus
        onKeyDown={e => { if (e.key === 'Escape') cancel(); }}
      />
      <EditButtons saving={saving} onCancel={cancel}/>
    </Row>
    <div className={Classes.TEXT_MUTED} style={{ fontSize: 12, marginTop: 4 }}>Encrypted before it's saved. Nobody can read it here afterwards.</div>
  </form>;
};
