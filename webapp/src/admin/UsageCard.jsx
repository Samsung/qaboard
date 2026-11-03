// A user's usage of QA-Board over the last 30 days: on their admin page, and in their own Settings → Activity.
// The data is GET /api/v1/admin/usage/users/<id>, or /api/v1/user/usage (docs/design/usage-analytics.md).
import { useQuery } from "@tanstack/react-query";
import { Card, Classes, HTMLTable } from "@blueprintjs/core";
import styled from "styled-components";

import { Link } from "../router";
import { Time } from "../settings/format";
import { Loading, QueryError } from "../settings/states";
import { formatNumber } from "../activity/format";
import { project_url } from "../selection";


const Facts = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px 28px;
  margin-bottom: 12px;
  .fact { font-size: 22px; font-weight: 600; line-height: 1.2; }
`;

// What the events are called for people
export const event_labels = {
  page_view: 'Pages viewed',
  commit_compare: 'Comparisons',
  output_open: 'Outputs opened',
  image_viewer_use: 'Image viewer features',
  batch_start: 'Batches started',
  batch_stop: 'Batches stopped',
  batch_delete: 'Batches deleted',
  export_start: 'Exports',
  milestone_save: 'Milestones saved',
  cli_command: 'qa commands',
  command_palette_open: 'Command palette',
  command_palette_select: 'Command palette picks',
  release_notes_open: 'Release notes',
  release_notes_popup: 'Release notes popups',
};
export const eventLabel = event => event_labels[event] ?? event;

const Top = ({ title, rows, label, link }) => rows.length === 0 ? null : <div style={{ minWidth: 200, flex: '1 1 200px' }}>
  <h5 className={Classes.HEADING} style={{ marginBottom: 4 }}>{title}</h5>
  <HTMLTable compact style={{ width: '100%' }} aria-label={title}>
    <tbody>
      {rows.slice(0, 5).map(row => <tr key={row.key}>
        <td>{link ? <Link to={link(row.key)}>{label(row.key)}</Link> : label(row.key)}</td>
        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatNumber(row.count)}</td>
      </tr>)}
    </tbody>
  </HTMLTable>
</div>;

// `query`: the query of the data. `note`: a sentence under the title, e.g. who else sees these numbers
export const UsageCard = ({ query, title = 'Usage, last 30 days', note, what = 'their usage' }) => {
  const { data, isPending, error, refetch } = useQuery(query);
  return <Card compact role="region" style={{ marginBottom: 20 }} aria-label={title}>
    <h4 className={Classes.HEADING} style={{ marginBottom: note ? 4 : 12 }}>{title}</h4>
    {note && <p className={Classes.TEXT_MUTED} style={{ marginBottom: 12 }}>{note}</p>}
    {isPending && <Loading label={`Loading ${what}`}/>}
    {error && <QueryError error={error} refetch={refetch} what={what}/>}
    {data && (data.total === 0
      ? <p className={Classes.TEXT_MUTED} style={{ margin: 0 }}>Nothing in the last 30 days.</p>
      : <>
        <Facts>
          <div><div className="fact">{formatNumber(data.active_days)}</div><div className={Classes.TEXT_MUTED}>active day{data.active_days === 1 ? '' : 's'}</div></div>
          <div><div className="fact">{formatNumber(data.total)}</div><div className={Classes.TEXT_MUTED}>events</div></div>
          <div><div className="fact" style={{ fontSize: 16, paddingTop: 4 }}><Time iso={data.last_seen_at}/></div><div className={Classes.TEXT_MUTED}>last seen</div></div>
        </Facts>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
          <Top title="What" rows={(data.by_event ?? []).map(r => ({ key: r.event, count: r.count }))} label={eventLabel}/>
          <Top title="Where" rows={(data.by_project ?? []).filter(r => r.project_id).map(r => ({ key: r.project_id, count: r.count }))} label={id => id} link={project_url}/>
        </div>
      </>)}
  </Card>;
};

export default UsageCard;
