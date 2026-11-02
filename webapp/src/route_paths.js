// URL patterns of project pages, first match wins. Project ids and branches can contain slashes.
// src/routes.js says which components render them.
export const route_paths = {
  committer: "/:project_id+/committer/:committer+",
  branch: "/:project_id+/commits/:name+",
  commits: "/:project_id+/commits",
  commit: "/:project_id+/commit/:name+",
  latest_commit: "/:project_id+/commit",
  dashboard_branch: "/:project_id+/dashboard/:name+",
  dashboard: "/:project_id+/dashboard",
  history_branch: "/:project_id+/history/:name+",
  history: "/:project_id+/history",
  // links to milestones: /<project>/milestone/<id>-<label>
  milestone: "/:project_id+/milestone/:name+",
  // who can see and change the project
  access: "/:project_id+/access",
  project: "/:project_id+",
};

// Pages of the app itself, matched before the projects' pages, exactly: they don't take over projects that would
// have the same name, e.g. /admin/commits stays the commits of a project named "admin".
export const app_paths = {
  settings: "/settings/:tab(profile|preferences|sign-in|sessions|tokens|cli|activity)?",
  admin_user: "/admin/users/:user_id(\\d+)",
  // group ids: whatever the server uses
  admin_group: "/admin/groups/:group_id",
  admin_job: "/admin/storage/jobs/:job_id(\\d+)",
  admin_scan: "/admin/storage/scans/:scan_id(\\d+)",
  // how much storage runs use, and deleting their files
  storage: "/storage/:view(projects|users|batches|commits|branches|folders|exports|untracked)?",
  // what waits and runs now, and what ran recently
  activity: "/activity",
  // the tabs of admin/AdminPage.jsx, its tests check they all have their URL
  admin: "/admin/:section(overview|users|groups|requests|sign-in|tokens|service-accounts|storage|audit|settings)?",
  // the ways to sign in, ?next=<page> to go back to it (see login/LoginPage.jsx)
  login: "/login",
  // where `qa auth login` sends users to approve the login
  device: "/device",
  // every project, as a tree (also at / for signed-out visitors, signed-in users get their home page there)
  explore: "/projects",
};
