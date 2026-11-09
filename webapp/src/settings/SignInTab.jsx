// Settings → Sign-in methods: the accounts users sign in with (a directory account, a single sign-on...), and the
// single sign-ons they can add. Linking goes through the provider, which sends users back here, with
// ?error=<code>&ref=<id> when it failed (api/sign_in.py).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AnchorButton, Button, Callout, Classes, FormGroup, HTMLTable, InputGroup, Intent, NonIdealState, Tooltip } from "@blueprintjs/core";
import { useLocation } from "react-router";

import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { identitiesQuery, unlinkIdentity, linkUrl, changePassword } from "../login/api";
import { useUser } from "../hooks";
import { SignInError } from "../login/SignInError";
import { QueryError, Loading } from "./states";
import { Time } from "./format";


const only_one = "It's your only way to sign in: link another one first.";
const MIN_PASSWORD_LENGTH = 8;

// Local accounts: e.g. after an admin created the account, or reset its password
export const ChangePassword = () => {
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = event => {
    event.preventDefault();
    const form_element = event.target;
    const form = Object.fromEntries(new FormData(form_element));
    if ((form.new_password ?? '').length < MIN_PASSWORD_LENGTH)
      return setError({ field: 'new_password', message: `Passwords need at least ${MIN_PASSWORD_LENGTH} characters.` });
    if (form.new_password !== form.new_password_again)
      return setError({ field: 'new_password_again', message: "The passwords don't match." });
    setBusy(true);
    setError(null);
    changePassword(queryClient, { current_password: form.current_password, new_password: form.new_password })
      .then(result => {
        form_element.reset();
        const n = result?.signed_out ?? 0;
        toaster.show({ message: `Changed your password${n ? `, and signed out ${n} other browser${n === 1 ? '' : 's'}` : ''}`, intent: Intent.SUCCESS, icon: 'tick', timeout: 4000 });
      })
      .catch(error => setError({ field: error.response?.data?.field ?? null, message: error.response?.data?.error || errorMessage(error) }))
      .finally(() => setBusy(false));
  };
  const fieldError = field => error?.field === field ? { intent: Intent.DANGER, helperText: error.message } : {};
  const other_error = error && !['current_password', 'new_password', 'new_password_again'].includes(error.field);
  return <form onSubmit={submit} aria-label="Change your password" style={{ maxWidth: 360, marginTop: 24 }}>
    <h4 className={Classes.HEADING}>Change your password</h4>
    <p className={Classes.TEXT_MUTED} style={{ marginTop: 0 }}>For your local account. Your other browsers are signed out; your tokens keep working.</p>
    {other_error && <Callout intent={Intent.DANGER} style={{ marginBottom: 12 }} role="alert">{error.message}</Callout>}
    <FormGroup label="Current password" labelFor="current-password" {...fieldError('current_password')}>
      <InputGroup id="current-password" name="current_password" type="password" autoComplete="current-password" required intent={fieldError('current_password').intent}/>
    </FormGroup>
    <FormGroup label="New password" labelFor="new-password" {...fieldError('new_password')} helperText={fieldError('new_password').helperText ?? `At least ${MIN_PASSWORD_LENGTH} characters.`}>
      <InputGroup id="new-password" name="new_password" type="password" autoComplete="new-password" required intent={fieldError('new_password').intent}/>
    </FormGroup>
    <FormGroup label="New password, again" labelFor="new-password-again" {...fieldError('new_password_again')}>
      <InputGroup id="new-password-again" name="new_password_again" type="password" autoComplete="new-password" required intent={fieldError('new_password_again').intent}/>
    </FormGroup>
    <Button type="submit" text="Change the password" loading={busy}/>
  </form>;
};

export const SignInTab = () => {
  const queryClient = useQueryClient();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const link_error = params.get('error');
  const { data, isPending, error, refetch } = useQuery(identitiesQuery);
  const [unlinking, setUnlinking] = useState(null);
  const [busy, setBusy] = useState(false);
  const [unlink_error, setUnlinkError] = useState(null);
  const user = useUser();
  const identities = data?.identities ?? [];
  const linkable = data?.linkable ?? [];
  const last = identities.length <= 1;

  const confirm = () => {
    const identity = unlinking;
    setBusy(true);
    setUnlinkError(null);
    unlinkIdentity(queryClient, identity.id)
      .then(() => toaster.show({ message: `Unlinked ${identity.provider_name}`, intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 }))
      // e.g. "It's your only way to sign in: add another one first." (400)
      .catch(error => setUnlinkError(errorMessage(error)))
      .finally(() => {
        setBusy(false);
        setUnlinking(null);
      });
  };

  return <section aria-label="Sign-in methods">
    <p className={Classes.TEXT_MUTED} style={{ marginTop: 0, maxWidth: 640 }}>
      The ways you sign in to QA-Board. Link another one to keep access when one of them is unavailable.
    </p>
    {link_error && <SignInError
      code={link_error}
      reference={params.get('ref')}
      provider={data?.linkable?.find(provider => provider.id === params.get('provider'))?.name}
      style={{ marginBottom: 16, maxWidth: 640 }}
    />}
    {unlink_error && <Callout intent={Intent.DANGER} style={{ marginBottom: 16, maxWidth: 640 }} role="alert" title="Could not unlink it">
      {unlink_error}
    </Callout>}
    {isPending && <Loading label="Loading your sign-in methods"/>}
    {error && <QueryError error={error} refetch={refetch} what="your sign-in methods"/>}
    {!isPending && !error && <>
      {identities.length === 0
        ? <NonIdealState icon="log-in" title="No sign-in methods recorded yet" description="They show up here the next time you sign in."/>
        : <div style={{ overflowX: 'auto' }}>
          <HTMLTable compact style={{ width: '100%' }} aria-label="Sign-in methods">
            <thead>
              <tr>
                <th>Method</th>
                <th>Email</th>
                <th>Linked</th>
                <th>Last used</th>
                <th><span className={Classes.TEXT_MUTED} style={{ fontWeight: 'normal' }}>Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {identities.map(identity => <tr key={identity.id} data-testid={`identity-${identity.id}`}>
                <td><strong>{identity.provider_name || identity.provider_id}</strong></td>
                <td>{identity.email || <span className={Classes.TEXT_MUTED}>—</span>}</td>
                <td><Time iso={identity.created_at}/></td>
                <td><Time iso={identity.last_login_at}/></td>
                <td>
                  <Tooltip content={only_one} disabled={!last}>
                    <Button
                      size="small"
                      variant="outlined"
                      intent={Intent.DANGER}
                      text="Unlink"
                      aria-label={`Unlink ${identity.provider_name || identity.provider_id}`}
                      disabled={last}
                      onClick={() => setUnlinking(identity)}
                    />
                  </Tooltip>
                </td>
              </tr>)}
            </tbody>
          </HTMLTable>
        </div>}
      {linkable.length > 0 && <div style={{ marginTop: 20 }}>
        <h4 className={Classes.HEADING}>Add a sign-in method</h4>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {linkable.map(provider => <AnchorButton key={provider.id} icon="link" text={`Link ${provider.name}`} href={linkUrl(provider)}/>)}
        </div>
        <p className={Classes.TEXT_MUTED} style={{ marginTop: 8, fontSize: 12 }}>You sign in there once, then come back here.</p>
      </div>}
    </>}
    <Alert
      isOpen={!!unlinking}
      icon="disable"
      intent={Intent.DANGER}
      cancelButtonText="Cancel"
      confirmButtonText="Unlink"
      loading={busy}
      onCancel={() => setUnlinking(null)}
      onConfirm={confirm}
      canEscapeKeyCancel
    >
      {unlinking && <p>Unlink <strong>{unlinking.provider_name}</strong>? You won't be able to sign in with it anymore, unless you link it again.</p>}
    </Alert>
    {(user?.login_type ?? '').toUpperCase() === 'LOCAL' && <ChangePassword/>}
  </section>;
};

export default SignInTab;
