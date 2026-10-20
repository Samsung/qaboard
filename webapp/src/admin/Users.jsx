// Admin → Users: search, filters and pages. Filters are in the URL (?search=&status=&admin=true&offset=)
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Classes, HTMLSelect, HTMLTable, InputGroup, Intent, NonIdealState, Switch, Tag, Tooltip } from "@blueprintjs/core";
import { useLocation } from "react-router";

import { history, Link } from "../router";
import { Time, AdminTag, loginTypeLabel } from "../settings/format";
import { Loading } from "../settings/states";
import { AdminError } from "./states";
import { usersQuery, users_page_size } from "./api";


export const UserTags = ({ user }) => <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
  {user.status === 'disabled' && <Tag minimal intent={Intent.DANGER}>Disabled</Tag>}
  {user.status === 'pending' && <Tag minimal intent={Intent.WARNING}>Pending</Tag>}
  {user.is_admin && <Tooltip content={user.is_admin_from_env ? "Admin from the server's environment (QABOARD_ADMINS)" : "Admin"} hoverOpenDelay={300}>
    <AdminTag from_env={user.is_admin_from_env}/>
  </Tooltip>}
  {user.kind === 'service' && <Tag minimal icon="automatic-updates">Service</Tag>}
</span>;

const status_options = [
  { value: '', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'pending', label: 'Pending' },
  { value: 'disabled', label: 'Disabled' },
];

const readFilters = search => {
  const params = new URLSearchParams(search);
  return {
    search: params.get('search') ?? '',
    status: params.get('status') ?? '',
    admin: params.get('admin') === 'true',
    offset: Math.max(0, parseInt(params.get('offset') ?? '0', 10) || 0),
  };
};

const writeFilters = ({ search, status, admin, offset }) => {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (status) params.set('status', status);
  if (admin) params.set('admin', 'true');
  if (offset) params.set('offset', String(offset));
  const query = params.toString();
  history.replace(`/admin/users${query ? `?${query}` : ''}`);
};


export const Users = () => {
  const location = useLocation();
  const filters = readFilters(location.search);
  const setFilters = changes => writeFilters({ ...filters, offset: 0, ...changes });
  // the URL changes a moment after users stop typing
  const [search, setSearch] = useState(filters.search);
  const latest_filters = useRef(filters);
  useEffect(() => { latest_filters.current = filters; });
  useEffect(() => {
    if (search === latest_filters.current.search) return;
    const timer = setTimeout(() => writeFilters({ ...latest_filters.current, offset: 0, search }), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isPending, isFetching, error, refetch } = useQuery(usersQuery(filters));
  const users = data?.users ?? [];
  const total = data?.total ?? 0;
  const filtered = !!(filters.search || filters.status || filters.admin);

  return <section aria-label="Users">
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 16 }}>
      <InputGroup
        leftIcon="search"
        placeholder="Search names, user names, emails…"
        aria-label="Search users"
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ width: 300 }}
        rightElement={search ? <Button variant="minimal" icon="cross" aria-label="Clear the search" onClick={() => { setSearch(''); setFilters({ search: '' }); }}/> : undefined}
      />
      <HTMLSelect aria-label="Status" options={status_options} value={filters.status} onChange={e => setFilters({ status: e.target.value })}/>
      <Switch checked={filters.admin} onChange={() => setFilters({ admin: !filters.admin })} label="Admins only" style={{ marginBottom: 0 }}/>
      <span style={{ marginLeft: 'auto' }} className={Classes.TEXT_MUTED}>
        {!isPending && !error && `${total} user${total === 1 ? '' : 's'}`}
      </span>
    </div>

    {isPending && <Loading label="Loading users"/>}
    {error && <AdminError error={error} refetch={refetch} what="the users"/>}
    {!isPending && !error && (users.length === 0
      ? <NonIdealState
        icon={filtered ? 'search' : 'people'}
        title={filtered ? 'No matching users' : 'No users yet'}
        description={filtered ? 'Change the filters to see more users.' : 'Users appear here once they sign in.'}
        action={filtered ? <Button icon="cross" text="Clear the filters" onClick={() => { setSearch(''); writeFilters({}); }}/> : undefined}
      />
      : <>
        <div style={{ overflowX: 'auto', opacity: isFetching ? 0.7 : 1 }}>
          <HTMLTable compact interactive style={{ width: '100%' }} aria-label="Users">
            <thead>
              <tr>
                <th>User</th>
                <th>Email</th>
                <th>Sign-in</th>
                <th>Status</th>
                <th>Active tokens</th>
                <th>Last sign-in</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {users.map(user => <tr key={user.id} onClick={event => { if (!event.target.closest('a')) history.push(`/admin/users/${user.id}`); }} style={{ cursor: 'pointer' }}>
                <td>
                  <Link to={`/admin/users/${user.id}`}><strong>{user.full_name || user.user_name}</strong></Link>
                  {user.full_name && <div className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>{user.user_name}</div>}
                </td>
                <td>{user.email || <span className={Classes.TEXT_MUTED}>—</span>}</td>
                <td>{loginTypeLabel(user.login_type) ?? '—'}</td>
                <td><UserTags user={user}/></td>
                <td>{user.active_tokens ?? 0}</td>
                <td><Time iso={user.last_login_at}/></td>
                <td><Time iso={user.created_date}/></td>
              </tr>)}
            </tbody>
          </HTMLTable>
        </div>
        <Pager offset={filters.offset} page_size={users_page_size} shown={users.length} total={total} onChange={offset => writeFilters({ ...filters, offset })}/>
      </>)}
  </section>;
};


// "51–100 of 230", with Previous and Next
export const Pager = ({ offset, page_size, shown, total, onChange }) => {
  if (total <= page_size && offset === 0) return null;
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
    <span className={Classes.TEXT_MUTED}>{shown ? `${offset + 1}–${offset + shown}` : 0} of {total}</span>
    <Button icon="chevron-left" text="Previous" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - page_size))}/>
    <Button endIcon="chevron-right" text="Next" disabled={offset + shown >= total} onClick={() => onChange(offset + page_size)}/>
  </div>;
};

export default Users;
