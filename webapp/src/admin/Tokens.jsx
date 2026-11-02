// Admin → Tokens: everyone's tokens, by status
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Classes, HTMLSelect, NonIdealState } from "@blueprintjs/core";

import { Loading } from "../settings/states";
import { TokensTable } from "../settings/tokens";
import { AdminError } from "./states";
import { Pager } from "./Users";
import { adminTokensQuery, adminRevokeToken, tokens_page_size } from "./api";


const status_options = [
  { value: 'active', label: 'Active' },
  { value: 'expired', label: 'Expired' },
  { value: 'idle_expired', label: 'Expired: unused' },
  { value: 'revoked', label: 'Revoked' },
  { value: '', label: 'All' },
];

export const AdminTokens = () => {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('active');
  const [offset, setOffset] = useState(0);
  const { data, isPending, isFetching, error, refetch } = useQuery(adminTokensQuery({ status, offset }));
  const tokens = data?.tokens ?? [];
  const total = data?.total ?? 0;
  return <section aria-label="All tokens">
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
      <HTMLSelect aria-label="Status" options={status_options} value={status} onChange={e => { setStatus(e.target.value); setOffset(0); }}/>
      <span style={{ marginLeft: 'auto' }} className={Classes.TEXT_MUTED}>{!isPending && !error && `${total} token${total === 1 ? '' : 's'}`}</span>
    </div>
    {isPending && <Loading label="Loading tokens"/>}
    {error && <AdminError error={error} refetch={refetch} what="the tokens"/>}
    {!isPending && !error && (tokens.length === 0
      ? <NonIdealState icon="key" title="No tokens" description={status ? 'No token has this status.' : 'Nobody created a token yet.'}/>
      : <div style={{ opacity: isFetching ? 0.7 : 1 }}>
        <TokensTable tokens={tokens} show_user onRevoke={token => adminRevokeToken(queryClient, token.id)}/>
        <Pager offset={offset} page_size={tokens_page_size} shown={tokens.length} total={total} onChange={setOffset}/>
      </div>)}
  </section>;
};

export default AdminTokens;
