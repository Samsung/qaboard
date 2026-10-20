// Settings → Access tokens: for scripts and CI, as the user
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Callout, Classes, Intent, NonIdealState, Switch } from "@blueprintjs/core";

import { QueryError, Loading } from "./states";
import { tokensQuery, revokeToken } from "./api";
import { TokensTable, legacy_tooltip } from "./tokens";
import { CreateTokenDialog } from "./CreateTokenDialog";


export const TokensTab = ({ user }) => {
  const queryClient = useQueryClient();
  const { data: all_tokens, isPending, error, refetch } = useQuery(tokensQuery);
  const [creating, setCreating] = useState(false);
  const [show_inactive, setShowInactive] = useState(false);

  // CLI logins have their own tab
  const tokens = (all_tokens ?? []).filter(token => token.kind !== 'cli');
  const active = tokens.filter(token => (token.status ?? 'active') === 'active');
  const shown = show_inactive ? tokens : active;
  const nb_inactive = tokens.length - active.length;
  const legacy = active.filter(token => token.kind === 'legacy');

  return <section aria-label="Access tokens">
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
      <p className={Classes.TEXT_MUTED} style={{ margin: 0, maxWidth: 640 }}>
        Tokens let scripts and CI jobs use QA-Board as you, e.g. to save runs with <code>qa</code>.
        Give each one a name, only the scopes it needs, and an expiry date.
      </p>
      <Button intent={Intent.PRIMARY} icon="plus" text="New token" onClick={() => setCreating(true)}/>
    </div>

    {legacy.length > 0 && <Callout intent={Intent.WARNING} icon="warning-sign" style={{ marginBottom: 16 }} title={legacy.length === 1 ? "You have a legacy token" : `You have ${legacy.length} legacy tokens`}>
      {legacy_tooltip} Create a new token, use it instead, then revoke the legacy one.
    </Callout>}

    {isPending && <Loading label="Loading your tokens"/>}
    {error && <QueryError error={error} refetch={refetch} what="your tokens"/>}
    {!isPending && !error && (tokens.length === 0
      ? <NonIdealState
        icon="key"
        title="No access tokens yet"
        description="Create one to save runs from CI, or to call the API from a script."
        action={<Button intent={Intent.PRIMARY} icon="plus" text="Create a token" onClick={() => setCreating(true)}/>}
      />
      : <>
        {shown.length > 0
          ? <TokensTable tokens={shown} onRevoke={token => revokeToken(queryClient, token.id)}/>
          : <p className={Classes.TEXT_MUTED}>None of your tokens can be used anymore.</p>}
        {nb_inactive > 0 && <Switch
          style={{ marginTop: 12 }}
          checked={show_inactive}
          onChange={() => setShowInactive(!show_inactive)}
          label={`Show revoked and expired tokens (${nb_inactive})`}
        />}
      </>)}

    <CreateTokenDialog isOpen={creating} onClose={() => setCreating(false)} is_admin={!!user.is_admin}/>
  </section>;
};

export default TokensTab;
