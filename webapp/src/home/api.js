// What the home page shows, from /api/v1/batches (backend/backend/api/api.py get_batches): the user's batches that
// run, that failed, that ended, and other people's in the user's projects.
import { queryOptions } from "@tanstack/react-query";

import { http } from "../api/http";


// While something runs, we refresh like the runs activity page
export const refresh_interval = 15 * 1000;
export const attention_days = 7;
// Every request is bounded by dates: the server walks indexes on batches' latest run (by user, or all of them),
// never all the outputs. Runs pending for longer are stuck: the runs activity page finds them.
const running_days = 14;
const others_days = 30;

const batches = async (params, signal) => {
  const { data } = await http.get('/api/v1/batches', { params, signal, background: true });
  // servers that don't know this endpoint answer with something else
  return Array.isArray(data) ? data : [];
};

// Under ['batches']: what invalidates batches (after a redo, a deletion...) refreshes them too.
// Servers that don't know some filters ignore them: the page filters again (logic.js).
// `viewer`: whose batches they are, in the keys so that another account never sees them while they refresh.
// While nothing runs, we still check now and then for batches users start elsewhere.
export const idle_refresh_interval = 60 * 1000;
export const runningQuery = viewer => queryOptions({
  queryKey: ['batches', 'home', 'running', viewer],
  queryFn: ({ signal }) => batches({ scope: 'mine', status: 'pending', since_days: running_days, limit: 20 }, signal),
  staleTime: 5 * 1000,
  refetchInterval: query => query.state.data?.some(b => b.pending_outputs > 0) ? refresh_interval : idle_refresh_interval,
});

export const failedQuery = viewer => queryOptions({
  queryKey: ['batches', 'home', 'failed', viewer],
  queryFn: ({ signal }) => batches({ scope: 'mine', status: 'failed', since_days: attention_days, limit: 30 }, signal),
  staleTime: 30 * 1000,
});

export const recent_size = 8;
export const recentQuery = viewer => queryOptions({
  queryKey: ['batches', 'home', 'recent', viewer],
  // a few more: those still running are in "Running now"
  queryFn: ({ signal }) => batches({ scope: 'mine', metrics: 'default', limit: recent_size + 6 }, signal),
  staleTime: 30 * 1000,
});

// Teammates' batches from the web app or their terminal, in the user's projects (not the CI's)
export const othersQuery = (projects, viewer) => queryOptions({
  queryKey: ['batches', 'home', 'others', viewer, projects],
  queryFn: ({ signal }) => batches({ projects: projects.join(','), scope: 'others', origin: 'webapp,local', since_days: others_days, limit: 10 }, signal),
  enabled: projects.length > 0,
  staleTime: 60 * 1000,
});
