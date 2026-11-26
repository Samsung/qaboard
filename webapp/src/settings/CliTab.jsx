// Settings → CLI sign-ins: the computers where `qa auth login` saved a token
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Classes, NonIdealState } from "@blueprintjs/core";

import { copyWithToast } from "../utils/clipboard";
import { QueryError, Loading } from "./states";
import { tokensQuery, revokeToken } from "./api";
import { TokensTable } from "./tokens";
import { CodeBlock } from "../components/CodeBlock";


const LoginInstructions = () => <div style={{ marginBottom: 20, maxWidth: 680 }}>
  <p>
    To use <code>qa</code> as you on a computer, run this there. It shows a code to approve here, in the web app,
    then saves a token for this server. It works over SSH too.
  </p>
  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
    <CodeBlock language="shell" code="qa auth login" style={{ margin: 0, flex: 1 }}/>
    <Button icon="duplicate" variant="minimal" aria-label="Copy the command" onClick={() => copyWithToast('qa auth login', { what: 'the command' })}/>
  </div>
  <p className={Classes.TEXT_MUTED} style={{ marginTop: 8 }}>
    CLI sign-ins can read, save and act on runs. They expire after months without use. Revoke the ones you don't use anymore.
  </p>
</div>;


export const CliTab = () => {
  const queryClient = useQueryClient();
  const { data: tokens, isPending, error, refetch } = useQuery(tokensQuery);
  const cli_tokens = (tokens ?? []).filter(token => token.kind === 'cli' && (token.status ?? 'active') === 'active');
  return <section aria-label="CLI sign-ins">
    <LoginInstructions/>
    {isPending && <Loading label="Loading your CLI sign-ins"/>}
    {error && <QueryError error={error} refetch={refetch} what="your CLI sign-ins"/>}
    {!isPending && !error && (cli_tokens.length === 0
      ? <NonIdealState icon="console" title="No CLI sign-ins yet" description={<>Computers where you run <code>qa auth login</code> show up here.</>}/>
      : <TokensTable kind="cli" tokens={cli_tokens} onRevoke={token => revokeToken(queryClient, token.id)}/>)}
  </section>;
};

export default CliTab;
