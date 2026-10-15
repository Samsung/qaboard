import { Suspense, lazy, useEffect } from "react";
import { unstable_HistoryRouter as HistoryRouter, useLocation } from "react-router";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";

import { Classes } from "@blueprintjs/core";

import * as Sentry from "@sentry/react";
import { StyleSheetManager } from "styled-components";
import isPropValid from "@emotion/is-prop-valid";

import { history, matchRoutes, RouteMatch } from "./router";
import { queryClient, persistOptions, onCacheRestored } from "./api/queryClient";
import { siteConfigQuery } from "./api/queries";
import { ComparisonProvider, useSiteConfig } from "./hooks";
import { initSentry, initPostHog } from "./analytics";
import { Layout } from "./components/layout";
import ProjectsList from "./ProjectsList";
import ErrorPage from "./components/ErrorPage";
import EmptyLoading from "./components/EmptyLoading";

import "normalize.css";
import "@blueprintjs/core/lib/css/blueprint.css";
// include blueprint-icons.css for icon font support
import "@blueprintjs/icons/lib/css/blueprint-icons.css";
import "@blueprintjs/select/lib/css/blueprint-select.css";
import "@blueprintjs/datetime/lib/css/blueprint-datetime.css";

import "./App.css";

import { routes } from './routes'
import { ReleaseNotesProvider, WhatsNewLink } from "./releaseNotes/ReleaseNotes"
import PrivateContent from "./components/authentication/PrivateContent"
import AppSider, { sider_width } from './AppSider'
import AppNavbar from './AppNavbar'

// In development, inspect queries and their cache: https://tanstack.com/query/latest/docs/framework/react/devtools
const ReactQueryDevtools = import.meta.env.DEV
  ? lazy(() => import("@tanstack/react-query-devtools").then(m => ({ default: m.ReactQueryDevtools })))
  : () => null;

// Like styled-components@5: don't forward unknown props to DOM elements
// https://styled-components.com/docs/faqs#shouldforwardprop-is-no-longer-provided-by-default
const shouldForwardProp = (prop, target) => typeof target !== "string" || isPropValid(prop);

const route_name = pathname => matchRoutes(routes, pathname)?.route.path ?? pathname;

const Footer = () => {
  return <div style={{margin: "10px", textAlign: "right"}}>
     <span className={Classes.TEXT_MUTED}><WhatsNewLink via="footer"/> · Made with <span role="img" aria-label="<3">❤️</span> at Samsung, under <a href="https://github.com/Samsung/qaboard">Apache License 2.0</a></span>
  </div>
}


// Monitoring and analytics, once we know the site's configuration
const Analytics = () => {
  const { data: config } = useQuery(siteConfigQuery);
  useEffect(() => {
    if (!config) return;
    initSentry(config, route_name);
    initPostHog(config);
  }, [config]);
  return null;
}

const Fallback = ({ error, componentStack }) => {
  const { support_url } = useSiteConfig();
  return <ErrorPage error={error} info={{ componentStack }} support_url={support_url}/>;
}


const App = ({ persist = true }) => {
  // Tests don't have IndexedDB: they don't persist the cache
  const Provider = persist ? PersistQueryClientProvider : QueryClientProvider;
  const providerProps = persist ? { client: queryClient, persistOptions, onSuccess: onCacheRestored } : { client: queryClient };
  return <Provider {...providerProps}>
    <Sentry.ErrorBoundary fallback={props => <Fallback {...props}/>}>
      <Analytics/>
      <StyleSheetManager shouldForwardProp={shouldForwardProp}>
        <ReleaseNotesProvider>
          <HistoryRouter history={history}>
            <Routes/>
          </HistoryRouter>
        </ReleaseNotesProvider>
      </StyleSheetManager>
    </Sentry.ErrorBoundary>
    <Suspense><ReactQueryDevtools buttonPosition="bottom-left"/></Suspense>
  </Provider>
}


const Routes = () => {
  const { pathname } = useLocation();
  if (pathname === "/")
    return <ProjectsList/>
  return <PrivateContent>
    <ProjectApp pathname={pathname}/>
  </PrivateContent>
}


const ProjectApp = ({ pathname }) => {
  const matched = matchRoutes(routes, pathname);
  if (!matched) return null;
  const { route: { main: Main }, match } = matched;
  return <RouteMatch match={match}>
    <ComparisonProvider>
    <Layout className={Classes.UI_TEXT}>
      <AppSider/>
      <div style={{width: '100%'}}>
        <AppNavbar/>
        <div style={{paddingLeft: sider_width}}>
          <Suspense fallback={<EmptyLoading/>}>
            <Main/>
          </Suspense>
          <Footer/>
        </div>
      </div>
    </Layout>
    </ComparisonProvider>
  </RouteMatch>
}


export default Sentry.withProfiler(App);
