import { lazy } from "react";
import { project_routes, app_paths } from "./route_paths";
import { matchRoutes } from "./router";
// the landing page: not loaded on demand
import ExplorePage from "./explore/ExplorePage";

// Pages are loaded on demand: each pulls heavy dependencies (plotly, monaco...)
const CiCommitList = lazy(() => import("./CiCommitList"));
const CiCommitResults = lazy(() => import("./CiCommitResults"));
const Dashboard = lazy(() => import("./Dashboard"));
const MilestonePage = lazy(() => import("./milestones/MilestonePage"));
const AccessPage = lazy(() => import("./access/AccessPage"));
const GatePage = lazy(() => import("./projectAdmin/GatePage"));
const SettingsPage = lazy(() => import("./settings/SettingsPage"));
const AdminPage = lazy(() => import("./admin/AdminPage"));
const StoragePage = lazy(() => import("./storage/StoragePage"));
const ActivityPage = lazy(() => import("./activity/ActivityPage"));
const DevicePage = lazy(() => import("./device/DevicePage"));
const LoginPage = lazy(() => import("./login/LoginPage"));
const SetupPage = lazy(() => import("./login/SetupPage"));

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
  project_admin: GatePage,
  access: AccessPage,
  project: CiCommitList,
};

// Project pages, in matching order: the first match wins
export const routes = project_routes.map(route => ({ ...route, main: pages[route.name] }));

const app_pages = {
  settings: SettingsPage,
  admin_user: AdminPage,
  admin_group: AdminPage,
  admin_job: AdminPage,
  admin_scan: AdminPage,
  admin: AdminPage,
  storage: StoragePage,
  activity: ActivityPage,
  device: DevicePage,
  login: LoginPage,
  setup: SetupPage,
  explore: ExplorePage,
};
export const app_routes = Object.entries(app_paths).map(([name, path]) => ({ name, path, exact: true, main: app_pages[name] }));

// The app's own pages (settings, admin...), else null for the projects' pages
export const matchAppRoute = pathname => matchRoutes(app_routes, pathname);
