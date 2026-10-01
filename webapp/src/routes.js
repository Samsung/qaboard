import { lazy } from "react";
import AppNavbar from "./AppNavbar";
import AppSider from "./AppSider";

// Pages are loaded on demand: each pulls heavy dependencies (plotly, monaco...)
const CiCommitList = lazy(() => import("./CiCommitList"));
const CiCommitResults = lazy(() => import("./CiCommitResults"));
const Dashboard = lazy(() => import("./Dashboard"));


export const routes = [
  {
    path: "/:project_id+/committer/:committer+",
    main: CiCommitList,
    sider: AppSider,
    navbar: AppNavbar,
  },
  {
    path: "/:project_id+/commits/:name+",
    main: CiCommitList,
    sider: AppSider,
    navbar: AppNavbar,
  },
  {
    path: "/:project_id+/commits",
    main: CiCommitList,
    sider: AppSider,
    navbar: AppNavbar,
  },
  {
    path: "/:project_id+/commit/:name+",
    main: CiCommitResults,
    sider: AppSider,
    navbar: AppNavbar,
  },
  {
    path: "/:project_id+/commit",
    main: CiCommitResults,
    sider: AppSider,
    navbar: AppNavbar,
  },
  {
    path: "/:project_id+/dashboard/:name+",
    main: Dashboard,
    sider: AppSider,
    navbar: AppNavbar,
  },
  {
    path: "/:project_id+/dashboard",
    main: Dashboard,
    sider: AppSider,
    navbar: AppNavbar,
  },
  {
    path: "/:project_id+/history/:name+",
    main: Dashboard,
    sider: AppSider,
    navbar: AppNavbar,
  },
  {
    path: "/:project_id+/history",
    main: Dashboard,
    sider: AppSider,
    navbar: AppNavbar,
  },
  {
    path: "/:project_id+",
    main: CiCommitList,
    sider: AppSider,
    navbar: AppNavbar,
  },
];
