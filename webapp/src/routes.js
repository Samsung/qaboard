import { lazy } from "react";
import { route_paths, app_paths } from "./route_paths";
import { matchRoutes } from "./router";

// Pages are loaded on demand: each pulls heavy dependencies (plotly, monaco...)
const CiCommitList = lazy(() => import("./CiCommitList"));
const CiCommitResults = lazy(() => import("./CiCommitResults"));
const Dashboard = lazy(() => import("./Dashboard"));
const MilestonePage = lazy(() => import("./milestones/MilestonePage"));
const SettingsPage = lazy(() => import("./settings/SettingsPage"));
const AdminPage = lazy(() => import("./admin/AdminPage"));
const StoragePage = lazy(() => import("./storage/StoragePage"));
const DevicePage = lazy(() => import("./device/DevicePage"));
const LoginPage = lazy(() => import("./login/LoginPage"));

const pages = {
  committer: CiCommitList,
  branch: CiCommitList,
  commits: CiCommitList,
  commit: CiCommitResults,
  latest_commit: CiCommitResults,
  dashboard_branch: Dashboard,
  dashboard: Dashboard,
  history_branch: Dashboard,
  history: Dashboard,
  milestone: MilestonePage,
  project: CiCommitList,
};

// Project pages, in matching order: the first match wins
export const routes = Object.entries(route_paths).map(([name, path]) => ({ name, path, main: pages[name] }));

const app_pages = {
  settings: SettingsPage,
  admin_user: AdminPage,
  admin_job: AdminPage,
  admin: AdminPage,
  storage: StoragePage,
  device: DevicePage,
  login: LoginPage,
};
export const app_routes = Object.entries(app_paths).map(([name, path]) => ({ name, path, exact: true, main: app_pages[name] }));

// The app's own pages (settings, admin...), else null for the projects' pages
export const matchAppRoute = pathname => matchRoutes(app_routes, pathname);
