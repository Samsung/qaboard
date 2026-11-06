// /setup: a new server, without accounts yet, gets its first admin here. The setup token proves that whoever sets it up
// runs the server: it's in the backend's logs (backend/first_admin.py). The app comes here while the server needs it.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Callout, Card, Classes, FormGroup, InputGroup, Intent, Spinner } from "@blueprintjs/core";
import styled from "styled-components";

import { history, Link } from "../router";
import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { PageShell } from "../components/PageShell";
import { QueryError } from "../settings/states";
import { setupQuery, setUp } from "./api";


const Column = styled.div`
  box-sizing: border-box;
  width: 100%;
  max-width: 480px;
  margin: 4vh auto 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
`;

const Command = ({ children }) => <pre className={Classes.CODE_BLOCK} style={{ margin: '4px 0 8px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 }}>{children}</pre>;

// Where to find the token, for the usual ways to run the server
export const WhereIsTheToken = () => <details>
  <summary style={{ cursor: 'pointer' }}>Where is the setup token?</summary>
  <div style={{ marginTop: 8 }}>
    <p style={{ margin: '0 0 4px' }}>The server prints it in its logs when it starts, after <code>[setup]</code>. With Docker Compose:</p>
    <Command>{'docker compose logs backend | grep -A1 "setup token"'}</Command>
    <p style={{ margin: '0 0 4px' }}>With Kubernetes:</p>
    <Command>{'kubectl logs deploy/<release>-backend | grep -A1 "setup token"'}</Command>
    <p style={{ margin: '0 0 4px' }}>Or ask the server, in its backend container:</p>
    <Command>qaboard-admin setup-token</Command>
  </div>
</details>;


const SetupForm = ({ status }) => {
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const min_length = status.min_password_length ?? 8;

  const submit = event => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.target));
    if (form.password !== form.password_again) return setError({ field: 'password_again', message: "The passwords don't match." });
    setBusy(true);
    setError(null);
    setUp(queryClient, {
      token: form.token,
      user_name: form.user_name.trim(),
      full_name: form.full_name,
      email: form.email,
      password: form.password,
    })
      .then(user => {
        toaster.show({ message: `Welcome, ${user?.full_name || user?.user_name}: you're QA-Board's admin`, intent: Intent.SUCCESS, icon: 'shield', timeout: 6000 });
        history.replace('/admin/overview');
      })
      .catch(error => {
        const data = error.response?.data;
        setError({ field: data?.field ?? null, message: data?.error || `Could not set up QA-Board: ${errorMessage(error)}` });
        // someone else just did it
        if (data?.reason === 'setup_done') queryClient.invalidateQueries({ queryKey: ['setup'] });
      })
      .finally(() => setBusy(false));
  };

  const fieldError = field => error?.field === field ? { intent: Intent.DANGER, helperText: error.message } : {};
  const other_error = error && !['token', 'user_name', 'email', 'password', 'password_again'].includes(error.field);
  return <form onSubmit={submit} aria-label="Create the first admin">
    {other_error && <Callout intent={Intent.DANGER} icon={null} style={{ marginBottom: 12 }} role="alert">{error.message}</Callout>}
    <FormGroup label="Setup token" labelFor="setup-token" {...fieldError('token')} helperText={fieldError('token').helperText ?? "It proves you run this server."}>
      <InputGroup id="setup-token" name="token" autoComplete="off" spellCheck={false} className={Classes.MONOSPACE_TEXT} placeholder="xxxx-xxxx-xxxx-xxxx-xxxx-xxxx" autoFocus required intent={fieldError('token').intent}/>
    </FormGroup>
    <div style={{ marginTop: -8, marginBottom: 16 }}><WhereIsTheToken/></div>
    <FormGroup label="User name" labelFor="setup-user-name" {...fieldError('user_name')}>
      <InputGroup id="setup-user-name" name="user_name" autoComplete="username" defaultValue={status.default_user_name ?? 'admin'} required intent={fieldError('user_name').intent}/>
    </FormGroup>
    <FormGroup label="Full name" labelFor="setup-full-name" labelInfo="(optional)">
      <InputGroup id="setup-full-name" name="full_name" autoComplete="name"/>
    </FormGroup>
    <FormGroup label="Email" labelFor="setup-email" labelInfo="(optional)" {...fieldError('email')}>
      <InputGroup id="setup-email" name="email" type="email" autoComplete="email" intent={fieldError('email').intent}/>
    </FormGroup>
    <FormGroup label="Password" labelFor="setup-password" {...fieldError('password')} helperText={fieldError('password').helperText ?? `At least ${min_length} characters.`}>
      <InputGroup id="setup-password" name="password" type="password" autoComplete="new-password" minLength={min_length} required intent={fieldError('password').intent}/>
    </FormGroup>
    <FormGroup label="Password, again" labelFor="setup-password-again" {...fieldError('password_again')}>
      <InputGroup id="setup-password-again" name="password_again" type="password" autoComplete="new-password" required intent={fieldError('password_again').intent}/>
    </FormGroup>
    <Button type="submit" size="large" intent={Intent.PRIMARY} fill loading={busy} text="Create the admin account"/>
  </form>;
};


export const SetupPage = () => {
  const { data: status, isPending, error, refetch } = useQuery(setupQuery);
  let content;
  if (isPending) content = <Card><Spinner size={24} aria-label="Checking whether QA-Board is set up"/></Card>;
  else if (error) content = <QueryError error={error} refetch={refetch} what="whether QA-Board is set up"/>;
  else if (!status?.open) content = <Callout intent={Intent.SUCCESS} icon="tick-circle" title="QA-Board is set up">
    <p>It has accounts already. <Link to="/login">Sign in</Link>, or ask an admin for an account.</p>
  </Callout>;
  else content = <>
    <p className={Classes.TEXT_MUTED} style={{ margin: 0 }}>
      This server has no accounts yet. Create the first admin: you'll then add people, connect single sign-on or LDAP,
      and choose who can sign up, from the admin panel.
    </p>
    <Card><SetupForm status={status}/></Card>
    <p className={Classes.TEXT_MUTED} style={{ margin: 0, fontSize: 12 }}>
      Automated installs can skip this page: set <code>QABOARD_ADMIN_PASSWORD</code> on the backend.
      {' '}<a href="https://samsung.github.io/qaboard/docs/backend-admin/user-management#the-first-admin" target="_blank" rel="noopener noreferrer">How it works</a>
    </p>
  </>;
  return <PageShell account={false} tab_title="Set up QA-Board">
    <Column>
      <h2 className={Classes.HEADING} style={{ margin: 0 }}>Set up QA-Board</h2>
      {content}
    </Column>
  </PageShell>;
};

export default SetupPage;
