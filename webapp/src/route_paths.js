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
  project: "/:project_id+",
};
