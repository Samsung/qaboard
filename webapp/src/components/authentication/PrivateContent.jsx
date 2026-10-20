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


// Logged-out users are checked again each time, logged-in users when the check is stale
const refetchOnMount = query => query.state.data?.is_logged ? true : 'always';

// Shows its content only to logged-in users, when the server requires a login.
// Whether a login is required comes from the site configuration, it wins over the `enabled` prop.
const PrivateContent = ({ children }) => {
  const { login_required, require_sign_in } = useSiteConfig();
  const enabled = !!(login_required || require_sign_in);
  const { data: user = logged_out_user, isPending, error } = useQuery({ ...userQuery, refetchOnMount });

  useEffect(() => {
    if (!error) return;
    toaster.show({ message: errorMessage(error), intent: Intent.DANGER, timeout: 3000 });
  }, [error]);

  if (user.is_logged || !enabled)
    return children;
  // don't flash the login callout while we don't know yet
  if (isPending)
    return null;
  if (user.reason)
    return <AccountCallout user={user}/>;
  return <Callout intent={Intent.PRIMARY}>
    <h4 className={Classes.HEADING}>The content is available for logged-in users only.</h4>
    <AuthButton/>
  </Callout>;
};

// Disabled and pending accounts can't use the server: logging in again won't help
export const AccountCallout = ({ user }) => {
  const pending = user.reason === 'user_pending';
  return <Callout intent={pending ? Intent.WARNING : Intent.DANGER} icon={pending ? "time" : "blocked-person"}>
    <h4 className={Classes.HEADING}>{pending ? "Your account is waiting for approval" : "Your account can't use QA-Board"}</h4>
    <p>{user.error || reason_messages[user.reason]}</p>
  </Callout>;
};

export default PrivateContent;
