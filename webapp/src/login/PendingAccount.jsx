// Pending users (auth.access_policy "domains" or "approval") are signed in, but wait for an admin.
// They see their request, and say why they need access: admins get it by email or in their chat (the webhook).
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Callout, Card, Classes, FormGroup, Icon, Intent, Tag, TextArea } from "@blueprintjs/core";

import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { Time } from "../settings/format";
import { sendAccessRequest, signOut } from "./api";


const status_tags = {
  pending: <Tag minimal intent={Intent.WARNING} icon="time">Waiting for an admin</Tag>,
  approved: <Tag minimal intent={Intent.SUCCESS} icon="tick">Approved</Tag>,
  denied: <Tag minimal intent={Intent.DANGER} icon="cross">Denied</Tag>,
};

// "Alice", "Alice and Bob", "Alice, Bob and Carol"
const names = list => list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;


export const PendingAccount = ({ user, style }) => {
  const queryClient = useQueryClient();
  const pending = user.pending ?? {};
  const request = pending.request ?? null;
  const [message, setMessage] = useState(request?.message ?? '');
  const [editing, setEditing] = useState(!request?.message);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);
  const reviewers = pending.reviewers ?? [];
  const who = pending.full_name || pending.user_name || user.user_name;

  const submit = event => {
    event.preventDefault();
    if (!message.trim()) {
      setError("Say why you need access, e.g. your team and your projects.");
      return;
    }
    setBusy(true);
    setError(null);
    sendAccessRequest(queryClient, message.trim())
      .then(() => {
        setSent(true);
        setEditing(false);
      })
      .catch(error => setError(errorMessage(error)))
      .finally(() => setBusy(false));
  };

  const sign_out = () => signOut(queryClient)
    .catch(error => toaster.show({ message: errorMessage(error), intent: Intent.DANGER }));

  return <section aria-label="Your account is waiting for approval" style={{ maxWidth: 560, ...style }}><Card>
    <h3 className={Classes.HEADING} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Icon icon="time" intent={Intent.WARNING} size={20}/>Your account is waiting for approval
    </h3>
    <p>
      {who ? <>You're signed in as <strong>{who}</strong>{pending.email ? <> ({pending.email})</> : null}. </> : null}
      An admin needs to approve your account before you can use QA-Board.
      {reviewers.length > 0 && <> {names(reviewers)} {reviewers.length === 1 ? 'reviews' : 'review'} requests.</>}
      {' '}You'll get an email when they decide, if this server sends emails.
    </p>

    {request && <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 }} data-testid="access-request">
      {status_tags[request.status] ?? <Tag minimal>{request.status}</Tag>}
      {request.created_at && <span className={Classes.TEXT_MUTED}>Requested <Time iso={request.created_at}/></span>}
    </div>}

    {sent && <Callout intent={Intent.SUCCESS} icon="tick" style={{ marginBottom: 12 }} aria-live="polite">
      Sent. The admins will see your message with your request.
    </Callout>}

    {editing
      ? <form onSubmit={submit}>
        <FormGroup
          label="Why do you need access?"
          labelFor="access-request-message"
          helperText={error ?? "Your team and the projects you work on help admins decide."}
          intent={error ? Intent.DANGER : undefined}
        >
          <TextArea
            id="access-request-message"
            value={message}
            onChange={e => setMessage(e.target.value)}
            fill
            autoResize
            rows={3}
            maxLength={2000}
            intent={error ? Intent.DANGER : undefined}
          />
        </FormGroup>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <Button type="submit" intent={Intent.PRIMARY} text={request?.message ? "Update the message" : "Send to the admins"} loading={busy}/>
          {request?.message && <Button variant="minimal" text="Cancel" onClick={() => { setEditing(false); setMessage(request.message); setError(null); }}/>}
          <Button variant="minimal" icon="log-out" text="Sign out" onClick={sign_out} style={{ marginLeft: 'auto' }}/>
        </div>
      </form>
      : <>
        <h4 className={Classes.HEADING} style={{ fontSize: 14 }}>Your message</h4>
        <blockquote className={Classes.BLOCKQUOTE} style={{ margin: '0 0 12px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{request?.message}</blockquote>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <Button icon="edit" text="Edit the message" onClick={() => { setEditing(true); setSent(false); }}/>
          <Button variant="minimal" icon="log-out" text="Sign out" onClick={sign_out} style={{ marginLeft: 'auto' }}/>
        </div>
      </>}
  </Card></section>;
};

export default PendingAccount;
