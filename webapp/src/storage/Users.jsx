// Storage usage > Users: who uses the most storage, with the filters (project, folder, branch...), and looking at someone's runs.
// Admins then delete them: users only see them.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Classes, HTMLTable, InputGroup, NonIdealState, Tag, Tooltip } from "@blueprintjs/core";

import { Link } from "../router";
import { Avatar } from "../components/avatars";
import { Time } from "../settings/format";
import { Loading, QueryError } from "../settings/states";
import { usersQuery } from "./api";
import { formatBytes, formatNumber, plural, SizeBar, Ellipsis } from "./format";


const medals = ['#d99e0b', '#a7b6c2', '#c87619'];

export const UsersView = ({ me, filters, storageUrl, openUser }) => {
  const [search, setSearch] = useState('');
  const { data, isPending, error, refetch, isFetching } = useQuery(usersQuery(filters));
  if (isPending) return <Loading label="Loading who uses the most"/>;
  if (error) return <QueryError error={error} refetch={refetch} what="who uses the most"/>;
  if (data.can_see_others === 'none') return <NonIdealState icon="lock" title="Only your own usage"
    description="Admins, and a project's developers and owners, see who uses the most storage in their projects."/>;
  const users = data.users.map((user, index) => ({ ...user, rank: index + 1 }));
  if (users.length === 0) return <NonIdealState icon="people" title="Nobody's runs take storage here" description="No runs match the filters."/>;
  const max = users[0].bytes;
  const total = data.totals.bytes;
  const shown = search ? users.filter(u => (u.user_name || 'unknown').toLowerCase().includes(search.toLowerCase())) : users;
  const runsOf = user => storageUrl('batches', { ...filters, scope: 'user', user: user.user_name, page: '' });
  return <>
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 12 }}>
      <InputGroup leftIcon="search" placeholder="Find someone" aria-label="Find someone" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 220 }}/>
      <span className={Classes.TEXT_MUTED}>
        {plural(data.total, 'person', 'people')} use {formatBytes(total)}{filters.project ? ` in ${filters.project}` : data.can_see_others === 'some' ? ' in the projects where you are a developer or an owner' : ''}.
        {' '}{me.is_admin ? "Open someone's runs to delete them." : "Open someone's runs to see them: they, or an admin, delete them."}
      </span>
    </div>
    <div style={{ overflowX: 'auto', opacity: isFetching ? 0.7 : 1 }}>
      <HTMLTable compact interactive style={{ width: '100%' }} aria-label="Users">
        <thead><tr><th style={{ width: 36 }}>#</th><th>User</th><th>Size</th><th>Share</th><th>Runs</th><th>Batches</th><th>Biggest project</th><th>Latest run</th><th aria-label="Actions"/></tr></thead>
        <tbody>
          {shown.map(user => {
            const name = user.user_name || 'unknown';
            const is_me = user.user_name === data.me;
            const selected = filters.scope === 'user' && filters.user === user.user_name;
            return <tr key={user.user_name} data-testid="storage-user" onClick={event => { if (!event.target.closest('a, button')) openUser(user); }}
              style={{ cursor: 'pointer', ...(selected ? { background: 'rgba(45, 114, 210, 0.15)' } : {}) }}>
              <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: medals[user.rank - 1] }}>{user.rank}</td>
              <td style={{ minWidth: 180 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <Avatar name={name} size="24px"/>
                  <Link to={runsOf(user)}><strong>{name}</strong></Link>
                  {is_me && <Tag minimal round>you</Tag>}
                </span>
              </td>
              <td><SizeBar bytes={user.bytes} max={max}/></td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{total ? `${(100 * user.bytes / total).toFixed(user.bytes / total < 0.1 ? 1 : 0)}%` : '—'}</td>
              <td>{formatNumber(user.runs)}</td>
              <td>{formatNumber(user.batches)}</td>
              <td style={{ maxWidth: 280 }}>
                {user.top_project?.project_id && <>
                  <Ellipsis title={user.top_project.project_id} style={{ direction: 'rtl', textAlign: 'left' }}>
                    &lrm;<Link to={storageUrl('batches', { ...filters, scope: 'user', user: user.user_name, project: user.top_project.project_id, page: '' })}>{user.top_project.project_id}</Link>&lrm;
                  </Ellipsis>
                  <div className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>
                    {formatBytes(user.top_project.bytes)}{user.projects > 1 ? ` · ${plural(user.projects, 'project')} in all` : ''}
                  </div>
                </>}
              </td>
              <td><Time iso={user.last_run_at}/></td>
              <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                <Tooltip content={`${name}'s biggest batches${me.is_admin ? ', to delete them' : ''}`} hoverOpenDelay={300}>
                  <Button size="small" variant="minimal" endIcon="arrow-right" text="Their runs" onClick={() => openUser(user)}/>
                </Tooltip>
              </td>
            </tr>;
          })}
        </tbody>
      </HTMLTable>
    </div>
    {data.total > users.length && <p className={Classes.TEXT_MUTED} style={{ marginTop: 8 }}>The {formatNumber(users.length)} who use the most, of {formatNumber(data.total)}.</p>}
  </>;
};
