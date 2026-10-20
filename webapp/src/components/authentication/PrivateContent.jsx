import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Classes,
  Intent,
  Callout,
} from "@blueprintjs/core";
import AuthButton from "./Auth"
import { userQuery, logged_out_user } from "../../api/queries";
import { errorMessage, reason_messages } from "../../api/http";
import { useSiteConfig } from "../../hooks";
import { toaster } from "./../../toaster"


// Signed-out users are checked again each time, signed-in users when the check is stale
const refetchOnMount = query => query.state.data?.is_logged ? true : 'always';

// Shows its content only to signed-in users, when the server requires signing in.
// Whether it's required comes from the site configuration, it wins over the `enabled` prop.
// Disabled and pending accounts are told why they are signed out.
const PrivateContent = ({ children }) => {
  const { login_required, require_sign_in } = useSiteConfig();
  const enabled = !!(login_required || require_sign_in);
  const { data: user = logged_out_user, isPending, error } = useQuery({ ...userQuery, refetchOnMount });

  useEffect(() => {
    if (!error) return;
    toaster.show({ message: errorMessage(error), intent: Intent.DANGER, timeout: 3000 });
  }, [error]);

  // when signing in isn't required, the sign-in button says why (see Auth.jsx)
  if (user.is_logged || !enabled)
    return children;
  // don't flash the login callout while we don't know yet
  if (isPending)
    return null;
  if (user.reason)
    return <AccountCallout user={user}/>;
  return <Callout intent={Intent.PRIMARY}>
    <h4 className={Classes.HEADING}>Sign in to see the content.</h4>
    <AuthButton/>
  </Callout>;
};

// Disabled and pending accounts can't use the server: signing in again won't help
export const AccountCallout = ({ user, style }) => {
  const pending = user.reason === 'user_pending';
  return <Callout intent={pending ? Intent.WARNING : Intent.DANGER} icon={pending ? "time" : "blocked-person"} style={style} role="alert">
    <h4 className={Classes.HEADING}>{pending ? "Your account is pending approval" : "Your account is disabled"}</h4>
    <p>{user.error || reason_messages[user.reason]}</p>
  </Callout>;
};

export default PrivateContent;
