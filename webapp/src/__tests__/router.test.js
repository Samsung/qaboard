// URL patterns must keep react-router@5 semantics: our routes and projects' configurations rely on them.
import { matchPath, matchRoutes } from '../router';
import { matchAppRoute, routes as project_routes } from '../routes';

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


// The app's own pages come before the projects' pages, whose ids can be anything
describe('app routes', () => {
  test('settings, admin, device and login are not project pages', () => {
    expect(matchAppRoute('/settings').route.name).toBe('settings');
    expect(matchAppRoute('/settings/').route.name).toBe('settings');
    expect(matchAppRoute('/settings/tokens').match.params.tab).toBe('tokens');
    expect(matchAppRoute('/admin').route.name).toBe('admin');
    expect(matchAppRoute('/admin/audit').match.params.section).toBe('audit');
    expect(matchAppRoute('/admin/users/12')).toMatchObject({ route: { name: 'admin_user' }, match: { params: { user_id: '12' } } });
    expect(matchAppRoute('/device').route.name).toBe('device');
    expect(matchAppRoute('/login').route.name).toBe('login');
    expect(matchAppRoute('/settings/sign-in').match.params.tab).toBe('sign-in');
    expect(matchAppRoute('/settings/sessions').match.params.tab).toBe('sessions');
    expect(matchAppRoute('/admin/sign-in').match.params.section).toBe('sign-in');
    expect(matchAppRoute('/admin/requests').match.params.section).toBe('requests');
    // without the app's routes, they would be projects
    expect(matchRoutes(project_routes, '/settings').match.params.project_id).toBe('settings');
  });

  test("projects keep their pages, even when their name starts the same", () => {
    for (const pathname of ['/', '/group/repo', '/group/settings', '/admin/commits', '/settings/x', '/device/commits', '/settings/tokens/commits', '/admin/users/alice', '/login/commits'])
      expect(matchAppRoute(pathname)?.route.name ?? null).toBeNull();
    expect(matchRoutes(project_routes, '/admin/commits').match.params.project_id).toBe('admin');
  });
});
