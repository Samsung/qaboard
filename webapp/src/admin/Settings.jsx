// Admin → Settings: each setting with where its value comes from. The environment wins over the database,
// which wins over the default (design/user-management.md §4.5): settings from the environment can't be edited here.
// Each setting has a control for its type (`type` from the server: bool, int, str, list, and `choices`).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, Classes, Colors, HTMLSelect, HTMLTable, InputGroup, Intent, NonIdealState, NumericInput, Switch, Tag, Tooltip,
} from "@blueprintjs/core";

import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { WithCode } from "../settings/format";
import { Loading } from "../settings/states";
import { AdminError } from "./states";
import { settingsQuery, saveSetting } from "./api";
import { formatSettingValue, parseSettingValue } from "./settingValue";


export const SourceTag = ({ setting }) => {
  if (setting.source === 'env')
    return <Tooltip content="Set in the server's environment: change it there." hoverOpenDelay={300}>
      <Tag minimal intent={Intent.WARNING} icon="lock">environment</Tag>
    </Tooltip>;
  if (setting.source === 'database')
    return <Tooltip content="Changed here, by an admin" hoverOpenDelay={300}><Tag minimal intent={Intent.PRIMARY}>database</Tag></Tooltip>;
  return <Tag minimal>default</Tag>;
};

const NotSet = () => <span className={Classes.TEXT_MUTED}>Not set</span>;

export const SettingValue = ({ value }) => {
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) return <NotSet/>;
  if (typeof value === 'boolean') return <span>{value ? 'On' : 'Off'}</span>;
  return <code className={Classes.CODE} style={{ overflowWrap: 'anywhere' }}>{formatSettingValue(value)}</code>;
};

// Servers that predate `type` only give values: we guess from them
const infer_type = value => typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'int' : Array.isArray(value) ? 'list' : typeof value === 'string' ? 'str' : null;
export const settingType = setting => setting.type ?? infer_type(setting.value ?? setting.default);

// What admins type => {value} or {error}
const parseText = (setting, text) => {
  const type = settingType(setting);
  const trimmed = (text ?? '').trim();
  if (trimmed === '' && setting.nullable) return { value: null };
  if (type === 'int') {
    const value = Number(trimmed);
    return trimmed !== '' && Number.isInteger(value) ? { value } : { error: 'Type a whole number.' };
  }
  if (type === 'list') return parseSettingValue(text, []);
  if (type === 'str') return parseSettingValue(text, '');
  return parseSettingValue(text, setting.value ?? setting.default);
};

const placeholders = {
  int: 'A number',
  list: 'Comma-separated, e.g. a, b',
  str: 'A value',
};


const SettingRow = ({ setting }) => {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const type = settingType(setting);
  const from_env = setting.source === 'env';
  const can_edit = setting.editable !== false && !from_env;
  // switches and lists of choices save right away, the others are typed
  const instant = type === 'bool' || !!setting.choices?.length;

  const edit = () => {
    setText(formatSettingValue(setting.value));
    setError(null);
    setEditing(true);
  };
  const save = value => {
    setSaving(true);
    return saveSetting(queryClient, setting.key, value)
      .then(() => {
        setEditing(false);
        setError(null);
        toaster.show({ message: value === null ? `Reset ${setting.key} to its default` : `Saved ${setting.key}`, intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 });
      })
      .catch(error => {
        if (editing) setError(errorMessage(error));
        else toaster.show({ message: errorMessage(error), intent: Intent.DANGER });
      })
      .finally(() => setSaving(false));
  };
  const submit = event => {
    event.preventDefault();
    const parsed = parseText(setting, text);
    if (parsed.error) return setError(parsed.error);
    save(parsed.value);
  };
  const label = `Value of ${setting.key}`;

  let control;
  if (type === 'bool')
    control = <Switch
      checked={!!setting.value}
      disabled={!can_edit || saving}
      onChange={() => save(!setting.value)}
      aria-label={label}
      labelElement={setting.value ? 'On' : 'Off'}
      style={{ marginBottom: 0 }}
    />;
  else if (setting.choices?.length)
    control = can_edit
      ? <HTMLSelect
        aria-label={label}
        value={setting.value ?? ''}
        disabled={saving}
        onChange={e => save(e.target.value === '' ? null : e.target.value)}
        options={[...(setting.nullable || setting.value === null ? [{ value: '', label: 'Not set' }] : []), ...setting.choices.map(choice => ({ value: choice, label: choice }))]}
      />
      : <SettingValue value={setting.value}/>;
  else if (editing)
    control = <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {type === 'int'
          ? <NumericInput
            value={text}
            onValueChange={(_, value) => setText(value)}
            aria-label={label}
            placeholder={setting.nullable ? 'Not set' : placeholders.int}
            intent={error ? Intent.DANGER : undefined}
            min={0}
            minorStepSize={null}
            autoFocus
            size="small"
            onKeyDown={e => { if (e.key === 'Escape') setEditing(false); }}
            style={{ width: 100 }}
          />
          : <InputGroup
            value={text}
            onChange={e => setText(e.target.value)}
            aria-label={label}
            placeholder={setting.nullable ? 'Not set' : placeholders[type] ?? 'A value'}
            intent={error ? Intent.DANGER : undefined}
            autoFocus
            size="small"
            onKeyDown={e => { if (e.key === 'Escape') setEditing(false); }}
            style={{ minWidth: 160 }}
          />}
        <Button type="submit" size="small" intent={Intent.PRIMARY} text="Save" loading={saving}/>
        <Button size="small" variant="minimal" text="Cancel" onClick={() => setEditing(false)}/>
      </div>
      {setting.nullable && <span className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>Leave empty for “Not set”.</span>}
      {error && <span style={{ fontSize: 12, color: Colors.RED3 }} role="alert">{error}</span>}
    </form>;
  else
    control = <SettingValue value={setting.value}/>;

  return <tr data-testid={`setting-${setting.key}`}>
    <td><code style={{ overflowWrap: 'anywhere' }}>{setting.key}</code></td>
    <td>{control}</td>
    <td>
      <SourceTag setting={setting}/>
      {from_env && setting.env && <div className={Classes.TEXT_MUTED} style={{ fontSize: 12, marginTop: 4, overflowWrap: 'anywhere' }}>
        Set by <code>{setting.env}</code>
      </div>}
    </td>
    <td className={Classes.TEXT_MUTED}>
      <WithCode text={setting.description}/>
      {setting.source !== 'default' && <div style={{ fontSize: 12, marginTop: 2 }}>Default: <SettingValue value={setting.default}/></div>}
    </td>
    <td>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {can_edit && !instant && !editing && <Button size="small" icon="edit" variant="minimal" text="Edit" aria-label={`Edit ${setting.key}`} onClick={edit}/>}
        {can_edit && !editing && setting.source === 'database' && <Button
          size="small"
          icon="reset"
          variant="minimal"
          text="Reset"
          aria-label={`Reset ${setting.key} to its default`}
          loading={saving}
          onClick={() => save(null)}
        />}
      </div>
    </td>
  </tr>;
};


export const Settings = () => {
  const { data: settings, isPending, error, refetch } = useQuery(settingsQuery);
  if (isPending) return <Loading label="Loading the settings"/>;
  if (error) return <AdminError error={error} refetch={refetch} what="the settings"/>;
  if (!settings.length) return <NonIdealState icon="cog" title="No settings" description="This server has no settings to show."/>;
  return <section aria-label="Settings">
    <p className={Classes.TEXT_MUTED} style={{ marginTop: 0, maxWidth: 720 }}>
      Settings from the server's environment win, and can only be changed there. The others can be changed here,
      for every replica of the server within a few seconds.
    </p>
    <div style={{ overflowX: 'auto' }}>
      <HTMLTable compact style={{ width: '100%', minWidth: 940, tableLayout: 'fixed' }} aria-label="Settings">
        <colgroup>
          <col style={{ width: 270 }}/>
          <col style={{ width: 210 }}/>
          <col style={{ width: 200 }}/>
          <col/>
          <col style={{ width: 130 }}/>
        </colgroup>
        <thead>
          <tr><th>Setting</th><th>Value</th><th>From</th><th>Description</th><th><span className={Classes.TEXT_MUTED} style={{ fontWeight: 'normal' }}>Actions</span></th></tr>
        </thead>
        <tbody>
          {settings.map(setting => <SettingRow key={setting.key} setting={setting}/>)}
        </tbody>
      </HTMLTable>
    </div>
  </section>;
};

export default Settings;
