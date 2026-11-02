// /login?next=<page>: single sign-on buttons first (the recommended one first), then "or", then one user name and
// password form (LDAP or local accounts). Everything that needs users to sign in comes here (see
// components/authentication/login.jsx), and the server sends failed single sign-ons back with ?error=<code>&ref=<id>.
// With auth.sso_auto_redirect the page goes straight to the only single sign-on, unless there is an error (no loops);
// /login?local=1 shows the password form, for break-glass admins.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnchorButton, Button, Callout, Card, Classes, FormGroup, Icon, InputGroup, Intent, Spinner } from "@blueprintjs/core";
import { useLocation } from "react-router";
import styled from "styled-components";

import { history, Link } from "../router";
import { errorMessage, reason_messages } from "../api/http";
import { userQuery, logged_out_user } from "../api/queries";
import { useSiteConfig } from "../hooks";
import { toaster } from "../toaster";
import { PageShell } from "../components/PageShell";
import { QueryError } from "../settings/states";
import { SignInError } from "./SignInError";
import { PendingAccount } from "./PendingAccount";
import { providersQuery, redirectProviders, safeNext, loginUrl, goTo, signIn, signUp } from "./api";


const Column = styled.div`
  box-sizing: border-box;
  width: 100%;
  max-width: 400px;
  margin: 4vh auto 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
`;

// ——— or ———
const Or = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 20px 0;
  color: var(--qa-text-muted);
  &::before, &::after {
    content: "";
    flex: 1;
    border-top: 1px solid var(--qa-border);
  }
`;

const warning = {
  rightElement: <Icon icon="warning-sign" intent={Intent.DANGER} style={{ margin: 12 }}/>,
  intent: Intent.DANGER,
};

// After signing in. The server's own pages (e.g. shared files under /s/, pgAdmin, Flower) aren't the app's.
const continueTo = next => {
  if (next && /^\/(api|s|pgadmin4|flower)\//.test(next)) goTo(next);
  else history.replace(next ?? '/');
};

// Signed-out users are checked again each time, like in PrivateContent
const refetchOnMount = query => query.state.data?.is_logged ? true : 'always';


// What older servers answer when signing in fails, shown next to the fields
const field_errors = ["invalid-username", "invalid-password"];
const account_reasons = ["user_disabled", "user_pending"];

// `primary`: when it's the page's main action (no single sign-on)
const PasswordForm = ({ primary, onSignedIn }) => {
  const queryClient = useQueryClient();
  // the site's advice to users who can't sign in (QABOARD_LOGIN_HINT), e.g. which credentials to use
  const { login_hint } = useSiteConfig();
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = event => {
    event.preventDefault();
    const form = new FormData(event.target);
    setBusy(true);
    signIn(queryClient, { username: form.get('username'), password: form.get('password') })
      .then(data => {
        setError(null);
        onSignedIn(data);
      })
      .catch(error => {
        const data = error.response?.data;
        // Older servers answer with codes, shown next to their field
        if (field_errors.includes(data?.error)) return setError({ code: data.error });
        // Newer ones with a sentence for people, and its code: {error: "Wrong user name or password.", reason: "invalid_credentials"}
        if (typeof data?.error === 'string' && data.error) return setError({ code: data.reason ?? null, message: data.error });
        setError({ message: `Could not sign in: ${errorMessage(error)}` });
      })
      .finally(() => setBusy(false));
  };

  const code = error?.code;
  const password_error = code === "invalid-password" || code === "invalid_credentials";
  const account = account_reasons.includes(code);
  const other_error = !!error?.message && !password_error;
  return <form onSubmit={submit} aria-label="Sign in with a user name and password">
    {other_error && <Callout intent={account && code === 'user_pending' ? Intent.WARNING : Intent.DANGER} icon={null} style={{ marginBottom: 12 }} role="alert">
      {error.message}
    </Callout>}
    <FormGroup
      label="User name"
      labelFor="username"
      intent={code === "invalid-username" ? Intent.DANGER : undefined}
      helperText={code === "invalid-username" ? <>This user name does not match any account.{login_hint && <> {login_hint}</>}</> : undefined}
    >
      <InputGroup id="username" name="username" type="text" autoComplete="username" autoFocus={primary} size="large" {...(code === "invalid-username" && warning)}/>
    </FormGroup>
    <FormGroup
      label="Password"
      labelFor="password"
      intent={password_error ? Intent.DANGER : undefined}
      helperText={password_error ? <>{code === "invalid-password" ? "The password is incorrect." : error.message}{login_hint && <> {login_hint}</>}</> : undefined}
    >
      <InputGroup id="password" name="password" type="password" autoComplete="current-password" size="large" {...(password_error && warning)}/>
    </FormGroup>
    <Button type="submit" size="large" intent={primary ? Intent.PRIMARY : undefined} variant={primary ? undefined : 'outlined'} fill loading={busy} text="Sign in"/>
  </form>;
};


// Local accounts, when auth.local_signup allows them. Signed in right away (the account may wait for an admin).
const SignUpForm = ({ onSignedIn }) => {
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = event => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.target));
    if (!form.user_name?.trim() || !form.password) return setError("Choose a user name and a password.");
    setBusy(true);
    setError(null);
    signUp({ ...form, user_name: form.user_name.trim() })
      .then(() => signIn(queryClient, { username: form.user_name.trim(), password: form.password }))
      .then(onSignedIn)
      .catch(error => setError(errorMessage(error)))
      .finally(() => setBusy(false));
  };
  return <form onSubmit={submit} aria-label="Create an account">
    {error && <Callout intent={Intent.DANGER} icon={null} style={{ marginBottom: 12 }} role="alert">{error}</Callout>}
    <FormGroup label="User name" labelFor="signup-user-name">
      <InputGroup id="signup-user-name" name="user_name" autoComplete="username" autoFocus required/>
    </FormGroup>
    <FormGroup label="Full name" labelFor="signup-full-name" labelInfo="(optional)">
      <InputGroup id="signup-full-name" name="full_name" autoComplete="name"/>
    </FormGroup>
    <FormGroup label="Email" labelFor="signup-email" labelInfo="(optional)">
      <InputGroup id="signup-email" name="email" type="email" autoComplete="email"/>
    </FormGroup>
    <FormGroup label="Password" labelFor="signup-password">
      <InputGroup id="signup-password" name="password" type="password" autoComplete="new-password" required/>
    </FormGroup>
    <Button type="submit" size="large" intent={Intent.PRIMARY} fill loading={busy} text="Create the account"/>
  </form>;
};


const Redirecting = ({ provider, next }) => {
  useEffect(() => { goTo(provider.start_url, { replace: true }); }, [provider.start_url]);
  return <Card style={{ textAlign: 'center' }} aria-live="polite">
    <Spinner size={28} aria-label="Redirecting"/>
    <p style={{ margin: '12px 0 4px' }}>Redirecting to {provider.name}…</p>
    <Link to={loginUrl(next, { local: 1 })} className={Classes.TEXT_MUTED}>Sign in with a password instead</Link>
  </Card>;
};


const Options = ({ next, local, error, user }) => {
  const { data, isPending, error: load_error, refetch } = useQuery(providersQuery({ next, local }));
  const [mode, setMode] = useState('sign-in');

  const onSignedIn = data => {
    // pending users stay here: the page shows their request (see LoginPage)
    if (data?.status === 'pending') return;
    toaster.show({ message: `Welcome, ${data?.full_name || data?.user_name}`, intent: Intent.SUCCESS, timeout: 3000 });
    continueTo(next);
  };

  if (isPending) return <Card><Spinner size={24} aria-label="Loading the ways to sign in"/></Card>;
  if (load_error) return <QueryError error={load_error} refetch={refetch} what="the ways to sign in"/>;

  const buttons = redirectProviders(data.providers);
  // no loops: after an error, users choose
  if (data.auto_redirect && buttons.length === 1 && !error && !user.reason)
    return <Redirecting provider={buttons[0]} next={next}/>;

  if (mode === 'sign-up')
    return <Card>
      <SignUpForm onSignedIn={onSignedIn}/>
      <p style={{ margin: '16px 0 0', textAlign: 'center' }}>
        Already have an account? <Button variant="minimal" intent={Intent.PRIMARY} size="small" text="Sign in" onClick={() => setMode('sign-in')}/>
      </p>
    </Card>;

  const nothing = buttons.length === 0 && !data.password_form;
  return <Card>
    {nothing && <p className={Classes.TEXT_MUTED} style={{ margin: 0 }}>There is no way to sign in to this server yet. Tell your admins.</p>}
    {buttons.length > 0 && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {buttons.map((provider, index) => <AnchorButton
        key={provider.id}
        href={provider.start_url}
        size="large"
        fill
        icon="log-in"
        // one main action: the recommended single sign-on, else the only way to sign in
        intent={index === 0 && (provider.recommended || !data.password_form) ? Intent.PRIMARY : undefined}
        variant={index === 0 && (provider.recommended || !data.password_form) ? undefined : 'outlined'}
        text={provider.name}
        data-testid={`provider-${provider.id}`}
      />)}
    </div>}
    {buttons.length > 0 && data.password_form && <Or>or</Or>}
    {data.password_form && <PasswordForm primary={buttons.length === 0} onSignedIn={onSignedIn}/>}
    {data.local_signup && <p style={{ margin: '16px 0 0', textAlign: 'center' }}>
      No account yet? <Button variant="minimal" intent={Intent.PRIMARY} size="small" text="Create one" onClick={() => setMode('sign-up')}/>
    </p>}
    {/* break-glass admins, when single sign-on is down */}
    {!data.password_form && buttons.length > 0 && <p style={{ margin: '16px 0 0', textAlign: 'center', fontSize: 12 }}>
      <Link to={loginUrl(next, { local: 1 })} className={Classes.TEXT_MUTED}>Admins: sign in with a local account</Link>
    </p>}
  </Card>;
};


export const LoginPage = () => {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const next = safeNext(params.get('next'));
  const local = ['1', 'true'].includes(params.get('local'));
  const error = params.get('error');
  const reference = params.get('ref');
  const { data: user = logged_out_user, isPending } = useQuery({ ...userQuery, refetchOnMount });
  const { data: providers } = useQuery(providersQuery({ next, local }));
  // the error is about a single sign-on: the server says which, else we name it when there is only one
  const buttons = redirectProviders(providers?.providers ?? []);
  const provider_name = buttons.find(provider => provider.id === params.get('provider'))?.name ?? (buttons.length === 1 ? buttons[0].name : null);

  // already signed in, e.g. a bookmark of /login, or the back button
  const signed_in = user.is_logged && !error && location.pathname === '/login';
  useEffect(() => { if (signed_in) continueTo(next); }, [signed_in, next]);

  let content;
  if (isPending || signed_in)
    content = <Card><Spinner size={24} aria-label="Checking who you are"/></Card>;
  else if (user.reason === 'user_pending')
    content = <PendingAccount user={user}/>;
  else
    content = <>
      {user.is_logged && <Callout intent={Intent.PRIMARY} icon="person">
        You're signed in as <strong>{user.full_name || user.user_name}</strong>. <Link to={next ?? '/'}>Continue</Link>
      </Callout>}
      {user.reason === 'user_disabled' && !error && <Callout intent={Intent.DANGER} icon="blocked-person" title="Your account is disabled" role="alert">
        {user.error || reason_messages.user_disabled}
      </Callout>}
      <Options next={next} local={local} error={error} user={user}/>
    </>;

  return <PageShell account={false}>
    <Column>
      {user.reason !== 'user_pending' && <h2 className={Classes.HEADING} style={{ margin: 0 }}>Sign in to QA-Board</h2>}
      {error && !(error === 'user_pending' && user.reason === 'user_pending') && <SignInError code={error} reference={reference} provider={provider_name}/>}
      {content}
    </Column>
  </PageShell>;
};

export default LoginPage;
