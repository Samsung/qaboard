// The user's tokens and activity (design/user-management.md, Appendix A.3 and A.6).
// Writes go through http directly, then refresh the queries, like elsewhere in the app.
import { queryOptions, infiniteQueryOptions } from "@tanstack/react-query";

import { http } from "../api/http";
import { parseDate } from "./format";


export const tokensQuery = queryOptions({
  queryKey: ['tokens', 'mine'],
  queryFn: async ({ signal }) => (await http.get('/api/v1/user/tokens', { signal })).data?.tokens ?? [],
  staleTime: 30 * 1000,
});

// {name, scopes, projects, expires_in_days: number or null (no expiry)} => the token, with its secret in `token`
export const createToken = async (queryClient, token) => {
  const { data } = await http.post('/api/v1/user/tokens', token);
  queryClient.invalidateQueries({ queryKey: ['tokens'] });
  return data;
};

export const revokeToken = async (queryClient, id) => {
  const { data } = await http.delete(`/api/v1/user/tokens/${id}`);
  queryClient.invalidateQueries({ queryKey: ['tokens'] });
  queryClient.invalidateQueries({ queryKey: ['audit'] });
  return data;
};


// Pages of audit events, newest first. Pages are {events, next_before_id}.
export const audit_page_size = 50;
export const userAuditQuery = infiniteQueryOptions({
  queryKey: ['audit', 'mine'],
  queryFn: async ({ signal, pageParam }) => {
    const { data } = await http.get('/api/v1/user/audit', { params: { before_id: pageParam, limit: audit_page_size }, signal });
    return { events: data?.events ?? [], next_before_id: data?.next_before_id ?? null };
  },
  initialPageParam: undefined,
  getNextPageParam: last_page => last_page.next_before_id ?? undefined,
  staleTime: 30 * 1000,
});


// The token's state, from the server's `status`, with what users need to act on
export const days_until = iso => {
  const date = parseDate(iso);
  return date?.isValid ? date.diffNow('days').days : null;
};
export const is_active = token => (token.status ?? 'active') === 'active';
export const expires_soon = token => {
  const days = days_until(token.expires_at);
  return is_active(token) && days !== null && days < 7;
};
