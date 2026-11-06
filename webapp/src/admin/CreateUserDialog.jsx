// Admin → Users → New user: a local account, with a password QA-Board generates (shown once, to give to its owner)
// or one the admin chooses. Also the password that "Reset password" generates (PasswordToGive).
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Callout, Checkbox, Classes, Dialog, DialogBody, DialogFooter, FormGroup, InputGroup, Intent, Radio, RadioGroup } from "@blueprintjs/core";

import { history, Link } from "../router";
import { errorMessage } from "../api/http";
import { useSiteConfig } from "../hooks";
import { copyWithToast } from "../utils/clipboard";
import { createUser } from "./api";


const MIN_PASSWORD_LENGTH = 8;

// A password to give to someone, once
export const PasswordToGive = ({ user_name, password, label }) => <>
  <Callout intent={Intent.WARNING} icon="eye-open" style={{ marginBottom: 16 }} title="Copy the password now">
    You won't see it again. Give it to <strong>{user_name}</strong> privately: they can change it in
    {' '}<em>Settings → Sign-in methods</em> once signed in.
  </Callout>
  <FormGroup label={label ?? `${user_name}'s password`} labelFor="new-user-password">
    <InputGroup
      id="new-user-password"
      readOnly
      value={password}
      className={Classes.MONOSPACE_TEXT}
      onFocus={event => event.target.select()}
      rightElement={<Button icon="duplicate" text="Copy" intent={Intent.PRIMARY} onClick={() => copyWithToast(password, { what: 'the password' })}/>}
    />
  </FormGroup>
  <p className={Classes.TEXT_MUTED} style={{ marginBottom: 0 }}>They sign in at <code>{window.location.origin}/login</code>.</p>
</>;


const Form = ({ onCreated, onClose }) => {
  const queryClient = useQueryClient();
  const { login_type } = useSiteConfig();
  const [mode, setMode] = useState('generate');
  const [is_admin, setIsAdmin] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const submit = event => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.target));
    if (mode === 'choose' && (form.password ?? '').length < MIN_PASSWORD_LENGTH)
      return setError({ field: 'password', message: `Passwords need at least ${MIN_PASSWORD_LENGTH} characters.` });
    setSaving(true);
    setError(null);
    createUser(queryClient, {
      user_name: (form.user_name ?? '').trim(),
      full_name: form.full_name,
      email: form.email,
      password: mode === 'choose' ? form.password : undefined,
      is_admin,
    })
      .then(onCreated)
      .catch(error => setError({ field: error.response?.data?.field ?? null, message: error.response?.data?.error || errorMessage(error) }))
      .finally(() => setSaving(false));
  };

  const fieldError = field => error?.field === field ? { intent: Intent.DANGER, helperText: error.message } : {};
  const other_error = error && !['user_name', 'email', 'password'].includes(error.field);
  const directory = login_type && login_type !== 'LOCAL';
  return <form onSubmit={submit} aria-label="New user">
    <DialogBody>
      <p className={Classes.TEXT_MUTED} style={{ marginTop: 0 }}>
        A local account: its owner signs in with this user name and a password.
        {directory
          ? <> People with a company account don't need one: they get theirs when they first sign in with {login_type}.</>
          : <> To let people sign in with their company account instead, add <Link to="/admin/sign-in">single sign-on</Link>.</>}
      </p>
      {other_error && <Callout intent={Intent.DANGER} style={{ marginBottom: 16 }} role="alert">{error.message}</Callout>}
      <FormGroup label="User name" labelFor="new-user-name" {...fieldError('user_name')}>
        <InputGroup id="new-user-name" name="user_name" autoComplete="off" autoFocus required intent={fieldError('user_name').intent}/>
      </FormGroup>
      <FormGroup label="Full name" labelFor="new-user-full-name" labelInfo="(optional)">
        <InputGroup id="new-user-full-name" name="full_name" autoComplete="off"/>
      </FormGroup>
      <FormGroup label="Email" labelFor="new-user-email" labelInfo="(optional)" {...fieldError('email')} helperText={fieldError('email').helperText ?? "For the emails QA-Board sends, e.g. when their batches end."}>
        <InputGroup id="new-user-email" name="email" type="email" autoComplete="off" intent={fieldError('email').intent}/>
      </FormGroup>
      <RadioGroup label="Password" selectedValue={mode} onChange={event => setMode(event.currentTarget.value)}>
        <Radio value="generate" label="Generate one: you'll copy it on the next step"/>
        <Radio value="choose" label="Choose one"/>
      </RadioGroup>
      {mode === 'choose' && <FormGroup label="Their password" labelFor="new-user-password-input" {...fieldError('password')} helperText={fieldError('password').helperText ?? `At least ${MIN_PASSWORD_LENGTH} characters.`}>
        <InputGroup id="new-user-password-input" name="password" type="password" autoComplete="new-password" intent={fieldError('password').intent}/>
      </FormGroup>}
      <Checkbox checked={is_admin} onChange={() => setIsAdmin(!is_admin)} label="Admin: they manage users, tokens and the server's settings"/>
    </DialogBody>
    <DialogFooter actions={<>
      <Button text="Cancel" onClick={onClose}/>
      <Button type="submit" intent={Intent.PRIMARY} icon="new-person" text="Create the account" loading={saving}/>
    </>}/>
  </form>;
};


export const CreateUserDialog = ({ isOpen, onClose }) => {
  // {user, password?}
  const [created, setCreated] = useState(null);
  const close = () => {
    setCreated(null);
    onClose();
  };
  return <Dialog isOpen={isOpen} onClose={close} title={created ? `Created ${created.user.user_name}` : "New user"} icon="new-person" canOutsideClickClose={!created}>
    {created
      ? <>
        <DialogBody>
          {created.password
            ? <PasswordToGive user_name={created.user.user_name} password={created.password}/>
            : <p style={{ marginTop: 0 }}>Give <strong>{created.user.user_name}</strong> the password you chose. They can change it in <em>Settings → Sign-in methods</em>.</p>}
        </DialogBody>
        <DialogFooter actions={<>
          <Button text="See the user" onClick={() => { const id = created.user.id; close(); history.push(`/admin/users/${id}`); }}/>
          <Button intent={Intent.PRIMARY} text="Done" onClick={close}/>
        </>}/>
      </>
      : <Form onCreated={setCreated} onClose={close}/>}
  </Dialog>;
};

export default CreateUserDialog;
