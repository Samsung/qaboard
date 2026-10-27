// Creating an access token, then showing its secret: the only time the server gives it
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button, Callout, Checkbox, Classes, Dialog, DialogBody, DialogFooter, FormGroup, InputGroup, Intent, Radio, RadioGroup, TagInput,
} from "@blueprintjs/core";
import { DateTime } from "luxon";

import { errorMessage } from "../api/http";
import { useSiteConfig } from "../hooks";
import { copyWithToast } from "../utils/clipboard";
import { scopes } from "./format";
import { createToken } from "./api";


const preset_days = [30, 90, 365];
const days_label = days => days % 365 === 0
  ? `${days / 365} year${days === 365 ? '' : 's'}`
  : `${days} day${days === 1 ? '' : 's'}`;

// The server's token policy (/api/v1/config `tokens`) => the expiry choices, and the one chosen first.
// - its default lifetime is offered, even if it's not one of our presets
// - nothing longer than its maximum, and with a maximum, no "No expiry"
export const expiryOptions = ({ default_lifetime_days, max_lifetime_days } = {}) => {
  const max = max_lifetime_days || null;
  const fallback = default_lifetime_days || 90;
  const days = new Set([...preset_days, fallback, ...(max ? [max] : [])]);
  const options = [...days]
    .filter(d => !max || d <= max)
    .sort((a, b) => a - b)
    .map(d => ({ value: String(d), label: days_label(d), days: d }));
  if (!max) options.push({ value: 'never', label: 'No expiry', days: null });
  const initial = options.find(o => o.days === Math.min(fallback, max ?? Infinity)) ?? options[0];
  return { options, initial: initial.value };
};
const default_scopes = ['read', 'ingest'];


// Commands that use the token, each with a copy button
const Snippet = ({ title, code, what }) => <div style={{ marginBottom: 12 }}>
  <div className={Classes.TEXT_MUTED} style={{ fontSize: 12, marginBottom: 4 }}>{title}</div>
  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
    <pre className={Classes.CODE_BLOCK} style={{ flex: 1, margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{code}</pre>
    <Button icon="duplicate" variant="minimal" aria-label={`Copy ${what}`} onClick={() => copyWithToast(code, { what })}/>
  </div>
</div>;

export const TokenSecret = ({ token, label = `Your new token, “${token.name}”` }) => {
  const origin = window.location.origin;
  return <>
    <Callout intent={Intent.WARNING} icon="eye-open" style={{ marginBottom: 16 }} title="Copy your token now">
      You won't be able to see it again. If you lose it, create another one.
    </Callout>
    <FormGroup label={label} labelFor="new-token-secret">
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


// `create(body)` => the token with its secret, by default the user's own. `project`: the only project it can access.
const TokenForm = ({ is_admin, onCreated, onClose, create, offered = scopes, project, scope_help }) => {
  const queryClient = useQueryClient();
  const { tokens: policy } = useSiteConfig();
  const [expiry_options] = useState(() => expiryOptions(policy ?? {}));
  const [name, setName] = useState('');
  const [chosen_scopes, setScopes] = useState(default_scopes);
  const [projects, setProjects] = useState([]);
  const [expiry, setExpiry] = useState(expiry_options.initial);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const offered_scopes = offered.filter(scope => !scope.admin_only || is_admin);
  const toggleScope = id => setScopes(current => current.includes(id) ? current.filter(s => s !== id) : [...current, id]);
  const preset = expiry_options.options.find(p => p.value === expiry) ?? expiry_options.options[0];
  const expires_on = preset.days ? DateTime.now().plus({ days: preset.days }).toLocaleString(DateTime.DATE_MED) : null;
  const valid = name.trim().length > 0 && chosen_scopes.length > 0;

  const submit = event => {
    event.preventDefault();
    if (!valid) return;
    setSaving(true);
    setError(null);
    const body = {
      name: name.trim(),
      // in the order we show them
      scopes: offered_scopes.map(s => s.id).filter(id => chosen_scopes.includes(id)),
      projects: project ? [project] : projects,
      expires_in_days: preset.days,
    };
    (create ? create(body) : createToken(queryClient, body))
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
        <InputGroup id="token-name" value={name} onChange={e => setName(e.target.value)} autoFocus maxLength={100}/>
      </FormGroup>
      <FormGroup label="What it can do" helperText={chosen_scopes.length === 0 ? "Choose at least one." : (scope_help ?? "Give it only what it needs: it can do this as you.")} intent={chosen_scopes.length === 0 ? Intent.DANGER : undefined}>
        {offered_scopes.map(scope => <Checkbox
          key={scope.id}
          checked={chosen_scopes.includes(scope.id)}
          onChange={() => toggleScope(scope.id)}
          labelElement={<><strong>{scope.label}</strong> <span className={Classes.TEXT_MUTED}>{scope.description}</span></>}
        />)}
      </FormGroup>
      {project
        ? <FormGroup label="Projects" helperText="A project's service accounts only access the project.">
          <code className={Classes.CODE}>{project}</code>
        </FormGroup>
        : <FormGroup label="Projects" labelInfo="(optional)" labelFor="token-projects" helperText={<>Leave empty for all the projects you can access. Patterns like <code>group/*</code> work. Press Enter after each one.</>}>
        <TagInput
          inputProps={{ id: 'token-projects' }}
          values={projects}
          onChange={values => setProjects([...new Set(values.map(v => String(v).trim()).filter(Boolean))])}
          placeholder="group/repo, group/*"
          addOnBlur
          leftIcon="projects"
          // Enter adds the project, it never creates the token
          onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }}
        />
      </FormGroup>}
      <FormGroup label="Expires" helperText={expires_on ? `On ${expires_on}.` : "It works until you revoke it."}>
        <RadioGroup inline selectedValue={expiry} onChange={e => setExpiry(e.currentTarget.value)}>
          {expiry_options.options.map(p => <Radio key={p.value} value={p.value} label={p.label}/>)}
        </RadioGroup>
      </FormGroup>
    </DialogBody>
    <DialogFooter actions={<>
      <Button text="Cancel" onClick={onClose}/>
      <Button type="submit" intent={Intent.PRIMARY} text="Create token" loading={saving} disabled={!valid}/>
    </>}/>
  </form>;
};


// The secret lives in this dialog's state only: once closed, it's gone.
// For service accounts: `create`, `offered` scopes, `project` (theirs, if any), `title` and `secret_label`.
export const CreateTokenDialog = ({ isOpen, onClose, is_admin = false, title = "New access token", secret_label, ...form }) => {
  const [created, setCreated] = useState(null);
  const close = () => {
    setCreated(null);
    onClose();
  };
  return <Dialog
    isOpen={isOpen}
    onClose={close}
    title={created ? "Token created" : title}
    icon="key"
    style={{ width: 620, maxWidth: 'calc(100vw - 32px)' }}
    // users must not lose the secret by clicking next to the dialog, or pressing Escape
    canOutsideClickClose={!created}
    canEscapeKeyClose={!created}
  >
    {created
      ? <>
        <DialogBody><TokenSecret token={created} {...(secret_label ? { label: secret_label(created) } : {})}/></DialogBody>
        <DialogFooter actions={<Button intent={Intent.PRIMARY} text="I copied it, close" onClick={close}/>}/>
      </>
      : <TokenForm is_admin={is_admin} onCreated={setCreated} onClose={close} {...form}/>}
  </Dialog>;
};

export default CreateTokenDialog;
