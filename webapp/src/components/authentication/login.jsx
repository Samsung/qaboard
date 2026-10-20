// Actions that change things (redo, delete, tuning...) need a logged-in user.
// When logged out, the web app disables them and suggests to log in,
// and if the server still answers 401 (e.g. the session expired), it says so once, with a "Log in" button.
import { Button, Intent, MenuItem, MenuDivider, Tooltip } from "@blueprintjs/core";

import { onUnauthorized, reason_messages, is_account_reason, is_token_reason } from "../../api/http";
import { userQuery, logged_out_user, setUser } from "../../api/queries";


// The login button (Auth.jsx) registers how to open its dialog, or the SAML redirect
let loginHandler = null;
export const registerLoginHandler = handler => {
  loginHandler = handler;
  return () => { if (loginHandler === handler) loginHandler = null; };
};

export const requestLogin = () => {
  if (loginHandler) loginHandler();
  else window.scrollTo({top: 0}); // the login button is at the top of the sidebar
};

// First entry of the menus whose actions need a login
export const LoginMenuItem = ({ text = "Log in to redo, rename or delete" }) => <>
  <MenuItem icon="log-in" text={text} intent={Intent.PRIMARY} onClick={requestLogin} data-testid="login-menu-item"/>
  <MenuDivider/>
</>

// Next to a button that needs a login
export const LoginHint = ({ text = "Log in to do this" }) =>
  <Tooltip content={text}>
    <Button icon="log-in" text="Log in" minimal small intent={Intent.PRIMARY} onClick={requestLogin} style={{marginLeft: '5px'}}/>
  </Tooltip>


// Logging in and out, where 401 answers are expected
const login_urls = /\/api\/v1\/user\/(auth|me|logout|signup)\//;

// One toast for all the 401 answers (the toaster skips the per-action ones, see toaster.js),
// and we tell the app we are logged out when the session expired.
// `data` is the answer's body: {error: "<a sentence for people>", reason: "sign_in_required"...}.
// Returns whether it showed a toast.
export const handleUnauthorized = (queryClient, toaster) => ({ url = '', background = false, data } = {}) => {
  if (login_urls.test(url)) return false;
  const reason = data?.reason;
  const sentence = typeof data?.error === 'string' && data.error ? data.error : reason_messages[reason];
  const was_logged = queryClient.getQueryData(userQuery.queryKey)?.is_logged;
  // A disabled or pending account: logging in again won't help
  if (is_account_reason(reason)) {
    setUser(queryClient, { ...logged_out_user, reason, error: sentence });
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
    message: was_logged ? "Your session expired: log in again to do this." : "Log in to do this.",
    intent: Intent.WARNING,
    icon: "log-in",
    action: { text: "Log in", onClick: requestLogin },
    timeout: 10000,
  }, "login-required");
  return true;
};

export const installLoginHandler = (queryClient, toaster) => onUnauthorized(handleUnauthorized(queryClient, toaster));
