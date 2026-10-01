// URL patterns must keep react-router@5 semantics: our routes and projects' configurations rely on them.
import { matchPath, matchRoutes } from '../router';

const routes = [
  { path: "/:project_id+/commits/:name+" },
  { path: "/:project_id+/commits" },
  { path: "/:project_id+/commit/:name+" },
  { path: "/:project_id+" },
];

describe('matchRoutes', () => {
  test('project ids can contain slashes', () => {
    const { route, match } = matchRoutes(routes, "/group/repo/sub/commit/abc123");
    expect(route.path).toBe("/:project_id+/commit/:name+");
    expect(match.params).toEqual({ project_id: "group/repo/sub", name: "abc123" });
  });

  test('branch names can contain slashes', () => {
    const { match } = matchRoutes(routes, "/group/repo/commits/feature/x");
    expect(match.params).toEqual({ project_id: "group/repo", name: "feature/x" });
  });

  test('falls back to the project page', () => {
    const { route, match } = matchRoutes(routes, "/group/repo");
    expect(route.path).toBe("/:project_id+");
    expect(match.params.project_id).toBe("group/repo");
  });
});

describe('matchPath', () => {
  test('path-to-regexp@1 patterns used in qaboard.yaml', () => {
    expect(matchPath("frame_12/output.jpg", { path: ":frame/output.jpg" }).params).toEqual({ frame: "frame_12" });
    expect(matchPath("a/b/debug.jpg", { path: "(.*)/debug.jpg" }).params).toEqual({ 0: "a/b" });
    expect(matchPath("x/y.png", { path: "*.png" }).params).toEqual({ 0: "x/y" });
    expect(matchPath("other.jpg", { path: ":frame/output.jpg" })).toBeNull();
  });

  test('exact', () => {
    expect(matchPath("/a/b", { path: "/a", exact: true })).toBeNull();
    expect(matchPath("/a/b", { path: "/a" }).isExact).toBe(false);
  });
});
