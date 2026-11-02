// Actions that change things (redo, delete, tuning...) need a signed-in user.
// When signed out, the web app disables them and suggests to sign in,
// and if the server still answers 401 (e.g. the session expired), it says so once, with a "Sign in" button.
// Signing in happens on /login?next=<this page> (login/LoginPage.jsx): single sign-on leaves the app anyway,
// so every way to sign in starts there, and comes back.
import { Button, Intent, MenuItem, MenuDivider, Tooltip } from "@blueprintjs/core";

import { onUnauthorized, reason_messages, is_account_reason, is_token_reason } from "../../api/http";
import { userQuery, logged_out_user, setUser } from "../../api/queries";
import { history } from "../../router";
import { loginUrl } from "../../login/api";


// To /login, then back to this page
export const requestLogin = () => {
  if (window.location.pathname === '/login') return;
  history.push(loginUrl());
};

// First entry of the menus whose actions need to sign in
export const LoginMenuItem = ({ text = "Sign in to redo, rename or delete" }) => <>
  <MenuItem icon="log-in" text={text} intent={Intent.PRIMARY} onClick={requestLogin} data-testid="login-menu-item"/>
  <MenuDivider/>
</>

// Next to a button that needs to sign in
export const LoginHint = ({ text = "Sign in to do this" }) =>
  <Tooltip content={text}>
    <Button icon="log-in" text="Sign in" variant="minimal" size="small" intent={Intent.PRIMARY} onClick={requestLogin} style={{marginLeft: '5px'}}/>
  </Tooltip>


// Signing in and out, where 401 answers are expected
const login_urls = /\/api\/v1\/user\/(auth|me|logout|signup)\//;

// One toast for all the 401 answers (the toaster skips the per-action ones, see toaster.js),
// and we tell the app we are signed out when the session expired.
// `data` is the answer's body: {error: "<a sentence for people>", reason: "sign_in_required"...}.
// Returns whether it showed a toast.
export const handleUnauthorized = (queryClient, toaster) => ({ url = '', background = false, data } = {}) => {
  if (login_urls.test(url)) return false;
  const reason = data?.reason;
  const sentence = typeof data?.error === 'string' && data.error ? data.error : reason_messages[reason];
  const was_logged = queryClient.getQueryData(userQuery.queryKey)?.is_logged;
  // A disabled or pending account: signing in again won't help
  if (is_account_reason(reason)) {
    setUser(queryClient, { ...logged_out_user, reason, error: sentence });
    // pending users keep their session: /me says what their page shows, their access request
    if (reason === 'user_pending') queryClient.invalidateQueries({ queryKey: userQuery.queryKey });
    if (background) return false;
    toaster.show({ message: sentence, intent: Intent.DANGER, icon: "blocked-person", timeout: 10000 }, "login-required");
    return true;
  }
  // The web app uses its session: a broken token comes from a link (?token=), the session may be fine
  if (is_token_reason(reason)) {
    if (background) return false;
    toaster.show({ message: sentence, intent: Intent.WARNING, icon: "key", timeout: 10000 }, "login-required");
    return true;
  }
  if (was_logged) setUser(queryClient, logged_out_user);
  if (background) return false;
  toaster.show({
    message: was_logged ? "Your session expired: sign in again to do this." : "Sign in to do this.",
    intent: Intent.WARNING,
    icon: "log-in",
    action: { text: "Sign in", onClick: requestLogin },
    timeout: 10000,
  }, "login-required");
  return true;
};

export const installLoginHandler = (queryClient, toaster) => onUnauthorized(handleUnauthorized(queryClient, toaster));
