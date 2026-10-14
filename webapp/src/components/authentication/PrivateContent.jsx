import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Classes,
  Intent,
  Callout,
} from "@blueprintjs/core";
import AuthButton from "./Auth"
import { userQuery, logged_out_user } from "../../api/queries";
import { errorMessage } from "../../api/http";
import { useSiteConfig } from "../../hooks";
import { toaster } from "./../../toaster"


// Logged-out users are checked again each time, logged-in users when the check is stale
const refetchOnMount = query => query.state.data?.is_logged ? true : 'always';

// Shows its content only to logged-in users, when the server requires a login.
// Whether a login is required comes from the site configuration, it wins over the `enabled` prop.
const PrivateContent = ({ children }) => {
  const { login_required: enabled } = useSiteConfig();
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
  return <Callout intent={Intent.PRIMARY}>
    <h4 className={Classes.HEADING}>The content is available for logged-in users only.</h4>
    <AuthButton/>
  </Callout>;
};

export default PrivateContent;
