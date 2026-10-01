// Routing helpers on top of react-router.
//
// QA-Board URLs look like /:project_id+/commit/:name+, where project ids can contain slashes.
// Since v6, react-router's patterns can't express that, so we keep matching URLs ourselves, with the same
// path-to-regexp@1 semantics react-router@5 had. It also matters because projects' configurations
// use those patterns (e.g. to match output files to visualizations).
//
// Class components get the props react-router@5's withRouter used to give them: {match, location, history}.
import { createContext, useContext } from "react";
import { useLocation } from "react-router";
import { createBrowserHistory } from "history";
import pathToRegexp from "path-to-regexp-v1";

export { Link } from "react-router";

export const history = createBrowserHistory();


// From react-router@5.3.4 (MIT), packages/react-router/modules/matchPath.js
const cache = {};
const cacheLimit = 10000;
let cacheCount = 0;

function compilePath(path, options) {
  const cacheKey = `${options.end}${options.strict}${options.sensitive}`;
  const pathCache = cache[cacheKey] || (cache[cacheKey] = {});
  if (pathCache[path]) return pathCache[path];

  const keys = [];
  const regexp = pathToRegexp(path, keys, options);
  const result = { regexp, keys };
  if (cacheCount < cacheLimit) {
    pathCache[path] = result;
    cacheCount++;
  }
  return result;
}

export function matchPath(pathname, options = {}) {
  if (typeof options === "string" || Array.isArray(options)) {
    options = { path: options };
  }
  const { path, exact = false, strict = false, sensitive = false } = options;
  const paths = [].concat(path);

  return paths.reduce((matched, path) => {
    if (!path && path !== "") return null;
    if (matched) return matched;

    const { regexp, keys } = compilePath(path, { end: exact, strict, sensitive });
    const match = regexp.exec(pathname);
    if (!match) return null;

    const [url, ...values] = match;
    const isExact = pathname === url;
    if (exact && !isExact) return null;

    return {
      path, // the path used to match
      url: path === "/" && url === "" ? "/" : url, // the matched portion of the URL
      isExact, // whether or not we matched exactly
      params: keys.reduce((memo, key, index) => {
        memo[key.name] = values[index];
        return memo;
      }, {}),
    };
  }, null);
}

export const rootMatch = pathname => ({ path: "/", url: "/", params: {}, isExact: pathname === "/" });

// Like react-router@5's <Switch>: the first route whose path matches
export function matchRoutes(routes, pathname) {
  for (const route of routes) {
    const match = matchPath(pathname, { path: route.path, exact: route.exact });
    if (match) return { route, match };
  }
  return null;
}


const MatchContext = createContext(null);

// Renders children with the given match, like react-router@5's <Route>
export const RouteMatch = ({ match, children }) => <MatchContext.Provider value={match}>{children}</MatchContext.Provider>;

export function useRouter() {
  const location = useLocation();
  const match = useContext(MatchContext) ?? rootMatch(location.pathname);
  return { history, location, match };
}

export function withRouter(Component) {
  const WithRouter = props => <Component {...props} {...useRouter()} />;
  WithRouter.displayName = `withRouter(${Component.displayName || Component.name})`;
  return WithRouter;
}
