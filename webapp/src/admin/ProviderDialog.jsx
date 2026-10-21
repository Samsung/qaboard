// Admin → Sign-in → Add or edit an OIDC provider (api/admin_sign_in.py). The server checks everything again: its
// errors are shown at the top of the form.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button, Callout, Classes, Collapse, Dialog, DialogBody, DialogFooter, FormGroup, InputGroup, Intent, NumericInput, Radio,
  RadioGroup, Switch,
} from "@blueprintjs/core";

import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { saveProvider } from "./api";


// providers.py valid_id(): the environment's providers and the callback route take these
const reserved_ids = ['local', 'ldap', 'saml', 'sso', 'callback'];
// providers.py DEFAULT_CLAIMS
const default_claims = { username: 'preferred_username', email: 'email', name: 'name', groups: 'groups' };
const claim_labels = { username: 'User name', email: 'Email', name: 'Full name', groups: 'Groups' };

export const match_users_options = [
  { value: 'none', label: "Don't match: new accounts", description: "Users get a new QA-Board account the first time they sign in with it, unless they link it to their account in their settings." },
  { value: 'username', label: 'By user name', description: "The provider shares the directory's user names (e.g. it's federated to the same LDAP): alice there is alice here." },
  { value: 'email', label: 'By verified email', description: "Accounts with the same email are the same person, when the provider says the email is verified." },
];

const fromProvider = provider => {
  const config = provider?.config ?? {};
  return {
    id: provider?.id ?? '',
    name: provider?.name ?? '',
    issuer: config.issuer ?? '',
    client_id: config.client_id ?? '',
    secret_mode: config.client_secret_env ? 'env' : 'stored',
    client_secret: '',
    client_secret_env: config.client_secret_env ?? '',
    scopes: (config.scopes ?? ['openid', 'profile', 'email']).join(' '),
    match_users: config.match_users ?? 'none',
    claims: { ...Object.fromEntries(Object.keys(default_claims).map(key => [key, ''])), ...config.claims },
    redirect_uri: config.redirect_uri ?? '',
    enabled: provider?.enabled ?? true,
    recommended: !!provider?.recommended,
    position: provider?.position ?? 0,
  };
};

// => {field: "a sentence"}
export const validateProvider = (form, { create, can_encrypt, has_secret }) => {
  const errors = {};
  if (create) {
    if (!/^[a-z0-9_-]{1,40}$/.test(form.id)) errors.id = "Lowercase letters, digits, - and _, e.g. keycloak.";
    else if (reserved_ids.includes(form.id)) errors.id = `${form.id} is taken by the server's own sign-in methods.`;
  }
  if (!form.name.trim()) errors.name = "Users see it on the sign-in button.";
  if (!/^https?:\/\/\S+$/.test(form.issuer.trim())) errors.issuer = "A URL, e.g. https://keycloak.example.com/realms/company";
  if (!form.client_id.trim()) errors.client_id = "The client id the provider gave you.";
  if (!form.scopes.split(/[\s,]+/).includes('openid')) errors.scopes = "The scopes must include openid.";
  if (form.secret_mode === 'env' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(form.client_secret_env.trim()))
    errors.client_secret_env = "The name of an environment variable of the server, e.g. QABOARD_KEYCLOAK_SECRET.";
  if (form.secret_mode === 'stored' && can_encrypt && !form.client_secret && !has_secret)
    errors.client_secret = "The client secret the provider gave you.";
  if (form.redirect_uri.trim() && !/^https?:\/\/\S+$/.test(form.redirect_uri.trim())) errors.redirect_uri = "A URL, or leave it empty.";
  return errors;
};

// What the server takes. The secret is only sent when typed: empty keeps the current one.
const toBody = (form, { create }) => ({
  ...(create ? { id: form.id } : {}),
  name: form.name.trim(),
  issuer: form.issuer.trim(),
  client_id: form.client_id.trim(),
  scopes: form.scopes.split(/[\s,]+/).filter(Boolean),
  match_users: form.match_users,
  claims: Object.fromEntries(Object.entries(form.claims).map(([key, value]) => [key, value.trim()])),
  redirect_uri: form.redirect_uri.trim(),
  enabled: form.enabled,
  recommended: form.recommended,
  position: Number(form.position) || 0,
  client_secret_env: form.secret_mode === 'env' ? form.client_secret_env.trim() : '',
  ...(form.secret_mode === 'stored' && form.client_secret ? { client_secret: form.client_secret } : {}),
});


// `provider`: the one to edit, else a new one. `public_url`: to show the redirect URI the server will use.
export const ProviderDialog = ({ isOpen, onClose, provider = null, can_encrypt, public_url = '' }) => {
  const create = !provider;
  return <Dialog
    isOpen={isOpen}
    onClose={onClose}
    title={create ? "Add an OIDC provider" : `Edit ${provider.name}`}
    icon="log-in"
    style={{ width: 600, maxWidth: 'calc(100vw - 32px)' }}
    canOutsideClickClose={false}
  >
    {/* a new form each time it opens */}
    {isOpen && <ProviderForm provider={provider} onClose={onClose} can_encrypt={can_encrypt} public_url={public_url}/>}
  </Dialog>;
};


const ProviderForm = ({ provider, onClose, can_encrypt, public_url }) => {
  const queryClient = useQueryClient();
  const create = !provider;
  // a secret stored here: the form can keep it
  const has_secret = !!provider?.has_secret && !provider?.config?.client_secret_env;
  const [form, setForm] = useState(() => {
    const initial = fromProvider(provider);
    // without an encryption key, secrets can only come from the environment
    return can_encrypt ? initial : { ...initial, secret_mode: 'env' };
  });
  const [errors, setErrors] = useState({});
  const [server_error, setServerError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(() => !!(provider?.config?.redirect_uri || Object.keys(provider?.config?.claims ?? {}).length));
  const set = changes => setForm(form => ({ ...form, ...changes }));
  const field = name => ({
    id: `provider-${name}`,
    value: form[name],
    onChange: e => set({ [name]: e.target.value }),
    intent: errors[name] ? Intent.DANGER : undefined,
  });
  const group = (name, helper) => ({
    labelFor: `provider-${name}`,
    intent: errors[name] ? Intent.DANGER : undefined,
    helperText: errors[name] ?? helper,
  });

  const submit = event => {
    event.preventDefault();
    const found = validateProvider(form, { create, can_encrypt, has_secret });
    setErrors(found);
    setServerError(null);
    if (Object.keys(found).length) {
      // the claims and the redirect URI are in "Advanced"
      if (found.redirect_uri) setAdvanced(true);
      return;
    }
    setBusy(true);
    saveProvider(queryClient, { id: create ? form.id : provider.id, ...toBody(form, { create }) }, { create })
      .then(saved => {
        toaster.show({ message: create ? `Added ${saved?.name ?? form.name}` : `Saved ${saved?.name ?? form.name}`, intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 });
        onClose(saved);
      })
      .catch(error => setServerError(errorMessage(error)))
      .finally(() => setBusy(false));
  };

  const id = create ? form.id : provider.id;
  const default_redirect_uri = `${(public_url || window.location.origin).replace(/\/$/, '')}/api/v1/auth/oidc/${id || '<id>'}/callback`;
  return <form onSubmit={submit} noValidate>
    <DialogBody>
      {server_error && <Callout intent={Intent.DANGER} style={{ marginBottom: 16 }} role="alert" title="The server refused it">{server_error}</Callout>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', columnGap: 16 }}>
        <FormGroup label="Name" {...group('name', "On the sign-in button, e.g. Company SSO.")}>
          <InputGroup {...field('name')} autoFocus/>
        </FormGroup>
        <FormGroup label="ID" {...group('id', create ? "In URLs: lowercase letters, digits, - and _." : "It can't change: it's in the redirect URI.")}>
          <InputGroup {...field('id')} value={id} disabled={!create} className={Classes.MONOSPACE_TEXT}/>
        </FormGroup>
      </div>
      <FormGroup label="Issuer" {...group('issuer', "Its discovery document is at <issuer>/.well-known/openid-configuration.")}>
        <InputGroup {...field('issuer')} type="url" placeholder="https://keycloak.example.com/realms/company"/>
      </FormGroup>
      <FormGroup label="Client ID" {...group('client_id')}>
        <InputGroup {...field('client_id')} autoComplete="off" spellCheck={false}/>
      </FormGroup>

      <FormGroup
        label="Client secret"
        labelFor={form.secret_mode === 'env' ? 'provider-client_secret_env' : 'provider-client_secret'}
        intent={errors.client_secret || errors.client_secret_env ? Intent.DANGER : undefined}
        helperText={form.secret_mode === 'stored'
          ? errors.client_secret ?? (has_secret ? "Leave it empty to keep the current secret." : "Encrypted with the server's key. Nobody can read it back.")
          : errors.client_secret_env ?? "Set it on every replica of the server."}
      >
        <RadioGroup
          inline
          selectedValue={form.secret_mode}
          onChange={e => set({ secret_mode: e.target.value })}
          aria-label="Where the client secret is"
        >
          <Radio value="stored" label="Stored encrypted" disabled={!can_encrypt}/>
          <Radio value="env" label="From an environment variable"/>
        </RadioGroup>
        {!can_encrypt && <p className={Classes.TEXT_MUTED} style={{ fontSize: 12, margin: '0 0 6px' }}>
          To store secrets here, set <code>QABOARD_ENCRYPTION_KEY</code> on the server. Until then, put the secret in an
          environment variable of the server, and give its name.
        </p>}
        {form.secret_mode === 'stored'
          ? <InputGroup {...field('client_secret')} type="password" autoComplete="new-password" placeholder={has_secret ? "Unchanged" : undefined}/>
          : <InputGroup {...field('client_secret_env')} placeholder="QABOARD_KEYCLOAK_SECRET" className={Classes.MONOSPACE_TEXT} aria-label="Environment variable with the client secret" spellCheck={false}/>}
      </FormGroup>

      <FormGroup label="Scopes" {...group('scopes', "Separated by spaces. openid is required, profile and email give the name and email.")}>
        <InputGroup {...field('scopes')} className={Classes.MONOSPACE_TEXT} spellCheck={false}/>
      </FormGroup>

      <FormGroup label="Match existing accounts" labelFor="provider-match_users">
        <RadioGroup selectedValue={form.match_users} onChange={e => set({ match_users: e.target.value })} aria-label="Match existing accounts">
          {match_users_options.map(option => <Radio key={option.value} value={option.value} labelElement={<span>
            {option.label}
            <span className={Classes.TEXT_MUTED} style={{ display: 'block', fontSize: 12 }}>{option.description}</span>
          </span>}/>)}
        </RadioGroup>
      </FormGroup>

      <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 24 }}>
        <Switch checked={form.enabled} onChange={() => set({ enabled: !form.enabled })} label="Enabled: on the sign-in page"/>
        <Switch checked={form.recommended} onChange={() => set({ recommended: !form.recommended })} label="Recommended: the first, main button"/>
      </div>

      <Button
        variant="minimal"
        icon={advanced ? 'chevron-down' : 'chevron-right'}
        text="Advanced"
        onClick={() => setAdvanced(!advanced)}
        aria-expanded={advanced}
        style={{ marginLeft: -8 }}
      />
      <Collapse isOpen={advanced} keepChildrenMounted>
        <div style={{ paddingTop: 8 }}>
          <p className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>The claims QA-Board reads in the ID token. Leave them empty for the defaults.</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', columnGap: 16 }}>
            {Object.keys(default_claims).map(claim => <FormGroup key={claim} label={`${claim_labels[claim]} claim`} labelFor={`provider-claim-${claim}`}>
              <InputGroup
                id={`provider-claim-${claim}`}
                value={form.claims[claim] ?? ''}
                onChange={e => set({ claims: { ...form.claims, [claim]: e.target.value } })}
                placeholder={default_claims[claim]}
                className={Classes.MONOSPACE_TEXT}
                spellCheck={false}
              />
            </FormGroup>)}
          </div>
          <FormGroup label="Redirect URI" {...group('redirect_uri', <>Leave it empty for <code style={{ overflowWrap: 'anywhere' }}>{default_redirect_uri}</code>. Change it only when the provider sees the server under another URL.</>)}>
            <InputGroup {...field('redirect_uri')} type="url" placeholder={default_redirect_uri}/>
          </FormGroup>
          <FormGroup label="Position" labelFor="provider-position" helperText="Lower comes first. The server's single sign-on is at -1, LDAP and SAML at 0, QA-Board accounts at 100.">
            <NumericInput id="provider-position" value={form.position} onValueChange={(_, text) => set({ position: text })} minorStepSize={null} style={{ width: 100 }}/>
          </FormGroup>
        </div>
      </Collapse>
    </DialogBody>
    <DialogFooter actions={<>
      <Button text="Cancel" onClick={() => onClose(null)}/>
      <Button type="submit" intent={Intent.PRIMARY} text={create ? "Add the provider" : "Save"} loading={busy}/>
    </>}/>
  </form>;
};

export default ProviderDialog;
