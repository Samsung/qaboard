// Settings that are lists of records, e.g. the Jenkins servers with their tokens. Each record is a line, edited in
// a dialog. Secret fields are never shown: they're "set" or not, and kept unless admins type a new value.
import { useState } from "react";
import {
  Alert, Button, Checkbox, Classes, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect, Icon, InputGroup, Intent, Tag, Tooltip,
} from "@blueprintjs/core";
import styled from "styled-components";

import { emptyRecord, recordErrors, recordForServer, recordTitle } from "./model";
import { ErrorText, SecretInput } from "./controls";


const List = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--qa-border);
  border-radius: 4px;
  li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 6px 6px 10px;
    border-top: 1px solid var(--qa-border);
    min-width: 0;
  }
  li:first-child { border-top: none; }
  .record-text { flex: 1 1 auto; min-width: 0; }
  .record-title { font-weight: 600; overflow-wrap: anywhere; }
  .record-details { font-size: 12px; overflow-wrap: anywhere; }
  .record-secrets { display: inline-flex; gap: 4px; flex-wrap: wrap; margin-left: 6px; vertical-align: middle; }
`;

const Empty = styled.div`
  border: 1px dashed var(--qa-border);
  border-radius: 4px;
  padding: 10px 12px;
  font-size: 13px;
`;

// The other fields, in a line: "user qa · gitea"
const details = (setting, record) => (setting.fields ?? [])
  .filter(field => !field.secret && field.name !== setting.record_key)
  .map(field => {
    const value = record[field.name];
    if (field.type === 'bool') return value ? field.label.toLowerCase() : null;
    if (Array.isArray(value)) return value.length ? value.join(', ') : null;
    return value ? String(value) : null;
  })
  .filter(Boolean)
  .join(' · ');

const SecretsTags = ({ setting, record }) => <span className="record-secrets">
  {(setting.fields ?? []).filter(field => field.secret).map(field => record[field.name]
    ? <Tag key={field.name} minimal round icon="lock" title={`${field.label}: set, encrypted`}>{field.label}</Tag>
    : field.required ? <Tag key={field.name} minimal round intent={Intent.WARNING} icon="warning-sign">{field.label} missing</Tag> : null)}
</span>;


export const RecordsControl = ({ setting, saving, save, readOnly, error, onRemoveAll }) => {
  const records = Array.isArray(setting.value) ? setting.value : [];
  const [editing, setEditing] = useState(null); // {index, record} (index null: new)
  const [removing, setRemoving] = useState(null);
  const noun = setting.record_noun ?? 'entry';
  const article = /^[aeiou]/i.test(noun) ? 'an' : 'a';
  const send = next => save(next.map(record => recordForServer(setting, record)));

  return <div>
    {records.length
      ? <List aria-label={setting.label}>
        {records.map((record, index) => <li key={record.id ?? index} data-testid={`record-${recordTitle(setting, record)}`}>
          <Icon icon={setting.group === 'jenkins' ? 'build' : setting.group === 'git' ? 'git-repo' : 'document'} className={Classes.TEXT_MUTED} size={14}/>
          <div className="record-text">
            <span className="record-title">{recordTitle(setting, record)}</span>
            <SecretsTags setting={setting} record={record}/>
            {details(setting, record) && <div className={`record-details ${Classes.TEXT_MUTED}`}>{details(setting, record)}</div>}
          </div>
          {!readOnly && <>
            <Tooltip content="Edit" hoverOpenDelay={300}><Button size="small" variant="minimal" icon="edit" aria-label={`Edit ${recordTitle(setting, record)}`} onClick={() => setEditing({ index, record })}/></Tooltip>
            <Tooltip content="Remove" hoverOpenDelay={300}><Button size="small" variant="minimal" icon="trash" aria-label={`Remove ${recordTitle(setting, record)}`} onClick={() => setRemoving(index)}/></Tooltip>
          </>}
        </li>)}
      </List>
      : <Empty className={Classes.TEXT_MUTED}>None yet.</Empty>}
    {!readOnly && <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
      <Button
        size="small"
        icon="plus"
        text={`Add ${article} ${noun}`}
        onClick={() => setEditing({ index: null, record: emptyRecord(setting) })}
        disabled={saving}
      />
      {records.length > 1 && onRemoveAll && <Button size="small" variant="minimal" icon="trash" text="Remove all" aria-label={`Reset ${setting.key} to its default`} onClick={() => setRemoving('all')} disabled={saving}/>}
    </div>}

    <RecordDialog
      setting={setting}
      editing={editing}
      saving={saving}
      error={error}
      onClose={() => setEditing(null)}
      onSave={record => {
        const index = editing?.index ?? null;
        const next = index === null ? [...records, record] : records.map((r, i) => i === index ? record : r);
        return send(next).then(ok => { if (ok) setEditing(null); return ok; });
      }}
    />
    <Alert
      isOpen={removing !== null}
      intent={Intent.DANGER}
      icon="trash"
      confirmButtonText="Remove"
      cancelButtonText="Cancel"
      loading={saving}
      onCancel={() => setRemoving(null)}
      onConfirm={() => (removing === 'all' ? onRemoveAll() : send(records.filter((_, i) => i !== removing))).then(() => setRemoving(null))}
    >
      Remove <strong>{removing === 'all' ? `all the ${records.length} entries` : removing !== null && records[removing] ? recordTitle(setting, records[removing]) : ''}</strong>?
      {(setting.fields ?? []).some(f => f.secret) && <> Its secrets are deleted: to add it back, you'll need them again.</>}
    </Alert>
  </div>;
};


const RecordDialog = ({ setting, editing, saving, error, onClose, onSave }) => <Dialog
  isOpen={!!editing}
  onClose={onClose}
  title={editing?.index === null ? `Add to ${setting.label}` : `Edit ${editing ? recordTitle(setting, editing.record) : ''}`}
  icon={editing?.index === null ? 'plus' : 'edit'}
  style={{ width: 560, maxWidth: 'calc(100vw - 32px)' }}
>
  {editing && <RecordForm key={editing.index ?? 'new'} setting={setting} initial={editing.record} is_new={editing.index === null} saving={saving} error={error} onClose={onClose} onSave={onSave}/>}
</Dialog>;


const RecordForm = ({ setting, initial, is_new, saving, error, onClose, onSave }) => {
  // secret fields: true (kept), or the new text
  const [record, setRecord] = useState(initial);
  const [errors, setErrors] = useState({});
  const [cleared, setCleared] = useState({});
  const set = (name, value) => { setRecord(current => ({ ...current, [name]: value })); setErrors(current => ({ ...current, [name]: undefined })); };
  const submit = event => {
    event.preventDefault();
    const found = recordErrors(setting, record, { is_new });
    setErrors(found);
    if (Object.keys(found).length) return;
    onSave(record);
  };
  return <form onSubmit={submit}>
    <DialogBody>
      {(setting.fields ?? []).map(field => {
        const id = `record-${setting.key}-${field.name}`;
        const value = record[field.name];
        const stored = field.secret && initial[field.name] === true && !is_new;
        let input;
        if (field.secret)
          input = <>
            <SecretInput
              value={typeof value === 'string' ? value : ''}
              onChange={text => set(field.name, text === '' ? (stored && !cleared[field.name] ? true : '') : text)}
              label={field.label}
              placeholder={stored ? (cleared[field.name] ? 'Cleared when you save' : 'Set: leave empty to keep it') : field.required ? 'Required' : 'Optional'}
              intent={errors[field.name] ? Intent.DANGER : undefined}
            />
            {stored && !field.required && <Checkbox
              checked={!!cleared[field.name]}
              label={`Clear the ${field.label.toLowerCase()}`}
              onChange={e => { setCleared(c => ({ ...c, [field.name]: e.target.checked })); set(field.name, e.target.checked ? null : true); }}
              style={{ marginTop: 6, marginBottom: 0 }}
            />}
          </>;
        else if (field.type === 'choice')
          input = <HTMLSelect id={id} value={value ?? ''} onChange={e => set(field.name, e.target.value)} options={field.choices.map(choice => ({ value: choice, label: choice }))} fill/>;
        else if (field.type === 'bool')
          input = <Checkbox id={id} checked={!!value} label={field.label} onChange={e => set(field.name, e.target.checked)} style={{ marginBottom: 0 }}/>;
        else
          input = <InputGroup
            id={id}
            value={Array.isArray(value) ? value.join(', ') : value ?? ''}
            onChange={e => set(field.name, field.type === 'list' ? e.target.value.split(',').map(v => v.trimStart()) : e.target.value)}
            placeholder={field.placeholder ?? ''}
            intent={errors[field.name] ? Intent.DANGER : undefined}
            autoFocus={field.name === setting.record_key || undefined}
            fill
          />;
        return <FormGroup
          key={field.name}
          label={field.type === 'bool' ? undefined : field.label}
          labelFor={field.secret ? undefined : id}
          labelInfo={field.required ? '(required)' : field.secret ? <span title="Encrypted, never shown again"><Icon icon="lock" size={11}/> secret</span> : undefined}
          helperText={errors[field.name] ? undefined : field.help}
          intent={errors[field.name] ? Intent.DANGER : undefined}
          style={{ marginBottom: 14 }}
        >
          {input}
          {errors[field.name] && <ErrorText>{errors[field.name]}</ErrorText>}
        </FormGroup>;
      })}
      {error && <ErrorText>{error}</ErrorText>}
    </DialogBody>
    <DialogFooter actions={<>
      <Button text="Cancel" onClick={onClose} disabled={saving}/>
      <Button type="submit" intent={Intent.PRIMARY} text={is_new ? 'Add' : 'Save'} loading={saving}/>
    </>}>
      {(setting.fields ?? []).some(f => f.secret) && <span className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}><Icon icon="lock" size={11}/> Secrets are encrypted before they're saved.</span>}
    </DialogFooter>
  </form>;
};
