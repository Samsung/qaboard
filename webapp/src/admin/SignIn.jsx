// Admin → Sign-in: the ways to sign in (design/user-management.md, Appendix C.6). The environment's providers are
// read-only, admins add OIDC providers here. "Test" runs the checks of `qaboard-admin check-sign-in`.
// Then the settings about who gets an account and how long sessions last.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, ButtonGroup, Callout, Card, Classes, Icon, InputGroup, Intent, NonIdealState, Spinner, Tag, Tooltip } from "@blueprintjs/core";
import styled from "styled-components";

import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { copyWithToast } from "../utils/clipboard";
import { Loading } from "../settings/states";
import { AdminError } from "./states";
import { SettingsTable } from "./Settings";
import { ProviderDialog, match_users_options } from "./ProviderDialog";
import { signInAdminQuery, settingsQuery, deleteProvider, testProvider, reorderProviders } from "./api";


const type_labels = { oidc: 'OIDC', ldap: 'LDAP', saml: 'SAML', local: 'Local accounts' };
const match_labels = Object.fromEntries(match_users_options.map(option => [option.value, option.label]));

// The settings shown with the providers, in this order
const sign_in_settings = [
  'auth.require_sign_in', 'auth.sso_auto_redirect', 'auth.local_signup',
  'auth.access_policy', 'auth.allowed_email_domains', 'auth.access_request_webhook',
  'sessions.idle_days', 'sessions.max_days',
];

const Details = styled.dl`
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 4px 16px;
  margin: 12px 0 0;
  dt { color: var(--qa-text-muted); }
  dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  @media (max-width: 520px) {
    grid-template-columns: minmax(0, 1fr);
    dd { margin-bottom: 6px; }
  }
`;

const Checks = styled.ul`
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  li {
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr);
    gap: 2px 8px;
    padding: 6px 0;
    border-top: 1px solid var(--qa-border);
  }
  .detail { grid-column: 2; overflow-wrap: anywhere; }
`;


// {checks: [{check, ok, detail}], ok}
export const TestResults = ({ result }) => {
  const checks = result?.checks ?? [];
  const failed = checks.filter(check => !check.ok).length;
  return <section aria-label="Test results" style={{ marginTop: 12 }}>
    <strong style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <Icon icon={failed ? 'error' : 'tick-circle'} intent={failed ? Intent.DANGER : Intent.SUCCESS}/>
      {failed ? `${failed} of ${checks.length} check${checks.length === 1 ? '' : 's'} failed` : 'All checks passed'}
    </strong>
    <Checks>
      {checks.map((check, index) => <li key={index} data-testid="check">
        <Icon icon={check.ok ? 'tick' : 'cross'} intent={check.ok ? Intent.SUCCESS : Intent.DANGER} aria-label={check.ok ? 'Passed' : 'Failed'}/>
        <span>{check.check}</span>
        {check.detail && <span className={`detail ${Classes.TEXT_MUTED}`}>{check.detail}</span>}
      </li>)}
    </Checks>
  </section>;
};


const CopyValue = ({ value, what }) => <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, maxWidth: '100%' }}>
  <code style={{ overflowWrap: 'anywhere' }}>{value}</code>
  <Button size="small" variant="minimal" icon="duplicate" aria-label={`Copy the ${what}`} onClick={() => copyWithToast(value, { what: `the ${what}` })}/>
</span>;


// `onMove(provider, -1 | 1)`: up or down on the sign-in page. `focus_move`: {direction} after it moved, to keep the focus on its button.
const ProviderCard = ({ provider, onEdit, onDelete, onMove, is_first, is_last, focus_move }) => {
  const up = useRef(null);
  const down = useRef(null);
  // the card moved in the page: the focus stays on its button, or the other one at the ends
  useEffect(() => {
    if (!focus_move) return;
    const wanted = focus_move.direction < 0 ? (is_first ? down : up) : (is_last ? up : down);
    wanted.current?.focus();
  }, [focus_move, is_first, is_last]);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);
  const [test_error, setTestError] = useState(null);
  const [user_name, setUserName] = useState('');
  const config = provider.config ?? {};
  const from_env = provider.source !== 'database';
  const is_oidc = provider.type === 'oidc';

  const test = () => {
    setTesting(true);
    setTestError(null);
    testProvider(provider.id, { user_name: provider.type === 'ldap' ? user_name.trim() : undefined })
      .then(setResult)
      .catch(error => { setResult(null); setTestError(errorMessage(error)); })
      .finally(() => setTesting(false));
  };

  return <section aria-label={provider.name}><Card compact data-testid={`provider-${provider.id}`}>
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <strong style={{ fontSize: 15 }}>{provider.name}</strong>
      <code className={Classes.TEXT_MUTED}>{provider.id}</code>
      <Tag minimal>{type_labels[provider.type] ?? provider.type}</Tag>
      {provider.enabled === false ? <Tag minimal intent={Intent.DANGER}>Disabled</Tag> : <Tag minimal intent={Intent.SUCCESS}>Enabled</Tag>}
      {provider.recommended && <Tag minimal intent={Intent.PRIMARY} icon="star">Recommended</Tag>}
      {from_env
        ? <Tooltip content="Set in the server's environment: change it there." hoverOpenDelay={300}>
          <Tag minimal intent={Intent.WARNING} icon="lock">environment</Tag>
        </Tooltip>
        : <Tag minimal intent={Intent.PRIMARY}>database</Tag>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginLeft: 'auto' }}>
        <ButtonGroup>
          <Button ref={up} size="small" icon="arrow-up" aria-label={`Move ${provider.name} up`} title="Move up" disabled={is_first} onClick={() => onMove(provider, -1)}/>
          <Button ref={down} size="small" icon="arrow-down" aria-label={`Move ${provider.name} down`} title="Move down" disabled={is_last} onClick={() => onMove(provider, 1)}/>
        </ButtonGroup>
        {provider.type === 'ldap' && <InputGroup
          size="small"
          value={user_name}
          onChange={e => setUserName(e.target.value)}
          placeholder="User to look up (optional)"
          aria-label="User name to look up in LDAP"
          style={{ width: 200 }}
        />}
        <Button size="small" icon="lab-test" text="Test" loading={testing} onClick={test}/>
        {!from_env && <Button size="small" icon="edit" text="Edit" onClick={() => onEdit(provider)}/>}
        {!from_env && <Button size="small" icon="trash" intent={Intent.DANGER} variant="outlined" text="Delete" aria-label={`Delete ${provider.name}`} onClick={() => onDelete(provider)}/>}
      </div>
    </div>

    {(is_oidc || from_env) && <Details>
      {is_oidc && <><dt>Issuer</dt><dd><code>{config.issuer}</code></dd></>}
      {is_oidc && <><dt>Client ID</dt><dd><code>{config.client_id}</code></dd></>}
      {is_oidc && <><dt>Client secret</dt><dd>{config.client_secret_env
        ? <>From <code>${config.client_secret_env}</code></>
        : provider.has_secret ? 'Stored encrypted' : <span style={{ color: 'var(--qa-text-muted)' }}>Not set</span>}</dd></>}
      {is_oidc && config.scopes && <><dt>Scopes</dt><dd><code>{config.scopes.join(' ')}</code></dd></>}
      {is_oidc && config.picture_url && <><dt>Picture URL</dt><dd><code>{config.picture_url}</code></dd></>}
      {is_oidc && <><dt>Existing accounts</dt><dd>{match_labels[config.match_users ?? 'none'] ?? config.match_users}</dd></>}
      {is_oidc && provider.redirect_uri && <><dt>Redirect URI</dt><dd><CopyValue value={provider.redirect_uri} what="redirect URI"/></dd></>}
      {from_env && <><dt>Set up</dt><dd>In the server's environment{provider.type === 'oidc' ? <> (<code>QABOARD_OIDC_*</code>)</> : provider.type === 'local' ? ': always there, for local accounts and admins' : <> (<code>QABOARD_LOGIN_TYPE</code>)</>}.</dd></>}
    </Details>}
    {is_oidc && <p className={Classes.TEXT_MUTED} style={{ fontSize: 12, margin: '8px 0 0' }}>
      Register the redirect URI with the provider, for this client.
    </p>}

    {testing && !result && <div style={{ marginTop: 12 }}><Spinner size={16} aria-label="Testing"/></div>}
    {test_error && <Callout intent={Intent.DANGER} role="alert" style={{ marginTop: 12 }}>Could not test it: {test_error}</Callout>}
    {result && <TestResults result={result}/>}
  </Card></section>;
};


export const SignIn = () => {
  const queryClient = useQueryClient();
  const { data, isPending, error, refetch } = useQuery(signInAdminQuery);
  const { data: settings } = useQuery(settingsQuery);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moved, setMoved] = useState(null);

  if (isPending) return <Loading label="Loading the sign-in methods"/>;
  if (error) return <AdminError error={error} refetch={refetch} what="the sign-in methods"/>;
  const { providers, can_encrypt, public_url } = data;
  const shown_settings = sign_in_settings.map(key => (settings ?? []).find(setting => setting.key === key)).filter(Boolean);

  const confirmDelete = () => {
    const provider = deleting;
    setBusy(true);
    deleteProvider(queryClient, provider?.id)
      .then(() => toaster.show({ message: `Deleted ${provider?.name}`, intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 }))
      .catch(error => toaster.show({ message: errorMessage(error), intent: Intent.DANGER, timeout: 8000 }))
      .finally(() => {
        setBusy(false);
        setDeleting(null);
      });
  };

  const move = (provider, direction) => {
    if (moving) return;
    const order = providers.map(p => p.id);
    const from = order.indexOf(provider.id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    setMoving(true);
    reorderProviders(queryClient, order)
      .then(() => setMoved({ id: provider.id, direction }))
      .catch(error => toaster.show({ message: `Could not move ${provider.name}: ${errorMessage(error)}`, intent: Intent.DANGER, timeout: 8000 }))
      .finally(() => setMoving(false));
  };

  return <section aria-label="Sign-in">
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
      <p className={Classes.TEXT_MUTED} style={{ margin: 0, maxWidth: 680 }}>
        The ways users sign in, in the order of the sign-in page: move them up or down to change it. Methods from the
        server's environment can only be changed there. Add OpenID Connect providers here, e.g. Keycloak, Okta or
        Microsoft Entra ID.
      </p>
      <Button intent={Intent.PRIMARY} icon="plus" text="Add OIDC provider" onClick={() => setEditing('new')}/>
    </div>

    {providers.length === 0
      ? <NonIdealState icon="log-in" title="No sign-in methods" description="Add an OIDC provider."/>
      : <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {providers.map((provider, index) => <ProviderCard
          key={provider.id}
          provider={provider}
          onEdit={setEditing}
          onDelete={setDeleting}
          onMove={move}
          is_first={index === 0}
          is_last={index === providers.length - 1}
          focus_move={moved?.id === provider.id ? moved : null}
        />)}
      </div>}

    {shown_settings.length > 0 && <>
      <h4 className={Classes.HEADING} style={{ marginTop: 32 }}>Accounts and sessions</h4>
      <p className={Classes.TEXT_MUTED} style={{ maxWidth: 720 }}>
        Who gets an account the first time they sign in, who hears about users waiting for approval, and how long
        users stay signed in. Also in Settings.
      </p>
      <SettingsTable settings={shown_settings} label="Sign-in settings"/>
    </>}

    <ProviderDialog
      isOpen={!!editing}
      provider={editing === 'new' ? null : editing}
      onClose={() => setEditing(null)}
      can_encrypt={can_encrypt}
      public_url={public_url}
    />
    <Alert
      isOpen={!!deleting}
      icon="trash"
      intent={Intent.DANGER}
      cancelButtonText="Cancel"
      confirmButtonText="Delete"
      loading={busy}
      onCancel={() => setDeleting(null)}
      onConfirm={confirmDelete}
      canEscapeKeyCancel
    >
      {deleting && <p>
        Delete <strong>{deleting.name}</strong>? It disappears from the sign-in page. Users who only sign in with it
        won't be able to sign in until they get another way, e.g. if you add it again.
      </p>}
    </Alert>
  </section>;
};

export default SignIn;
