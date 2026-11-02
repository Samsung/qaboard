// Settings → Sessions: the browsers where users are signed in (design/user-management.md, Appendix C.3).
// Revoking one signs that browser out at its next request; revoking this one signs out here.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Classes, HTMLTable, Intent, NonIdealState, Tag } from "@blueprintjs/core";

import { history } from "../router";
import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { sessionsQuery, revokeSession, revokeOtherSessions, loginUrl } from "../login/api";
import { QueryError, Loading } from "./states";
import { Time } from "./format";


// "Firefox on Linux": the full user agent says more than people need. Not a browser: its first word, e.g. "curl".
const browsers = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrom(?:e|ium)\/|\bCriOS\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];
const systems = [
  [/\b(?:iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b|\bX11\b/, 'Linux'],
];
const first_match = (patterns, text) => patterns.find(([pattern]) => pattern.test(text))?.[1] ?? null;

export const describeUserAgent = user_agent => {
  if (!user_agent) return 'Unknown browser';
  const browser = first_match(browsers, user_agent);
  const system = first_match(systems, user_agent);
  if (browser && system) return `${browser} on ${system}`;
  if (browser || system) return browser ?? `A browser on ${system}`;
  const word = user_agent.split(/[\s/;(]/)[0];
  return word || 'Unknown browser';
};


export const SessionsTab = () => {
  const queryClient = useQueryClient();
  const { data: sessions, isPending, error, refetch } = useQuery(sessionsQuery);
  const [revoking, setRevoking] = useState(null);
  const [busy, setBusy] = useState(false);

  const confirm = () => {
    const session = revoking;
    setBusy(true);
    if (session.others) {
      revokeOtherSessions(queryClient)
        .then(({ revoked }) => toaster.show({ message: `Signed out ${revoked} other ${revoked === 1 ? 'browser' : 'browsers'}`, intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 }))
        .catch(error => toaster.show({ message: `Could not sign out the other browsers: ${errorMessage(error)}`, intent: Intent.DANGER }))
        .finally(() => {
          setBusy(false);
          setRevoking(null);
        });
      return;
    }
    revokeSession(queryClient, session)
      .then(() => {
        if (session.current) {
          toaster.show({ message: "You're signed out", intent: Intent.WARNING, icon: 'log-out', timeout: 3000 });
          history.replace(loginUrl('/settings/sessions'));
        } else
          toaster.show({ message: `Signed out ${describeUserAgent(session.user_agent)}`, intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 });
      })
      .catch(error => toaster.show({ message: `Could not revoke the session: ${errorMessage(error)}`, intent: Intent.DANGER }))
      .finally(() => {
        setBusy(false);
        setRevoking(null);
      });
  };

  // this browser first
  const sorted = [...(sessions ?? [])].sort((a, b) => !!b.current - !!a.current);
  return <section aria-label="Sessions">
    <p className={Classes.TEXT_MUTED} style={{ marginTop: 0, maxWidth: 640 }}>
      The browsers where you're signed in. If you don't recognize one, revoke it: it's signed out right away.
      Sessions also end after a while without use. Computers where you use <code>qa</code> are in CLI sign-ins.
    </p>
    {sorted.filter(session => !session.current).length > 1 && <Button
      variant="outlined"
      intent={Intent.DANGER}
      icon="log-out"
      text="Sign out everywhere else"
      onClick={() => setRevoking({ others: true })}
      style={{ marginBottom: 12 }}
    />}
    {isPending && <Loading label="Loading your sessions"/>}
    {error && <QueryError error={error} refetch={refetch} what="your sessions"/>}
    {!isPending && !error && (sorted.length === 0
      ? <NonIdealState icon="desktop" title="No sessions" description="Browsers where you sign in show up here."/>
      : <div style={{ overflowX: 'auto' }}>
        <HTMLTable compact style={{ width: '100%' }} aria-label="Sessions">
          <thead>
            <tr>
              <th>Browser</th>
              <th>IP address</th>
              <th>Signed in</th>
              <th>Last active</th>
              <th><span className={Classes.TEXT_MUTED} style={{ fontWeight: 'normal' }}>Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(session => <tr key={session.id} data-testid={`session-${session.id}`}>
              <td>
                <strong title={session.user_agent ?? undefined}>{describeUserAgent(session.user_agent)}</strong>
                {session.current && <Tag minimal intent={Intent.SUCCESS} style={{ marginLeft: 8 }}>This browser</Tag>}
              </td>
              <td>{session.ip ? <code>{session.ip}</code> : <span className={Classes.TEXT_MUTED}>—</span>}</td>
              <td><Time iso={session.created_at}/></td>
              <td><Time iso={session.last_seen_at}/></td>
              <td>
                <Button
                  size="small"
                  variant="outlined"
                  intent={Intent.DANGER}
                  text={session.current ? "Sign out" : "Revoke"}
                  aria-label={session.current ? "Sign out of this browser" : `Revoke ${describeUserAgent(session.user_agent)}${session.ip ? ` from ${session.ip}` : ''}`}
                  onClick={() => setRevoking(session)}
                />
              </td>
            </tr>)}
          </tbody>
        </HTMLTable>
      </div>)}
    <Alert
      isOpen={!!revoking}
      icon={revoking?.current || revoking?.others ? "log-out" : "trash"}
      intent={Intent.DANGER}
      cancelButtonText="Cancel"
      confirmButtonText={revoking?.others ? "Sign out everywhere else" : revoking?.current ? "Sign out" : "Revoke"}
      loading={busy}
      onCancel={() => setRevoking(null)}
      onConfirm={confirm}
      canEscapeKeyCancel
    >
      {revoking && (revoking.others
        ? <p>Sign out every browser but this one? Whoever uses them will need to sign in again.</p>
        : revoking.current
        ? <p>This is the browser you're using: you'll be signed out here.</p>
        : <p>Sign out <strong>{describeUserAgent(revoking.user_agent)}</strong>{revoking.ip ? <> from <code>{revoking.ip}</code></> : null}? Whoever uses it will need to sign in again.</p>)}
    </Alert>
  </section>;
};

export default SessionsTab;
