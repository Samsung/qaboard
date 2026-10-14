// Actions that change things (redo, delete, tuning...) need a logged-in user.
// When logged out, the web app disables them and suggests to log in,
// and if the server still answers 401 (e.g. the session expired), it says so once, with a "Log in" button.
import { Button, Intent, MenuItem, MenuDivider, Tooltip } from "@blueprintjs/core";

import { onUnauthorized } from "../../api/http";
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


// One toast for all the 401 answers (the toaster skips the per-action ones, see toaster.js),
// and we tell the app we are logged out when the session expired
export const handleUnauthorized = (queryClient, toaster) => ({ url = '', background = false }) => {
  if (url.includes('/api/v1/user/')) return; // logging in
  const was_logged = queryClient.getQueryData(userQuery.queryKey)?.is_logged;
  if (was_logged) setUser(queryClient, logged_out_user);
  if (background) return;
  toaster.show({
    message: was_logged ? "Your session expired: log in again to do this." : "Log in to do this.",
    intent: Intent.WARNING,
    icon: "log-in",
    action: { text: "Log in", onClick: requestLogin },
    timeout: 10000,
  }, "login-required");
};

export const installLoginHandler = (queryClient, toaster) => onUnauthorized(handleUnauthorized(queryClient, toaster));
