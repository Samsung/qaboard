// Who sent a run or a batch. `data.user` is who the CLI says it runs as (QA_USER, anyone can claim it), and
// `data.submitted_by` the user the server authenticated, from their token or session (design/user-management.md §11.2).
import { Classes, Icon, Intent, MenuItem, Tag, Tooltip } from "@blueprintjs/core";

import { useSiteConfig } from "../hooks";


export const submittedByText = ({ user_name, token_name, via } = {}) => {
  if (token_name) return `Sent by ${user_name} with token ${token_name}`;
  if (via === 'session') return `Sent by ${user_name}, signed in`;
  return `Sent by ${user_name}`;
};

// `data`: the run's or the batch's data. Shows its user, then whether it's verified.
export const SubmittedBy = ({ data, show_user = true }) => {
  const { ingest_auth } = useSiteConfig();
  const claimed = data?.user;
  const verified = data?.submitted_by?.user_name ? data.submitted_by : null;
  if (verified) {
    const differs = !!claimed && claimed !== verified.user_name;
    return <Tooltip content={submittedByText(verified)} hoverOpenDelay={200}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} data-testid="submitted-by">
        {show_user && <span>{claimed ?? verified.user_name}</span>}
        {differs && <span className={Classes.TEXT_MUTED}>via {verified.user_name}</span>}
        <Icon icon="endorsed" size={12} intent={Intent.SUCCESS} aria-label="verified"/>
      </span>
    </Tooltip>;
  }
  // Servers that accept anonymous runs say nothing about it
  const unverified = !!ingest_auth && ingest_auth !== 'off';
  if (!claimed && !unverified) return null;
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} data-testid="submitted-by">
    {show_user && claimed && <span>{claimed}</span>}
    {unverified && <Tooltip content="Sent without a token: QA-Board can't confirm who sent it. Run qa auth login to sign your runs." hoverOpenDelay={200}>
      <Tag minimal round className={Classes.TEXT_MUTED}>unverified</Tag>
    </Tooltip>}
  </span>;
};

// In the menus about runs
export const SubmittedByMenuItem = ({ data }) => {
  const { ingest_auth } = useSiteConfig();
  if (!data?.user && !data?.submitted_by && (!ingest_auth || ingest_auth === 'off')) return null;
  return <MenuItem text={<SubmittedBy data={data}/>} label="sent by" icon="user"/>;
};

export default SubmittedBy;
