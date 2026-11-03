// Page views, for QA-Board's usage analytics: which pages and projects people look at, and which commits.
// One event per path (not per query-string change: selecting a batch or a filter isn't a new page), and never the
// same page twice in a row.
import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

import { track } from "./analytics";
import { matchRoutes } from "./router";
import { routes, matchAppRoute } from "./routes";
import { parse_query } from "./selection";


const decode = value => {
  if (value === undefined || value === null) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const first = value => Array.isArray(value) ? value[0] : typeof value === 'object' && value !== null ? Object.values(value)[0] : value;

// What a location is, for the event: {route, project_id, commit_id, batch_label, has_reference, view}
export const page_view_of = (pathname, search = '') => {
  const query = parse_query(search);
  if (pathname === '/') return { route: 'home', has_reference: false };
  const matched = matchAppRoute(pathname) ?? matchRoutes(routes, pathname);
  if (!matched) return { route: 'not_found', has_reference: false };
  const { route, match } = matched;
  const params = match.params ?? {};
  const view = {
    route: route.name ?? route.path,
    project_id: decode(params.project_id),
    has_reference: !!query.reference,
  };
  if (['commit', 'latest_commit'].includes(route.name)) {
    view.commit_id = decode(params.name) || undefined;
    if (query.batch) view.batch_label = String(query.batch);
    const tab = first(query.selected_views);
    if (tab) view.view = String(tab);
  }
  return view;
};

export const usePageViews = () => {
  const { pathname, search } = useLocation();
  const last = useRef(null);
  useEffect(() => {
    const { project_id, ...properties } = page_view_of(pathname, search);
    const key = [properties.route, project_id, properties.commit_id].join('|');
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
