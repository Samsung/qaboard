import { lazy } from "react";
import { route_paths } from "./route_paths";

// Pages are loaded on demand: each pulls heavy dependencies (plotly, monaco...)
const CiCommitList = lazy(() => import("./CiCommitList"));
const CiCommitResults = lazy(() => import("./CiCommitResults"));
const Dashboard = lazy(() => import("./Dashboard"));
const MilestonePage = lazy(() => import("./milestones/MilestonePage"));

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
