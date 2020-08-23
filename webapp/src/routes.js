import AppNavbar from "./AppNavbar";
import AppSider from "./AppSider";
import CiCommitList from "./CiCommitList";
import CiCommitResults from "./CiCommitResults";
import Dashboard from "./Dashboard";


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
