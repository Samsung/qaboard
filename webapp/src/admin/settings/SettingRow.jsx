// One setting: what it does and where its value comes from on the left, its control on the right.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Classes, Icon, Intent, Tooltip } from "@blueprintjs/core";
import { keyframes } from "styled-components";
import styled from "styled-components";

// a setting linked to (?setting=key) stands out for a moment
const flash = keyframes`
  from { background: var(--qa-highlight); }
  70% { background: var(--qa-highlight); }
  to { background: transparent; }
`;

import { errorMessage } from "../../api/http";
import { toaster } from "../../toaster";
import { useSiteConfig } from "../../hooks";
import { WithCode } from "../../settings/format";
import { saveSetting, importSettingFromEnv } from "../api";
import { settingType, isEmpty, hasSecrets } from "./model";
import { SourceTag, EnvActions, Hint } from "./Provenance";
import { SettingValue, ReadOnlyValue, NotSet, CopyCode, SecretValue } from "./values";
import { BoolControl, ChoiceControl, TextControl, ListControl, SecretControl, ErrorText } from "./controls";
import { RecordsControl } from "./RecordsEditor";


export const Rows = styled.div`
  border: 1px solid var(--qa-border);
  border-radius: 6px;
  background: var(--qa-surface);
  > * + * { border-top: 1px solid var(--qa-border); }
`;

const Row = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(240px, 360px);
  gap: 8px 24px;
  padding: 14px 16px;
  scroll-margin-top: 80px;
  &.highlighted { animation: ${flash} 3s ease-out; }
  &.wide { grid-template-columns: minmax(0, 1fr); }
  .title { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
  .label { font-weight: 600; font-size: 14px; }
  .meta { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 12px; margin-top: 3px; color: var(--qa-text-muted); }
  .meta code { background: none; box-shadow: none; padding: 0; font-size: 12px; color: inherit; }
  .description { margin: 6px 0 0; color: var(--qa-text-secondary); line-height: 1.5; max-width: 72ch; overflow-wrap: anywhere; }
  .control { min-width: 0; align-self: center; }
  .footer { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 12px; margin-top: 6px; color: var(--qa-text-muted); }
  @media (max-width: 760px) {
    grid-template-columns: minmax(0, 1fr);
    .control { align-self: start; }
  }
`;

export const docsUrl = (docs_root, path) => path?.startsWith('/docs/') ? `${docs_root}${path.slice(1)}` : path;

const DocsLink = ({ path }) => {
  const { docs_root } = useSiteConfig();
  if (!path) return null;
  return <a href={docsUrl(docs_root ?? '/', path)} target="_blank" rel="noopener noreferrer">Docs <Icon icon="share" size={10}/></a>;
};

const CopyKey = ({ name, what }) => <CopyCode text={name} what={what} plain/>;

const shortValue = (setting, value) => {
  if (setting.secret) return value ? 'set' : 'cleared';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (value === null || value === undefined) return 'its default';
  if (Array.isArray(value)) return value.length ? `${value.length} ${value.length === 1 ? 'value' : 'values'}` : 'empty';
  return String(value).length > 40 ? `${String(value).slice(0, 40)}…` : String(value);
};


export const SettingRow = ({ setting, highlighted, wide }) => {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState(null);
  const type = settingType(setting);
  const from_env = setting.source === 'env';
  const can_edit = setting.editable !== false && !from_env;
  const label = setting.label ?? setting.key;

  // => whether it was saved. Switches and choices offer to undo.
  const save = (value, { undo = false } = {}) => {
    setSaving(true);
    setError(null);
    const previous = setting.source === 'database' ? setting.value : null;
    return saveSetting(queryClient, setting.key, value)
      .then(() => {
        toaster.show({
          message: value === null ? `${label}: back to its default` : `${label}: ${shortValue(setting, value)}`,
          intent: Intent.SUCCESS,
          icon: 'tick',
          timeout: undo ? 6000 : 3000,
          action: undo ? { text: 'Undo', onClick: () => saveSetting(queryClient, setting.key, previous).catch(e => toaster.show({ message: errorMessage(e), intent: Intent.DANGER })) } : undefined,
        }, `setting-${setting.key}`);
        return true;
      })
      .catch(e => { setError(errorMessage(e)); return false; })
      .finally(() => setSaving(false));
  };
  const importEnv = () => {
    setImporting(true);
    importSettingFromEnv(queryClient, setting.key)
      .then(() => toaster.show({ message: <>Saved here. Now remove <code>${setting.env}</code> from the server's environment, and restart it.</>, intent: Intent.SUCCESS, icon: 'tick', timeout: 10000 }))
      .catch(e => setError(errorMessage(e)))
      .finally(() => setImporting(false));
  };

  const control_props = { setting, saving, save, error, setError };
  let control;
  if (!can_edit)
    control = type === 'records' ? <RecordsControl {...control_props} readOnly/> : <ReadOnlyValue setting={setting}/>;
  else if (type === 'records')
    control = <RecordsControl {...control_props} onRemoveAll={() => save(null)}/>;
  else if (setting.secret)
    control = <SecretControl {...control_props}/>;
  else if (type === 'bool')
    control = <BoolControl {...control_props} save={value => save(value, { undo: true })}/>;
  else if (setting.choices?.length)
    control = <ChoiceControl {...control_props} save={value => save(value, { undo: true })}/>;
  else if (type === 'list')
    control = <ListControl {...control_props}/>;
  else
    control = <TextControl {...control_props}/>;

  const at_default = setting.source === 'default';
  const reset_text = setting.secret ? 'Clear' : hasSecrets(setting) ? 'Remove all' : 'Reset to default';
  const show_default = !at_default && !setting.secret && type !== 'records';
  const problem = setting.layers?.env?.error || setting.layers?.database?.error;

  return <Row
    data-testid={`setting-${setting.key}`}
    id={`setting-${setting.key}`}
    className={[highlighted && 'highlighted', (wide || type === 'records') && 'wide'].filter(Boolean).join(' ')}
    aria-label={label}
    role="group"
  >
    <div>
      <div className="title">
        <span className="label">{label}</span>
        <SourceTag setting={setting}/>
      </div>
      <div className="meta">
        <CopyKey name={setting.key} what="the setting's name"/>
        {setting.env && <Tooltip content="Its environment variable: it wins over this page" hoverOpenDelay={500}><code>${setting.env}</code></Tooltip>}
        <DocsLink path={setting.docs}/>
      </div>
      <p className="description"><WithCode text={setting.description}/></p>
      {problem && <Hint icon="error" intent={Intent.DANGER}><span style={{ color: 'var(--qa-text-danger)' }}>{problem}{setting.layers?.env?.error ? '. QA-Board ignores it: fix it where the server is deployed.' : ''}</span></Hint>}
      {at_default && setting.default_text && <Hint icon="info-sign">Default: {setting.default_text}</Hint>}
      <EnvActions setting={setting} importing={importing} onImport={importEnv} onDeleteSaved={() => save(null)}/>
      {can_edit && !at_default && type !== 'records' && <div className="footer">
        {show_default && <span>Default: <SettingValue setting={setting} value={setting.default}/>{setting.default_text ? <> · {setting.default_text}</> : null}</span>}
        <Button
          size="small"
          variant="minimal"
          icon={setting.secret ? 'eraser' : 'reset'}
          text={reset_text}
          aria-label={`Reset ${setting.key} to its default`}
          disabled={saving}
          onClick={() => save(null)}
        />
      </div>}
    </div>
    <div className="control">
      {control}
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  </Row>;
};


// A variable only the server's environment sets: read-only, with why
export const VariableRow = ({ variable }) => <Row data-testid={`variable-${variable.key}`} role="group" aria-label={variable.label}>
  <div>
    <div className="title">
      <span className="label">{variable.label}</span>
    </div>
    <div className="meta">
      <CopyKey name={variable.key} what="the variable's name"/>
      <DocsLink path={variable.docs}/>
    </div>
    <p className="description">{variable.description}</p>
    <Hint icon="lock">{variable.why}</Hint>
  </div>
  <div className="control">
    {variable.secret
      ? <SecretValue value={!isEmpty(variable.value)} unset={variable.default_text ? `Not set: ${variable.default_text.charAt(0).toLowerCase()}${variable.default_text.slice(1)}` : undefined}/>
      : !isEmpty(variable.value)
        ? <ReadOnlyValue setting={variable} value={variable.value}/>
        : <span><NotSet/>{variable.default_text && <span className={Classes.TEXT_MUTED}> · default: <code>{variable.default_text}</code></span>}</span>}
  </div>
</Row>;


// e.g. on the sign-in page: some settings, in the same rows
export const SettingsList = ({ settings, label = "Settings" }) => <Rows role="list" aria-label={label}>
  {settings.map(setting => <SettingRow key={setting.key} setting={setting}/>)}
</Rows>;
