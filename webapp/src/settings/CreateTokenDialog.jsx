// Creating an access token, then showing its secret: the only time the server gives it
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button, Callout, Checkbox, Classes, Dialog, DialogBody, DialogFooter, FormGroup, InputGroup, Intent, Radio, RadioGroup, TagInput,
} from "@blueprintjs/core";
import { DateTime } from "luxon";

import { errorMessage } from "../api/http";
import { copyWithToast } from "../utils/clipboard";
import { scopes } from "./format";
import { createToken } from "./api";


export const expiry_presets = [
  { value: '30', label: '30 days', days: 30 },
  { value: '90', label: '90 days', days: 90 },
  { value: '365', label: '1 year', days: 365 },
  { value: 'never', label: 'No expiry', days: null },
];
const default_scopes = ['read', 'ingest'];


// Commands that use the token, each with a copy button
const Snippet = ({ title, code, what }) => <div style={{ marginBottom: 12 }}>
  <div className={Classes.TEXT_MUTED} style={{ fontSize: 12, marginBottom: 4 }}>{title}</div>
  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
    <pre className={Classes.CODE_BLOCK} style={{ flex: 1, margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{code}</pre>
    <Button icon="duplicate" variant="minimal" aria-label={`Copy ${what}`} onClick={() => copyWithToast(code, { what })}/>
  </div>
</div>;

export const TokenSecret = ({ token }) => {
  const origin = window.location.origin;
  return <>
    <Callout intent={Intent.WARNING} icon="eye-open" style={{ marginBottom: 16 }} title="Copy your token now">
      You won't be able to see it again. If you lose it, create another one.
    </Callout>
    <FormGroup label={`Your new token, “${token.name}”`} labelFor="new-token-secret">
      <InputGroup
        id="new-token-secret"
        readOnly
        value={token.token}
        className={Classes.MONOSPACE_TEXT}
        onFocus={event => event.target.select()}
        rightElement={<Button icon="duplicate" text="Copy" intent={Intent.PRIMARY} onClick={() => copyWithToast(token.token, { what: 'the token' })}/>}
      />
    </FormGroup>
    <h5 className={Classes.HEADING}>Use it</h5>
    <Snippet what="the export command" title="In CI or a script: qa reads it from the environment" code={`export QABOARD_TOKEN=${token.token}`}/>
    <Snippet what="the login command" title="On your computer: qa saves it for this server" code={'echo "$QABOARD_TOKEN" | qa auth login --with-token'}/>
    <Snippet what="the curl command" title="With the API" code={`curl -H "Authorization: Bearer $QABOARD_TOKEN" ${origin}/api/v1/user/me/`}/>
  </>;
};


const TokenForm = ({ is_admin, onCreated, onClose }) => {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [chosen_scopes, setScopes] = useState(default_scopes);
  const [projects, setProjects] = useState([]);
  const [expiry, setExpiry] = useState('90');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const offered_scopes = scopes.filter(scope => !scope.admin_only || is_admin);
  const toggleScope = id => setScopes(current => current.includes(id) ? current.filter(s => s !== id) : [...current, id]);
  const preset = expiry_presets.find(p => p.value === expiry);
  const expires_on = preset.days ? DateTime.now().plus({ days: preset.days }).toLocaleString(DateTime.DATE_MED) : null;
  const valid = name.trim().length > 0 && chosen_scopes.length > 0;

  const submit = event => {
    event.preventDefault();
    if (!valid) return;
    setSaving(true);
    setError(null);
    createToken(queryClient, {
      name: name.trim(),
      // in the order we show them
      scopes: offered_scopes.map(s => s.id).filter(id => chosen_scopes.includes(id)),
      projects,
      expires_in_days: preset.days,
    })
      .then(onCreated)
      // e.g. the server limits how long tokens live (400, with a sentence)
      .catch(error => setError(errorMessage(error)))
      .finally(() => setSaving(false));
  };

  return <form onSubmit={submit}>
    <DialogBody>
      {error && <Callout intent={Intent.DANGER} style={{ marginBottom: 16 }} role="alert">
        {error}
        {expiry === 'never' && <p style={{ marginTop: 6, marginBottom: 0 }}>Choose an expiry date and try again.</p>}
      </Callout>}
      <FormGroup label="Name" labelFor="token-name" helperText="What it's for, e.g. “ci-bot” or “nightly benchmarks”.">
        <InputGroup id="token-name" value={name} onChange={e => setName(e.target.value)} autoFocus maxLength={100} placeholder="ci-bot"/>
      </FormGroup>
      <FormGroup label="What it can do" helperText={chosen_scopes.length === 0 ? "Choose at least one." : "Give it only what it needs: it can do this as you."} intent={chosen_scopes.length === 0 ? Intent.DANGER : undefined}>
        {offered_scopes.map(scope => <Checkbox
          key={scope.id}
          checked={chosen_scopes.includes(scope.id)}
          onChange={() => toggleScope(scope.id)}
          labelElement={<><strong>{scope.label}</strong> <span className={Classes.TEXT_MUTED}>{scope.description}</span></>}
        />)}
      </FormGroup>
      <FormGroup label="Projects" labelInfo="(optional)" labelFor="token-projects" helperText={<>Leave empty for all the projects you can access. Patterns like <code>group/*</code> work. Press Enter after each one.</>}>
        <TagInput
          inputProps={{ id: 'token-projects' }}
          values={projects}
          onChange={values => setProjects([...new Set(values.map(v => String(v).trim()).filter(Boolean))])}
          placeholder="group/repo, group/*"
          addOnBlur
          leftIcon="projects"
        />
      </FormGroup>
      <FormGroup label="Expires" helperText={expires_on ? `On ${expires_on}.` : "It works until you revoke it."}>
        <RadioGroup inline selectedValue={expiry} onChange={e => setExpiry(e.currentTarget.value)}>
          {expiry_presets.map(p => <Radio key={p.value} value={p.value} label={p.label}/>)}
        </RadioGroup>
      </FormGroup>
    </DialogBody>
    <DialogFooter actions={<>
      <Button text="Cancel" onClick={onClose}/>
      <Button type="submit" intent={Intent.PRIMARY} text="Create token" loading={saving} disabled={!valid}/>
    </>}/>
  </form>;
};


// The secret lives in this dialog's state only: once closed, it's gone
export const CreateTokenDialog = ({ isOpen, onClose, is_admin = false }) => {
  const [created, setCreated] = useState(null);
  const close = () => {
    setCreated(null);
    onClose();
  };
  return <Dialog
    isOpen={isOpen}
    onClose={close}
    title={created ? "Token created" : "New access token"}
    icon="key"
    style={{ width: 620, maxWidth: 'calc(100vw - 32px)' }}
    // users must not lose the secret by clicking next to the dialog
    canOutsideClickClose={!created}
  >
    {created
      ? <>
        <DialogBody><TokenSecret token={created}/></DialogBody>
        <DialogFooter actions={<Button intent={Intent.PRIMARY} text="I copied it, close" onClick={close}/>}/>
      </>
      : <TokenForm is_admin={is_admin} onCreated={setCreated} onClose={close}/>}
  </Dialog>;
};

export default CreateTokenDialog;
