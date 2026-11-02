// Settings → Sign-in methods: the accounts users sign in with (a directory account, a single sign-on...), and the
// single sign-ons they can add. Linking goes through the provider, which sends users back here, with
// ?error=<code>&ref=<id> when it failed (api/sign_in.py).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AnchorButton, Button, Callout, Classes, HTMLTable, Intent, NonIdealState, Tooltip } from "@blueprintjs/core";
import { useLocation } from "react-router";

import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { identitiesQuery, unlinkIdentity, linkUrl } from "../login/api";
import { SignInError } from "../login/SignInError";
import { QueryError, Loading } from "./states";
import { Time } from "./format";


const only_one = "It's your only way to sign in: link another one first.";

export const SignInTab = () => {
  const queryClient = useQueryClient();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const link_error = params.get('error');
  const { data, isPending, error, refetch } = useQuery(identitiesQuery);
  const [unlinking, setUnlinking] = useState(null);
  const [busy, setBusy] = useState(false);
  const [unlink_error, setUnlinkError] = useState(null);
  const identities = data?.identities ?? [];
  const linkable = data?.linkable ?? [];
  const last = identities.length <= 1;

  const confirm = () => {
    const identity = unlinking;
    setBusy(true);
    setUnlinkError(null);
    unlinkIdentity(queryClient, identity.id)
      .then(() => toaster.show({ message: `Unlinked ${identity.provider_name}`, intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 }))
      // e.g. "It's your only way to sign in: add another one first." (400)
      .catch(error => setUnlinkError(errorMessage(error)))
      .finally(() => {
        setBusy(false);
        setUnlinking(null);
      });
  };

  return <section aria-label="Sign-in methods">
    <p className={Classes.TEXT_MUTED} style={{ marginTop: 0, maxWidth: 640 }}>
      The ways you sign in to QA-Board. Link another one to keep access when one of them is unavailable.
    </p>
    {link_error && <SignInError
      code={link_error}
      reference={params.get('ref')}
      provider={data?.linkable?.find(provider => provider.id === params.get('provider'))?.name}
      style={{ marginBottom: 16, maxWidth: 640 }}
    />}
    {unlink_error && <Callout intent={Intent.DANGER} style={{ marginBottom: 16, maxWidth: 640 }} role="alert" title="Could not unlink it">
      {unlink_error}
    </Callout>}
    {isPending && <Loading label="Loading your sign-in methods"/>}
    {error && <QueryError error={error} refetch={refetch} what="your sign-in methods"/>}
    {!isPending && !error && <>
      {identities.length === 0
        ? <NonIdealState icon="log-in" title="No sign-in methods recorded yet" description="They show up here the next time you sign in."/>
        : <div style={{ overflowX: 'auto' }}>
          <HTMLTable compact style={{ width: '100%' }} aria-label="Sign-in methods">
            <thead>
              <tr>
                <th>Method</th>
                <th>Email</th>
                <th>Linked</th>
                <th>Last used</th>
                <th><span className={Classes.TEXT_MUTED} style={{ fontWeight: 'normal' }}>Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {identities.map(identity => <tr key={identity.id} data-testid={`identity-${identity.id}`}>
                <td><strong>{identity.provider_name || identity.provider_id}</strong></td>
                <td>{identity.email || <span className={Classes.TEXT_MUTED}>—</span>}</td>
                <td><Time iso={identity.created_at}/></td>
                <td><Time iso={identity.last_login_at}/></td>
                <td>
                  <Tooltip content={only_one} disabled={!last}>
                    <Button
                      size="small"
                      variant="outlined"
                      intent={Intent.DANGER}
                      text="Unlink"
                      aria-label={`Unlink ${identity.provider_name || identity.provider_id}`}
                      disabled={last}
                      onClick={() => setUnlinking(identity)}
                    />
                  </Tooltip>
                </td>
              </tr>)}
            </tbody>
          </HTMLTable>
        </div>}
      {linkable.length > 0 && <div style={{ marginTop: 20 }}>
        <h4 className={Classes.HEADING}>Add a sign-in method</h4>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {linkable.map(provider => <AnchorButton key={provider.id} icon="link" text={`Link ${provider.name}`} href={linkUrl(provider)}/>)}
        </div>
        <p className={Classes.TEXT_MUTED} style={{ marginTop: 8, fontSize: 12 }}>You sign in there once, then come back here.</p>
      </div>}
    </>}
    <Alert
      isOpen={!!unlinking}
      icon="disable"
      intent={Intent.DANGER}
      cancelButtonText="Cancel"
      confirmButtonText="Unlink"
      loading={busy}
      onCancel={() => setUnlinking(null)}
      onConfirm={confirm}
      canEscapeKeyCancel
    >
      {unlinking && <p>Unlink <strong>{unlinking.provider_name}</strong>? You won't be able to sign in with it anymore, unless you link it again.</p>}
    </Alert>
  </section>;
};

export default SignInTab;
