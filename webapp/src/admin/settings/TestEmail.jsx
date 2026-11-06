// Admin → Settings → Email: sends a test email with the saved settings, and shows what the SMTP server answered
import { useState } from "react";
import { Button, Callout, Classes, InputGroup, Intent } from "@blueprintjs/core";

import { errorMessage } from "../../api/http";
import { sendTestEmail } from "../api";


export const TestEmail = ({ enabled, me }) => {
  const [to, setTo] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const send = event => {
    event.preventDefault();
    setSending(true);
    setResult(null);
    sendTestEmail(to.trim())
      .then(data => setResult({ ok: true, data }))
      .catch(error => setResult({ ok: false, error: errorMessage(error) }))
      .finally(() => setSending(false));
  };
  return <form onSubmit={send} aria-label="Send a test email" style={{ padding: '14px 16px', background: 'var(--qa-surface-alt)' }}>
    <div style={{ fontWeight: 600, marginBottom: 2 }}>Check the email settings</div>
    <div className={Classes.TEXT_MUTED} style={{ marginBottom: 8, fontSize: 13 }}>Sends an email with the settings saved above, and shows what the SMTP server answered.</div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      <InputGroup
        type="email"
        value={to}
        onChange={e => setTo(e.target.value)}
        placeholder={me?.email ? `To ${me.email}` : 'To this address'}
        aria-label="Send the test email to"
        style={{ width: 280 }}
        disabled={!enabled}
      />
      <Button type="submit" icon="send-message" text="Send a test email" loading={sending} disabled={!enabled}/>
      {!enabled && <span className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>Set the SMTP server first.</span>}
    </div>
    {result?.ok && <Callout intent={Intent.SUCCESS} icon="tick" style={{ marginTop: 8 }} compact>
      Sent to {result.data.to} through {result.data.server}, from {result.data.sender}. Check that it arrived, and not in spam.
    </Callout>}
    {result && !result.ok && <Callout intent={Intent.DANGER} icon="error" style={{ marginTop: 8 }} compact title="The email wasn't sent">
      <span style={{ overflowWrap: 'anywhere' }}>{result.error}</span>
    </Callout>}
  </form>;
};
