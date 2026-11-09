// The CI jobs a service account trusts (backend/ci_trust.py): GitHub Actions or GitLab CI jobs of a repository,
// optionally a branch or an environment, exchange their OIDC ID token for a short-lived token of the account.
// No secret to store in the CI.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button, Callout, Classes, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect, HTMLTable, InputGroup, Intent, Tag,
} from "@blueprintjs/core";

import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { useSiteConfig } from "../hooks";
import { Time } from "../settings/format";
import { Snippet } from "../settings/CreateTokenDialog";
import { addCiTrust, removeCiTrust } from "./serviceAccounts";


const GITLAB_COM = 'https://gitlab.com';
// what people choose => what the server gets
export const presets = {
  github: { label: 'GitHub Actions', provider: 'github', repository: 'Repository', placeholder: 'camera-algo/isp' },
  gitlab: { label: 'GitLab.com', provider: 'gitlab', issuer: GITLAB_COM, repository: 'Project path', placeholder: 'camera-algo/isp' },
  'gitlab-self-hosted': { label: 'Self-hosted GitLab', provider: 'gitlab', ask_issuer: 'GitLab URL', issuer_placeholder: 'https://gitlab.example.com', repository: 'Project path', placeholder: 'camera-algo/isp' },
  other: { label: 'Other OpenID Connect issuer', provider: 'other', ask_issuer: 'Issuer URL', issuer_placeholder: 'https://ci.example.com', repository: 'Subject (sub claim)', placeholder: 'repo:camera-algo/isp:*' },
};
// the claim that says which repository it is (the server requires a condition on it)
const repository_claims = { github: 'repository', gitlab: 'project_path', other: 'sub' };

const host = url => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export const ciName = policy => {
  if (policy.provider === 'github') return 'GitHub Actions';
  if (policy.provider === 'gitlab') return policy.issuer === GITLAB_COM ? 'GitLab.com' : `GitLab (${host(policy.issuer)})`;
  return host(policy.issuer);
};

// The CI's configuration that gets the ID token
export const ciSnippet = (policy, account) => {
  if (policy.provider === 'github') return {
    title: 'In the workflow, or the job, that runs qa',
    code: `permissions:\n  id-token: write  # qa exchanges the job's ID token for a QA-Board token\n  contents: read`,
    hint: <>If several service accounts trust this job, choose this one in the job's <code>env</code>: <code>QABOARD_SERVICE_ACCOUNT: {account.user_name}</code>.</>,
  };
  if (policy.provider === 'gitlab') return {
    title: 'In the .gitlab-ci.yml job that runs qa',
    code: `qaboard:\n  id_tokens:\n    QABOARD_ID_TOKEN:\n      aud: ${policy.audience}`,
    hint: <>If several service accounts trust this job, choose this one with a <code>QABOARD_SERVICE_ACCOUNT: {account.user_name}</code> variable.</>,
  };
  return {
    title: "In the job that runs qa: the CI's ID token",
    code: `QABOARD_ID_TOKEN=<an ID token for the audience ${policy.audience}>`,
  };
};


const AddCiTrustDialog = ({ account, isOpen, onClose }) => {
  const queryClient = useQueryClient();
  const [preset, setPreset] = useState('github');
  const [issuer, setIssuer] = useState('');
  const [repository, setRepository] = useState('');
  const [ref, setRef] = useState('');
  const [environment, setEnvironment] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const chosen = presets[preset];
  const valid = !!repository.trim() && (!chosen.ask_issuer || /^https:\/\/\S+$/.test(issuer.trim()));

  const close = () => {
    setPreset('github');
    setIssuer('');
    setRepository('');
    setRef('');
    setEnvironment('');
    setError(null);
    onClose();
  };
  const submit = event => {
    event.preventDefault();
    if (!valid) return;
    setSaving(true);
    setError(null);
    const policy = {
      provider: chosen.provider,
      ...(chosen.issuer || chosen.ask_issuer ? { issuer: chosen.issuer ?? issuer.trim() } : {}),
      repository: repository.trim(),
      ...(ref.trim() ? { ref: ref.trim() } : {}),
      ...(environment.trim() ? { environment: environment.trim() } : {}),
    };
    addCiTrust(queryClient, account, policy)
      .then(() => {
        toaster.show({ message: `${account.user_name} trusts these CI jobs`, intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 });
        close();
      })
      .catch(error => setError(errorMessage(error)))
      .finally(() => setSaving(false));
  };

  return <Dialog isOpen={isOpen} onClose={close} title={`Trust CI jobs as ${account.user_name}`} icon="endorsed" style={{ width: 560, maxWidth: 'calc(100vw - 32px)' }}>
    <form onSubmit={submit}>
      <DialogBody>
        {error && <Callout intent={Intent.DANGER} role="alert" compact style={{ marginBottom: 16 }}>{error}</Callout>}
        <FormGroup label="CI" labelFor="ci-trust-preset">
          <HTMLSelect id="ci-trust-preset" value={preset} onChange={e => setPreset(e.target.value)} options={Object.entries(presets).map(([value, { label }]) => ({ value, label }))}/>
        </FormGroup>
        {chosen.ask_issuer && <FormGroup label={chosen.ask_issuer} labelFor="ci-trust-issuer">
          <InputGroup id="ci-trust-issuer" value={issuer} onChange={e => setIssuer(e.target.value)} placeholder={chosen.issuer_placeholder}/>
        </FormGroup>}
        <FormGroup
          label={chosen.repository}
          labelFor="ci-trust-repository"
          helperText={chosen.provider === 'other' ? "A pattern on the token's sub claim, starting with literal text." : <>Its jobs act as <strong>{account.user_name}</strong>. <code>camera-algo/*</code> trusts all the group's repositories.</>}
        >
          <InputGroup id="ci-trust-repository" value={repository} onChange={e => setRepository(e.target.value)} placeholder={chosen.placeholder} autoFocus/>
        </FormGroup>
        <FormGroup
          label="Branch" labelInfo="(optional)" labelFor="ci-trust-ref"
          helperText={chosen.provider === 'github' ? <>e.g. <code>main</code> or <code>release/*</code>, or a full ref like <code>refs/tags/v*</code>. Empty: any branch, tag or pull request.</> : <>e.g. <code>main</code> or <code>release/*</code>. Empty: any branch or tag.</>}
        >
          <InputGroup id="ci-trust-ref" value={ref} onChange={e => setRef(e.target.value)}/>
        </FormGroup>
        <FormGroup label="Environment" labelInfo="(optional)" labelFor="ci-trust-environment" helperText="Only jobs that deploy to this environment, whose protection rules you set in the CI.">
          <InputGroup id="ci-trust-environment" value={environment} onChange={e => setEnvironment(e.target.value)}/>
        </FormGroup>
      </DialogBody>
      <DialogFooter actions={<>
        <Button text="Cancel" onClick={close}/>
        <Button type="submit" intent={Intent.PRIMARY} text="Trust these jobs" loading={saving} disabled={!valid}/>
      </>}/>
    </form>
  </Dialog>;
};


// `account`: the service account, with its `ci_trust`
export const CiTrust = ({ account }) => {
  const queryClient = useQueryClient();
  const { tokens } = useSiteConfig();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(null);
  const policies = account.ci_trust ?? [];
  const hours = Math.round((tokens?.ci_lifetime_minutes ?? 360) / 6) / 10;
  const remove = policy => {
    setBusy(policy.id);
    removeCiTrust(queryClient, account, policy.id)
      .catch(error => toaster.show({ message: errorMessage(error), intent: Intent.DANGER, timeout: 8000 }))
      .finally(() => setBusy(null));
  };
  // one snippet per kind of CI
  const snippets = [...new Map(policies.map(policy => [`${policy.provider} ${policy.audience}`, policy])).values()];

  return <section aria-label="Trusted CI jobs" style={{ marginTop: 24 }}>
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 8 }}>
      <div>
        <h5 className={Classes.HEADING} style={{ margin: '0 0 4px' }}>Trusted CI jobs</h5>
        <p className={Classes.TEXT_MUTED} style={{ margin: 0 }}>
          GitHub Actions or GitLab CI jobs that act as {account.user_name} without a stored secret: <code>qa</code> exchanges
          their ID token for a token that works {hours} hours.
        </p>
      </div>
      <Button icon="plus" text="Trust CI jobs" onClick={() => setAdding(true)}/>
    </div>
    {policies.length > 0 && <div style={{ overflowX: 'auto' }}>
      <HTMLTable compact style={{ width: '100%' }} aria-label="Trusted CI jobs">
        <thead>
          <tr><th>CI</th><th>Repository</th><th>Only</th><th>Last used</th><th><span className={Classes.TEXT_MUTED} style={{ fontWeight: 'normal' }}>Actions</span></th></tr>
        </thead>
        <tbody>
          {policies.map(policy => {
            const repository_claim = repository_claims[policy.provider] ?? 'sub';
            const others = Object.entries(policy.conditions ?? {}).filter(([claim]) => claim !== repository_claim);
            return <tr key={policy.id} data-testid={`ci-trust-${policy.id}`}>
              <td>{ciName(policy)}</td>
              <td><code style={{ overflowWrap: 'anywhere' }}>{(policy.conditions?.[repository_claim] ?? []).join(', ')}</code></td>
              <td>
                {others.length === 0
                  ? <span className={Classes.TEXT_MUTED}>any branch</span>
                  : others.map(([claim, patterns]) => <Tag key={claim} minimal style={{ marginRight: 4 }}>{claim}: {patterns.join(', ')}</Tag>)}
              </td>
              <td><Time iso={policy.last_used_at} never="Never used"/></td>
              <td>
                <Button
                  size="small" variant="minimal" icon="trash" intent={Intent.DANGER} loading={busy === policy.id}
                  aria-label={`Stop trusting ${ciName(policy)} jobs of ${(policy.conditions?.[repository_claim] ?? []).join(', ')}`}
                  onClick={() => remove(policy)}
                />
              </td>
            </tr>;
          })}
        </tbody>
      </HTMLTable>
    </div>}
    {snippets.map(policy => {
      const snippet = ciSnippet(policy, account);
      return <div key={`${policy.provider} ${policy.audience}`} style={{ marginTop: 12 }}>
        <Snippet what="the CI configuration" title={snippet.title} code={snippet.code}/>
        {snippet.hint && <p className={Classes.TEXT_MUTED} style={{ fontSize: 12, marginTop: -6 }}>{snippet.hint}</p>}
      </div>;
    })}
    <AddCiTrustDialog account={account} isOpen={adding} onClose={() => setAdding(false)}/>
  </section>;
};

export default CiTrust;
