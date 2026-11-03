// Page views, for QA-Board's usage analytics: which pages and projects people look at, and which commits.
// One event per page (the route and its parameters: a commit, a branch, an admin section, a settings tab), not
// per query-string change (selecting a batch or a filter isn't a new page), and never the same page twice in a row.
import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { useQueryClient } from "@tanstack/react-query";

import { track } from "./analytics";
import { matchRoutes } from "./router";
import { routes, matchAppRoute } from "./routes";
import { parse_query } from "./selection";
import { userQuery } from "./api/queries";


const decode = value => {
  if (value === undefined || value === null) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const first = value => Array.isArray(value) ? value[0] : typeof value === 'object' && value !== null ? Object.values(value)[0] : value;

// What a location is, for the event: {route, project_id, commit_id, batch_label, has_reference, view}, and `key`:
// what makes it another page. `signed_in`: who sees / (their home page, or Explore), when we know.
export const page_view_of = (pathname, search = '', { signed_in } = {}) => {
  const query = parse_query(search);
  if (pathname === '/') return { route: signed_in === false ? 'explore' : 'home', has_reference: false, key: '/' };
  const matched = matchAppRoute(pathname) ?? matchRoutes(routes, pathname);
  if (!matched) return { route: 'not_found', has_reference: false, key: 'not_found' };
  const { route, match } = matched;
  const params = match.params ?? {};
  const view = {
    route: route.name ?? route.path,
    project_id: decode(params.project_id),
    // commit_ref_folder: how older links named the reference
    has_reference: !!(query.reference || query.commit_ref_folder),
  };
  if (['commit', 'latest_commit'].includes(route.name)) {
    view.commit_id = decode(params.name) || undefined;
    const batch = first(query.batch);
    if (batch) view.batch_label = String(batch);
    const tab = first(query.selected_views);
    if (tab) view.view = String(tab);
  }
  view.key = [view.route, ...Object.values(params).map(value => value ?? '')].join('|');
  return view;
};

export const usePageViews = () => {
  const { pathname, search } = useLocation();
  const queryClient = useQueryClient();
  const last = useRef(null);
  useEffect(() => {
    const user = queryClient.getQueryData(userQuery.queryKey);
    const { project_id, key, ...properties } = page_view_of(pathname, search, { signed_in: user ? !!user.is_logged : undefined });
    if (last.current === key) return;
    last.current = key;
    track('page_view', properties, { project_id });
    // the search isn't a dependency: only a new path is a new page
    // oxlint-disable-next-line react/exhaustive-deps
  }, [pathname]);
};

// Drop-in for App.jsx, inside the router
export const PageViews = () => {
  usePageViews();
  return null;
};
