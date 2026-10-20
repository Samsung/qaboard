// Admin → Settings: each setting with where its value comes from. The environment wins over the database,
// which wins over the default (design/user-management.md §4.5): settings from the environment can't be edited here.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Classes, Colors, HTMLTable, InputGroup, Intent, NonIdealState, Tag, Tooltip } from "@blueprintjs/core";

import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { Loading } from "../settings/states";
import { AdminError } from "./states";
import { settingsQuery, saveSetting } from "./api";
import { formatSettingValue, parseSettingValue } from "./settingValue";


export const SourceTag = ({ setting }) => {
  if (setting.source === 'env')
    return <Tooltip content={<>Set by <code>{setting.env ?? 'the environment'}</code> in the server's environment: change it there.</>} hoverOpenDelay={300}>
      <Tag minimal intent={Intent.WARNING} icon="lock">environment</Tag>
    </Tooltip>;
  if (setting.source === 'database')
    return <Tooltip content="Changed here, by an admin" hoverOpenDelay={300}><Tag minimal intent={Intent.PRIMARY}>database</Tag></Tooltip>;
  return <Tag minimal>default</Tag>;
};

const Value = ({ value }) => {
  if (value === null || value === undefined) return <span className={Classes.TEXT_MUTED}>Not set</span>;
  if (Array.isArray(value) && value.length === 0) return <span className={Classes.TEXT_MUTED}>None</span>;
  return <code className={Classes.CODE} style={{ overflowWrap: 'anywhere' }}>{formatSettingValue(value)}</code>;
};

const placeholders = {
  boolean: 'true or false',
  number: 'a number',
  object: 'a list, e.g. a, b',
};

const SettingRow = ({ setting }) => {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const like = setting.value ?? setting.default;
  const can_edit = !!setting.editable && setting.source !== 'env';

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
    const parsed = parseSettingValue(text, like);
    if (parsed.error) return setError(parsed.error);
    save(parsed.value);
  };

  return <tr data-testid={`setting-${setting.key}`}>
    <td><code>{setting.key}</code></td>
    <td style={{ minWidth: 220 }}>
      {editing
        ? <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            <InputGroup
              value={text}
              onChange={e => setText(e.target.value)}
              aria-label={`Value of ${setting.key}`}
              placeholder={placeholders[like === null || like === undefined ? '' : typeof like] ?? 'a value'}
              intent={error ? Intent.DANGER : undefined}
              autoFocus
              size="small"
              onKeyDown={e => { if (e.key === 'Escape') setEditing(false); }}
              style={{ minWidth: 140 }}
            />
            <Button type="submit" size="small" intent={Intent.PRIMARY} text="Save" loading={saving}/>
            <Button size="small" variant="minimal" text="Cancel" onClick={() => setEditing(false)}/>
          </div>
          {error && <span style={{ fontSize: 12, color: Colors.RED3 }} role="alert">{error}</span>}
        </form>
        : <Value value={setting.value}/>}
    </td>
    <td><SourceTag setting={setting}/></td>
    <td className={Classes.TEXT_MUTED} style={{ maxWidth: 420 }}>
      {setting.description}
      {setting.source !== 'default' && <div style={{ fontSize: 12 }}>Default: <Value value={setting.default}/></div>}
    </td>
    <td style={{ whiteSpace: 'nowrap' }}>
      {can_edit && !editing && <Button size="small" icon="edit" variant="minimal" text="Edit" aria-label={`Edit ${setting.key}`} onClick={edit}/>}
      {can_edit && !editing && setting.source === 'database' && <Button
        size="small"
        icon="reset"
        variant="minimal"
        text="Reset"
        aria-label={`Reset ${setting.key} to its default`}
        loading={saving}
        onClick={() => save(null)}
      />}
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
      <HTMLTable compact style={{ width: '100%' }} aria-label="Settings">
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
