// /device: users approve here the logins `qa auth login` starts on their computers (OAuth device flow, RFC 8628).
// The CLI prints a code, e.g. WDJB-MJHT, and a link to /device?code=WDJB-MJHT.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Callout, Card, Classes, FormGroup, InputGroup, Intent, NonIdealState } from "@blueprintjs/core";
import { useLocation } from "react-router";

import { http, errorMessage } from "../api/http";
import { history, Link } from "../router";
import { PageShell, RequireLogin } from "../components/PageShell";
import { Loading } from "../settings/states";
import { ScopeTags, Time } from "../settings/format";


// Codes are 8 letters, shown in two groups. Users may type them in lower case, without the dash, with spaces...
export const normalizeCode = text => {
  const letters = (text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters;
};

export const deviceQuery = code => ({
  queryKey: ['device', code],
  queryFn: async ({ signal }) => (await http.get('/api/v1/auth/device', { params: { code }, signal })).data,
  enabled: !!code,
  // the request expires, or another tab approves it
  staleTime: 0,
  retry: false,
});

const scope_sentences = {
  read: 'see projects and runs',
  ingest: 'save runs',
  act: 'redo, delete and tune runs',
  manage: "change projects' settings",
  admin: 'use the admin API',
};
const what_it_can_do = scopes => {
  const phrases = (scopes ?? []).map(scope => scope_sentences[scope] ?? scope);
  if (phrases.length <= 1) return phrases.join('');
  return `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1)}`;
};


const CodeForm = ({ initial = '', error }) => {
  const [text, setText] = useState(initial);
  const submit = event => {
    event.preventDefault();
    const code = normalizeCode(text);
    if (code) history.replace(`/device?code=${encodeURIComponent(code)}`);
  };
  return <Card style={{ maxWidth: 480 }}>
    <form onSubmit={submit}>
      <h4 className={Classes.HEADING}>Log in from the command line</h4>
      <p className={Classes.TEXT_MUTED}>Type the code that <code>qa auth login</code> shows in your terminal.</p>
      {error && <Callout intent={Intent.DANGER} style={{ marginBottom: 12 }} role="alert">{error}</Callout>}
      <FormGroup label="Code" labelFor="device-code">
        <InputGroup
          id="device-code"
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="WDJB-MJHT"
          size="large"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          className={Classes.MONOSPACE_TEXT}
          style={{ textTransform: 'uppercase', letterSpacing: 2 }}
        />
      </FormGroup>
      <Button type="submit" intent={Intent.PRIMARY} text="Continue" disabled={!normalizeCode(text)}/>
    </form>
  </Card>;
};


const Done = ({ status, device }) => {
  const where = device?.hostname ? <strong>{device.hostname}</strong> : 'your computer';
  if (status === 'approved')
    return <NonIdealState icon="tick-circle" title="You're logged in" description={<p>Go back to your terminal: <code>qa</code> can now work as you on {where}.</p>}/>;
  if (status === 'denied')
    return <NonIdealState icon="disable" title="Login denied" description={<p>Nothing was shared with {where}. If you didn't start this login, you're all set.</p>}/>;
  return <NonIdealState
    icon="time"
    title="This code expired"
    description={<p>Run <code>qa auth login</code> again to get a new code.</p>}
    action={<Button text="Type another code" onClick={() => history.replace('/device')}/>}
  />;
};


const Approve = ({ code, user }) => {
  const queryClient = useQueryClient();
  const { data: device, isPending, error } = useQuery(deviceQuery(code));
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(null);
  const [answer_error, setAnswerError] = useState(null);

  if (isPending) return <Loading label="Looking for the login request"/>;
  if (error)
    return <CodeForm
      initial={code}
      error={error.response?.status === 404
        ? "This code doesn't match any login request. Check it in your terminal, or run qa auth login again."
        : errorMessage(error)}
    />;
  const status = result ?? device?.status ?? 'pending';
  if (status !== 'pending') return <Done status={status} device={device}/>;

  const answer = approve => {
    setBusy(approve ? 'approve' : 'deny');
    setAnswerError(null);
    http.post('/api/v1/auth/device', { code, approve })
      .then(({ data }) => {
        setResult(data?.status ?? (approve ? 'approved' : 'denied'));
        queryClient.invalidateQueries({ queryKey: ['tokens'] });
      })
      .catch(error => setAnswerError(errorMessage(error)))
      .finally(() => setBusy(null));
  };

  const client = device?.client_name || 'qa CLI';
  return <Card style={{ maxWidth: 560 }}>
    <h4 className={Classes.HEADING}>Authorize {client}{device?.hostname && !client.includes(device.hostname) ? ` on ${device.hostname}` : ''}?</h4>
    <p>
      It will be able to {what_it_can_do(device?.scopes) || 'use QA-Board'} as <strong>{user.user_name}</strong>, until you revoke it
      in <Link to="/settings/cli">Settings → CLI &amp; devices</Link>.
    </p>
    <table className={Classes.TEXT_MUTED} style={{ marginBottom: 12, borderSpacing: '12px 4px', marginLeft: -12 }}>
      <tbody>
        <tr><td>Code</td><td><code>{code}</code></td></tr>
        {device?.hostname && <tr><td>Computer</td><td>{device.hostname}</td></tr>}
        {/* where the request came from: a code someone sent you would come from elsewhere */}
        {device?.ip && <tr><td>From</td><td><code>{device.ip}</code></td></tr>}
        <tr><td>Scopes</td><td><ScopeTags scopes={device?.scopes}/></td></tr>
        {device?.created_at && <tr><td>Requested</td><td><Time iso={device.created_at}/></td></tr>}
        {device?.expires_at && <tr><td>Expires</td><td><Time iso={device.expires_at}/></td></tr>}
      </tbody>
    </table>
    <Callout intent={Intent.WARNING} icon="warning-sign" style={{ marginBottom: 16 }}>
      Only approve if you just ran <code>qa auth login</code> yourself and the code matches your terminal.
      Never approve a code someone sent you.
    </Callout>
    {answer_error && <Callout intent={Intent.DANGER} style={{ marginBottom: 12 }} role="alert">{answer_error}</Callout>}
    <div style={{ display: 'flex', gap: 8 }}>
      <Button intent={Intent.PRIMARY} icon="tick" text="Approve" loading={busy === 'approve'} disabled={!!busy} onClick={() => answer(true)}/>
      <Button icon="cross" text="Deny" loading={busy === 'deny'} disabled={!!busy} onClick={() => answer(false)}/>
    </div>
  </Card>;
};


export const DevicePage = () => {
  const location = useLocation();
  const code = normalizeCode(new URLSearchParams(location.search).get('code'));
  return <PageShell title="Device login" description="Approve here the logins you start from the command line, with qa auth login.">
    <RequireLogin what="approve this login">
      {user => code ? <Approve key={code} code={code} user={user}/> : <CodeForm/>}
    </RequireLogin>
  </PageShell>;
};

export default DevicePage;
