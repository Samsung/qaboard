// How settings' values read: "On", "90 days", tags for lists, "Set" for secrets, a count for records.
import { Classes, Icon, Tag, Tooltip } from "@blueprintjs/core";
import styled from "styled-components";

import { copyWithToast } from "../../utils/clipboard";

import { formatSettingValue } from "../settingValue";
import { isEmpty, settingType, withUnit } from "./model";


export const NotSet = ({ text }) => <span className={Classes.TEXT_MUTED}>{text ?? 'Not set'}</span>;

export const SecretValue = ({ value, unset }) => value
  ? <Tag minimal round icon="lock" title="Hidden: it's never shown again.">{typeof value === 'string' && value.includes('://') ? value : 'Set'}</Tag>
  : <NotSet text={unset}/>;

// `setting` gives the type and unit, else the value is shown as it is
export const SettingValue = ({ setting, value }) => {
  const type = setting ? settingType(setting) : null;
  if (setting?.secret) return <SecretValue value={value}/>;
  if (type === 'records') {
    if (!Array.isArray(value) || !value.length) return <NotSet text="None"/>;
    return <span>{value.length} {value.length === 1 ? 'entry' : 'entries'}</span>;
  }
  if (isEmpty(value)) return <NotSet/>;
  if (typeof value === 'boolean') return <span>{value ? 'On' : 'Off'}</span>;
  const with_unit = withUnit(value, setting?.unit);
  if (with_unit) return <span>{with_unit}</span>;
  // e.g. email domains, origins
  if (Array.isArray(value) && value.every(item => typeof item === 'string'))
    return <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, minWidth: 0 }}>
      {value.map(item => <Tag key={item} minimal style={{ maxWidth: '100%' }} title={item}>{item}</Tag>)}
    </span>;
  return <code className={Classes.CODE} style={{ overflowWrap: 'anywhere' }}>{formatSettingValue(value)}</code>;
};

// A read-only value, e.g. set by the environment
export const ReadOnlyValue = ({ setting, value = setting.value }) => <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
  <Icon icon="lock" size={12} className={Classes.TEXT_MUTED} aria-hidden/>
  <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}><SettingValue setting={setting} value={value}/></span>
</span>;


const CodeButton = styled.button`
  all: unset;
  cursor: copy;
  border-radius: 3px;
  overflow-wrap: anywhere;
  &:hover code, &:focus-visible code { color: var(--qa-text); }
  &:focus-visible { outline: 2px solid var(--qa-intent-primary); outline-offset: 1px; }
`;

// A name or a command, copied when clicked
export const CopyCode = ({ text, what = 'it', plain = false }) => <Tooltip content={`Copy ${what}`} hoverOpenDelay={500}>
  <CodeButton type="button" onClick={() => copyWithToast(text, { what })} aria-label={`Copy ${what}: ${text}`}>
    <code className={plain ? undefined : Classes.CODE}>{text}</code>
  </CodeButton>
</Tooltip>;
