// Why signing in failed, from the server's redirect: /login?error=<code>&ref=<audit event id> (api/sign_in.py).
// The details are in the audit log and the server's log, never in the URL: users give the reference to their admins.
import { Button, Callout, Classes, Intent } from "@blueprintjs/core";

import { copyWithToast } from "../utils/clipboard";


// `provider`: the single sign-on's name when we know it, e.g. "Company SSO"
const messages = {
  sso_unavailable: provider => ({
    title: `We couldn't reach ${provider ?? 'the sign-in service'}`,
    text: "Try again in a minute; if it keeps failing, tell your admins.",
  }),
  sso_expired: () => ({
    title: "Your sign-in expired",
    text: "Your sign-in took too long or started in another tab. Try again.",
  }),
  sso_failed: provider => ({
    title: `${provider ?? 'The sign-in service'} didn't sign you in`,
    text: "Try again; if it keeps failing, tell your admins.",
  }),
  sso_misconfigured: provider => ({
    title: "Signing in isn't set up correctly",
    text: `QA-Board couldn't read what ${provider ?? 'the sign-in service'} sent. Tell your admins: they need to fix it.`,
  }),
  not_allowed: () => ({
    title: "Your account can't use QA-Board",
    text: "You signed in, but this QA-Board server doesn't accept your account. Ask your admins if you need access.",
  }),
  user_disabled: () => ({
    title: "Your account is disabled",
    text: "Ask an admin if you need it back.",
  }),
  user_pending: () => ({
    title: "Your account is waiting for approval",
    text: "An admin needs to approve your account before you can use QA-Board.",
  }),
  // linking a sign-in method from Settings
  identity_taken: provider => ({
    title: "It's another account's",
    text: `This ${provider ?? 'sign-in'} account is already linked to another QA-Board account. Sign in with it to unlink it there, or ask an admin.`,
  }),
  sign_in_required: () => ({
    title: "Sign in first",
    text: "Sign in, then try again.",
  }),
};
const generic = () => ({
  title: "We couldn't sign you in",
  text: "Try again; if it keeps failing, tell your admins.",
});

export const signInError = (code, provider) => (messages[code] ?? generic)(provider);

const intents = { user_pending: Intent.WARNING, sso_expired: Intent.WARNING, sign_in_required: Intent.WARNING };


export const SignInError = ({ code, reference, provider, style }) => {
  const { title, text } = signInError(code, provider);
  return <Callout intent={intents[code] ?? Intent.DANGER} title={title} role="alert" style={style}>
    <p style={{ marginBottom: reference ? 6 : 0 }}>{text}</p>
    {reference && <p className={Classes.TEXT_MUTED} style={{ margin: 0, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
      <span>Reference: <code>{reference}</code></span>
      <Button
        size="small"
        variant="minimal"
        icon="duplicate"
        aria-label="Copy the reference"
        onClick={() => copyWithToast(String(reference), { what: 'the reference' })}
      />
    </p>}
  </Callout>;
};
