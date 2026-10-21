import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AnchorButton,
  Classes,
  Intent,
  Callout,
} from "@blueprintjs/core";
import { userQuery, logged_out_user } from "../../api/queries";
import { errorMessage, reason_messages } from "../../api/http";
import { useSiteConfig } from "../../hooks";
import { history } from "../../router";
import { toaster } from "./../../toaster"
import { loginUrl } from "../../login/api";
import { PendingAccount } from "../../login/PendingAccount";


// Signed-out users are checked again each time, signed-in users when the check is stale
const refetchOnMount = query => query.state.data?.is_logged ? true : 'always';

// Shows its content only to signed-in users, when the server requires signing in: the others go to /login, and come
// back. Whether it's required comes from the site configuration, it wins over the `enabled` prop.
// Disabled accounts are told why they are signed out, pending ones see their access request.
const PrivateContent = ({ children }) => {
  const { login_required, require_sign_in } = useSiteConfig();
  const enabled = !!(login_required || require_sign_in);
  const { data: user = logged_out_user, isPending, error } = useQuery({ ...userQuery, refetchOnMount });
  const to_login = enabled && !isPending && !user.is_logged && !user.reason;

  useEffect(() => {
    if (!error) return;
    toaster.show({ message: errorMessage(error), intent: Intent.DANGER, timeout: 3000 });
  }, [error]);
  useEffect(() => { if (to_login) history.replace(loginUrl()); }, [to_login]);

  // when signing in isn't required, the sign-in button says why (see Auth.jsx)
  if (user.is_logged || !enabled)
    return children;
  // don't flash the login callout while we don't know yet
  if (isPending)
    return null;
  if (user.reason)
    return <AccountCallout user={user} style={{ margin: '48px auto', maxWidth: 560 }}/>;
  return null;
};

// Disabled and pending accounts can't use the server: signing in again won't help. Pending users can tell admins why
// they need access.
export const AccountCallout = ({ user, style }) => {
  if (user.reason === 'user_pending')
    return <PendingAccount user={user} style={style}/>;
  return <Callout intent={Intent.DANGER} icon="blocked-person" style={style} role="alert">
    <h4 className={Classes.HEADING}>Your account is disabled</h4>
    <p>{user.error || reason_messages[user.reason]}</p>
    <AnchorButton icon="log-in" text="Sign in with another account" href={loginUrl()} onClick={event => { event.preventDefault(); history.push(loginUrl()); }}/>
  </Callout>;
};

export default PrivateContent;
