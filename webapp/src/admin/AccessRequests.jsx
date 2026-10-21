// Admin → Access requests: users waiting for an admin (auth.access_policy "domains" or "approval"), with why they
// need access. Approving or denying changes the user's status, like on their page: their request is decided with it.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Classes, HTMLSelect, Intent, NonIdealState, Tag } from "@blueprintjs/core";

import { Link } from "../router";
import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { Time } from "../settings/format";
import { Loading } from "../settings/states";
import { AdminError } from "./states";
import { accessRequestsQuery, updateUser } from "./api";


export const request_status_tags = {
  pending: <Tag minimal intent={Intent.WARNING}>Pending</Tag>,
  approved: <Tag minimal intent={Intent.SUCCESS}>Approved</Tag>,
  denied: <Tag minimal intent={Intent.DANGER}>Denied</Tag>,
};

export const RequestMessage = ({ message }) => message
  ? <blockquote className={Classes.BLOCKQUOTE} style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message}</blockquote>
  : <p className={Classes.TEXT_MUTED} style={{ margin: '8px 0 0' }}>No message yet.</p>;


// Approve, or deny after asking. `onDone` once decided.
export const DecideButtons = ({ user, onDone }) => {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(null);
  const [denying, setDenying] = useState(false);
  const decide = approve => {
    setBusy(approve ? 'approve' : 'deny');
    updateUser(queryClient, user.id, { status: approve ? 'active' : 'disabled' })
      .then(() => {
        toaster.show({ message: approve ? `Approved ${user.user_name}: they can sign in` : `Denied ${user.user_name}'s account`, intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 });
        onDone?.();
      })
      .catch(error => toaster.show({ message: errorMessage(error), intent: Intent.DANGER, timeout: 8000 }))
      .finally(() => {
        setBusy(null);
        setDenying(false);
      });
  };
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
    <Button icon="tick" intent={Intent.SUCCESS} text="Approve" aria-label={`Approve ${user.user_name}`} loading={busy === 'approve'} disabled={!!busy} onClick={() => decide(true)}/>
    <Button icon="cross" intent={Intent.DANGER} variant="outlined" text="Deny" aria-label={`Deny ${user.user_name}`} loading={busy === 'deny'} disabled={!!busy} onClick={() => setDenying(true)}/>
    <Alert
      isOpen={denying}
      intent={Intent.DANGER}
      icon="warning-sign"
      cancelButtonText="Cancel"
      confirmButtonText="Deny"
      loading={busy === 'deny'}
      onCancel={() => setDenying(false)}
      onConfirm={() => decide(false)}
      canEscapeKeyCancel
    >
      <p>Deny <strong>{user.user_name}</strong>'s account? It is disabled: they can't sign in. You can enable it later.</p>
    </Alert>
  </div>;
};


export const AccessRequests = () => {
  const [status, setStatus] = useState('pending');
  const { data: requests, isPending, error, refetch } = useQuery(accessRequestsQuery(status));
  return <section aria-label="Access requests">
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
      <p className={Classes.TEXT_MUTED} style={{ margin: 0, maxWidth: 680 }}>
        Users who signed in and wait for an admin, depending on <Link to="/admin/sign-in"><code>auth.access_policy</code></Link>.
        They get an email when you decide, if this server sends emails.
      </p>
      <HTMLSelect aria-label="Show" value={status} onChange={e => setStatus(e.target.value)} options={[
        { value: 'pending', label: 'Pending' },
        { value: 'all', label: 'All requests' },
      ]}/>
    </div>
    {isPending && <Loading label="Loading the access requests"/>}
    {error && <AdminError error={error} refetch={refetch} what="the access requests"/>}
    {!isPending && !error && (requests.length === 0
      ? <NonIdealState
        icon="endorsed"
        title={status === 'pending' ? "No one is waiting" : "No access requests yet"}
        description={status === 'pending' ? "New requests show up here, and admins hear about them by email or in the chat webhook." : "Requests show up here when the access policy makes new users wait for an admin."}
      />
      : <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {requests.map(request => <Card compact key={request.id} data-testid={`request-${request.id}`}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              {request.user
                ? <Link to={`/admin/users/${request.user.id}`}><strong>{request.user.full_name || request.user.user_name}</strong></Link>
                : <strong className={Classes.TEXT_MUTED}>Deleted user</strong>}
              <div className={Classes.TEXT_MUTED} style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
                {request.user?.full_name && <>{request.user.user_name} · </>}
                {request.user?.email && <>{request.user.email} · </>}
                asked <Time iso={request.created_at}/>
                {request.decided_at && <> · decided <Time iso={request.decided_at}/></>}
              </div>
            </div>
            {request.status === 'pending' && request.user
              ? <DecideButtons user={request.user}/>
              : request_status_tags[request.status] ?? <Tag minimal>{request.status}</Tag>}
          </div>
          <RequestMessage message={request.message}/>
        </Card>)}
      </div>)}
  </section>;
};

export default AccessRequests;
